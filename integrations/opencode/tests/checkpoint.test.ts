import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSummaryFileSink, isUsableSummaryPath } from '../src/index.js';
import type { SessionObservationSummary } from '../src/index.js';
import { createObservationHarness } from './helpers.js';

/**
 * One-shot persistence.
 *
 * Stage 1G found that a one-shot `run` session can be terminated before the
 * observer's cleanup path runs, so a summary configured through `summaryFile`
 * never reached disk. The observer therefore also checkpoints changed sessions
 * while it observes — but only when a sink is configured, and at a bounded rate.
 */

const FAST = 15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The most recent summary a sink received, failing loudly when there is none. */
function latest(written: readonly SessionObservationSummary[]): SessionObservationSummary {
  const value = written[written.length - 1];
  if (value === undefined) {
    throw new Error('expected at least one summary write');
  }
  return value;
}

/**
 * A minimal, structurally complete summary.
 *
 * The sink tests exercise file behaviour, not observation, so the payload only
 * has to be a real `SessionObservationSummary` shape carrying one identity.
 */
function summaryWith(sessionId: string): SessionObservationSummary {
  return { schemaVersion: 1, sessionId } as unknown as SessionObservationSummary;
}

/** A sink that records every summary it receives, optionally failing. */
function recordingSink(options: { readonly fail?: boolean } = {}) {
  const written: SessionObservationSummary[] = [];
  const sink = async (summary: SessionObservationSummary): Promise<void> => {
    if (options.fail === true) {
      throw new Error('disk full');
    }
    written.push(summary);
  };
  return { written, sink };
}

describe('checkpoint persistence', () => {
  it('writes a summary during observation, without dispose or a lifecycle event', async () => {
    const { written, sink } = recordingSink();
    const harness = await createObservationHarness({ sink, checkpointIntervalMs: FAST });

    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await sleep(FAST * 4);

    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(latest(written).counts.toolStartsObserved).toBe(1);
    // Nothing was disposed: this is the one-shot case Stage 1G lost.
    expect(harness.observer.getSnapshot().disposed).toBe(false);
  });

  it('writes again when the session changes, with the newest summary last', async () => {
    const { written, sink } = recordingSink();
    const harness = await createObservationHarness({ sink, checkpointIntervalMs: FAST });

    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await sleep(FAST * 4);
    const firstCount = written.length;

    await harness.before('ses_1', 'read', 'c2', { filePath: '/repo/a.ts' });
    await sleep(FAST * 4);

    expect(written.length).toBeGreaterThan(firstCount);
    expect(latest(written).counts.toolStartsObserved).toBe(2);
    expect(latest(written).reads.repeatedRequests).toBe(1);
  });

  it('does not write when nothing changed', async () => {
    const { written, sink } = recordingSink();
    await createObservationHarness({ sink, checkpointIntervalMs: FAST });

    await sleep(FAST * 6);

    expect(written).toEqual([]);
  });

  it('writes nothing at all when no sink is configured', async () => {
    const harness = await createObservationHarness({ checkpointIntervalMs: FAST });

    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await sleep(FAST * 4);

    // No sink means no write path exists, which is the default.
    expect(harness.observer.getSnapshot().sessions.length).toBe(1);
  });

  it('honours an explicit checkpoint disable while keeping the dispose flush', async () => {
    const { written, sink } = recordingSink();
    const harness = await createObservationHarness({ sink, checkpointIntervalMs: 0 });

    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await sleep(FAST * 6);
    expect(written).toEqual([]);

    await harness.hooks.dispose();
    expect(written.length).toBe(1);
    expect(latest(written).counts.toolStartsObserved).toBe(1);
  });

  it('stops writing once disposed', async () => {
    const { written, sink } = recordingSink();
    const harness = await createObservationHarness({ sink, checkpointIntervalMs: FAST });

    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await sleep(FAST * 4);
    const atDispose = written.length;

    await harness.hooks.dispose();
    await sleep(FAST * 6);

    // The timer is cleared, so nothing is written after disposal.
    expect(written.length).toBeLessThanOrEqual(atDispose + 1);
  });

  it('contains a failing sink without breaking observation', async () => {
    const { sink } = recordingSink({ fail: true });
    const harness = await createObservationHarness({ sink, checkpointIntervalMs: FAST });

    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await sleep(FAST * 5);
    await harness.after('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });

    const snapshot = harness.observer.getSnapshot();
    expect(snapshot.internalErrors).toBe(0);
    expect(harness.diagnostics.map((d) => d.code)).toContain('sink-failed');
    // Observation continued even though every write failed.
    const session = snapshot.sessions[0];
    expect(session?.counts.toolStartsObserved).toBe(1);
    expect(session?.counts.toolCompletionsObserved).toBe(1);
  });

  it('serializes writes so the last line is always the newest summary', async () => {
    const written: number[] = [];
    let inFlight = 0;
    const harness = await createObservationHarness({
      checkpointIntervalMs: FAST,
      sink: async (summary) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        await sleep(5);
        written.push(summary.counts.toolStartsObserved);
        inFlight -= 1;
      },
    });

    for (const id of ['c1', 'c2', 'c3']) {
      await harness.before('ses_1', 'read', id, { filePath: '/repo/a.ts' });
      await sleep(FAST * 2);
    }
    await sleep(FAST * 4);

    expect(written.length).toBeGreaterThanOrEqual(2);
    // Counts only ever move forward: no stale summary can land after a newer one.
    expect(written).toEqual([...written].sort((a, b) => a - b));
  });

  it('keeps retained state bounded by the configured limits', async () => {
    const { written, sink } = recordingSink();
    const harness = await createObservationHarness({
      sink,
      checkpointIntervalMs: FAST,
      limits: { maxSessions: 2, maxDiagnostics: 4 },
    });

    for (const id of ['s1', 's2', 's3']) {
      await harness.before(id, 'read', `${id}-c1`, { filePath: '/repo/a.ts' });
    }
    await sleep(FAST * 4);

    expect(harness.observer.getSnapshot().sessionCount).toBe(2);
    expect(harness.observer.getSnapshot().recentDiagnostics.length).toBeLessThanOrEqual(4);
    expect(written.length).toBeGreaterThanOrEqual(1);
  });
});

describe('summary file sink', () => {
  it('appends complete JSON Lines, one per write, to the configured path only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dr-token-sink-'));
    const file = join(directory, 'observations.jsonl');
    try {
      const sink = createSummaryFileSink(file);
      const harness = await createObservationHarness({ sink, checkpointIntervalMs: FAST });

      await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
      await sleep(FAST * 4);
      await harness.before('ses_1', 'read', 'c2', { filePath: '/repo/a.ts' });
      await sleep(FAST * 4);

      const lines = (await readFile(file, 'utf8')).trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        const parsed = JSON.parse(line) as SessionObservationSummary;
        expect(parsed.sessionId).toBe('ses_1');
        expect(parsed.schemaVersion).toBe(1);
      }
      // The final line carries the newest state, so last-wins is safe for consumers.
      const last = JSON.parse(String(lines[lines.length - 1])) as SessionObservationSummary;
      expect(last.reads.repeatedRequests).toBe(1);
      expect(last.measurements.repeatedFileReads.evidence).toBe('calculated');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never writes to a path that was not configured', async () => {
    expect(isUsableSummaryPath('   ')).toBe(false);
    expect(isUsableSummaryPath(42)).toBe(false);
    expect(isUsableSummaryPath(undefined)).toBe(false);
  });

  it('creates the file on first write and appends rather than replacing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dr-token-sink-new-'));
    const file = join(directory, 'nested-observations.jsonl');
    try {
      const sink = createSummaryFileSink(file);
      await sink(summaryWith('ses_first'));
      await sink(summaryWith('ses_second'));

      const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(2);
      expect((JSON.parse(lines[0] ?? '{}') as SessionObservationSummary).sessionId).toBe(
        'ses_first',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('closes a record an interrupted write left torn, without damaging the next one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dr-token-sink-torn-'));
    const file = join(directory, 'observations.jsonl');
    try {
      // An earlier process was killed mid-record: the file ends without a newline.
      await writeFile(file, '{"schemaVersion":1,"sessionId":"ses_torn"', 'utf8');

      const sink = createSummaryFileSink(file);
      await sink(summaryWith('ses_after'));

      const lines = (await readFile(file, 'utf8')).split('\n');
      // The fragment is isolated on its own line, so the intact record parses.
      expect(lines[0]).toBe('{"schemaVersion":1,"sessionId":"ses_torn"');
      const parsed = JSON.parse(String(lines[1])) as SessionObservationSummary;
      expect(parsed.sessionId).toBe('ses_after');
      expect(lines[2]).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a write failure to the observer and keeps observing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dr-token-sink-bad-'));
    try {
      // A directory that cannot exist as a file: the write must fail, loudly for
      // the observer and invisibly for OpenCode.
      const sink = createSummaryFileSink(join(directory, 'missing', 'observations.jsonl'));
      const harness = await createObservationHarness({ sink, checkpointIntervalMs: FAST });

      await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
      await sleep(FAST * 5);

      expect(harness.diagnostics.map((d) => d.code)).toContain('sink-failed');
      expect(harness.observer.getSnapshot().internalErrors).toBe(0);
      expect(harness.observer.getSummary('ses_1')?.counts.toolStartsObserved).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('leaves a well-terminated file untouched when it appends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dr-token-sink-clean-'));
    const file = join(directory, 'observations.jsonl');
    try {
      await writeFile(file, '{"sessionId":"ses_previous"}\n', 'utf8');

      const sink = createSummaryFileSink(file);
      await sink(summaryWith('ses_next'));

      const text = await readFile(file, 'utf8');
      // No blank separator line is inserted when nothing was torn.
      expect(text).not.toContain('\n\n');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.split('\n').filter((line) => line !== '')).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
