import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSummaryFileSink } from '../src/index.js';
import type { SessionObservationSummary } from '../src/index.js';
import { deepFreeze, snapshotValue } from './helpers.js';
import {
  createV2Host,
  projectLocation,
  sessionCreatedData,
  sessionDeletedData,
  sessionMovedData,
  v2Envelope,
  v2UsageData,
  waitUntil,
} from './v2-host.js';
import type { V2Host } from './v2-host.js';

/**
 * The V2 session lifecycle, end to end through the real plugin.
 *
 * Stage 1H received `session.created`/`session.deleted` with their payload under
 * `data` and could not map either one: the adapter had been fixed to preserve
 * `data`, but the handlers still looked for V1's `properties.info.id`. Stage 1I
 * read the payload shapes out of `@opencode/schema@2.0.24` (`data.sessionID`,
 * `data.projectID`, `data.location`) and maps them here.
 *
 * Every test drives the real plugin definition through the fake-but-faithful V2
 * host: `setup(ctx)`, registration, the actual subscription callback, the real
 * normaliser and dispatcher, session accounting, the real sink, and cleanup.
 * None of them calls an internal observer method or hand-builds the observer
 * state it asserts on.
 */

const PROJECT_A = 'C:\\synthetic\\project-a';
const PROJECT_B = 'C:\\synthetic\\project-b';

/** The summary for a session, failing loudly when nothing was recorded. */
function summaryOf(host: V2Host, sessionId: string): SessionObservationSummary {
  const summary = host.observer.getSummary(sessionId);
  if (summary === undefined) {
    throw new Error(`expected a summary for ${sessionId}`);
  }
  return summary;
}

function toolBefore(
  sessionID: string,
  id: string,
  path = 'C:\\synthetic\\project-a\\notes.txt',
): Record<string, unknown> {
  return {
    tool: 'read',
    sessionID,
    agent: 'build',
    messageID: 'msg_1',
    id,
    input: { filePath: path },
  };
}

function toolAfter(
  sessionID: string,
  id: string,
  path = 'C:\\synthetic\\project-a\\notes.txt',
): Record<string, unknown> {
  return {
    tool: 'read',
    sessionID,
    agent: 'build',
    messageID: 'msg_1',
    id,
    input: { filePath: path },
    status: 'completed',
    result: { title: 'notes.txt', output: 'synthetic result' },
  };
}

describe('V2 session lifecycle through the real plugin', () => {
  it('maps session.created and session.deleted from the verified `data` shapes', async () => {
    const written: SessionObservationSummary[] = [];
    const host = await createV2Host({
      checkpointIntervalMs: 60_000,
      sink: async (summary) => {
        written.push(summary);
      },
    });

    host.push(v2Envelope('session.created', sessionCreatedData()));
    await host.settle();
    expect(summaryOf(host, 'ses_created').lifecycle.createdEvents).toBe(1);

    host.push(v2Envelope('session.deleted', sessionDeletedData()));
    await host.settle();

    // Deletion flushes and then releases: the summary is written, the state gone.
    expect(host.observer.getSessionIds()).toEqual([]);
    expect(written.at(-1)?.sessionId).toBe('ses_created');
    expect(written.at(-1)?.lifecycle.createdEvents).toBe(1);
    expect(host.observer.getSnapshot().sessionsClosed).toBe(1);
    expect(host.observer.getSnapshot().internalErrors).toBe(0);

    await host.close();
  });

  it('persists project attribution as soon as the runtime declares it', async () => {
    const written: SessionObservationSummary[] = [];
    const host = await createV2Host(
      {
        // Far longer than this test lives, so only an arrival-triggered write can
        // explain what reaches the sink.
        checkpointIntervalMs: 60_000,
        sink: async (summary) => {
          written.push(summary);
        },
      },
      { location: projectLocation(PROJECT_A, 'prj_a') },
    );

    host.push(
      v2Envelope(
        'session.created',
        sessionCreatedData({
          sessionID: 'ses_attr',
          projectID: 'prj_a',
          location: { directory: PROJECT_A },
        }),
      ),
    );
    await host.settle();
    await waitUntil(() => written.length > 0);

    // Attribution is rare, high-value and arrives at the very start of a session
    // — precisely when a one-shot host is most likely to be terminated. It is
    // written on arrival instead of waiting for the next checkpoint interval.
    expect(written).toHaveLength(1);
    expect(written[0]?.sessionId).toBe('ses_attr');
    expect(written[0]?.project.verification).toBe('matched');
    expect(written[0]?.project.projectId).toBe('prj_a');

    await host.close();
  });

  it('refuses to resurrect a deleted session on late or duplicate events', async () => {
    const host = await createV2Host({ checkpointIntervalMs: 60_000, sink: async () => undefined });

    host.push(v2Envelope('session.created', sessionCreatedData()));
    await host.settle();
    await host.tool('execute.before', toolBefore('ses_created', 'c1'));
    host.push(v2Envelope('session.deleted', sessionDeletedData()));
    await host.settle();

    expect(host.observer.getSnapshot().lateEventsIgnored).toBe(0);

    // Late events for the finished session, in the same order a straggling
    // server might deliver them.
    await host.tool('execute.before', toolBefore('ses_created', 'c2'));
    await host.tool('execute.after', toolAfter('ses_created', 'c2'));
    host.push(v2Envelope('session.usage.updated', v2UsageData({ sessionID: 'ses_created' })));
    host.push(v2Envelope('session.deleted', sessionDeletedData()));
    await host.settle();

    const snapshot = host.observer.getSnapshot();
    expect(snapshot.sessionCount).toBe(0);
    expect(snapshot.lateEventsIgnored).toBe(4);
    // The duplicate deletion did not run the transition twice.
    expect(snapshot.sessionsClosed).toBe(1);
    expect(snapshot.internalErrors).toBe(0);
    expect(host.observer.getSummary('ses_created')).toBeUndefined();
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain('session-closed');

    await host.close();
  });

  it('handles malformed lifecycle payloads without inventing an identity', async () => {
    const host = await createV2Host();

    // A created event with project facts but no session id.
    host.push(
      v2Envelope('session.created', {
        projectID: 'prj_x',
        location: { directory: 'C:\\synthetic\\x' },
      }),
    );
    // A deleted event whose id is not a string.
    host.push(v2Envelope('session.deleted', { sessionID: 42 }));
    host.push(v2Envelope('session.created', 'not-an-object'));
    host.push(v2Envelope('session.deleted', null));
    await host.settle();

    const snapshot = host.observer.getSnapshot();
    expect(snapshot.sessionCount).toBe(0);
    expect(snapshot.internalErrors).toBe(0);
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain('hook-input-unusable');

    await host.close();
  });

  it('attributes usage that arrives before its create event (out-of-order delivery)', async () => {
    const host = await createV2Host({}, { location: projectLocation(PROJECT_A, 'prj_a') });

    host.push(
      v2Envelope('session.usage.updated', v2UsageData({ sessionID: 'ses_late_create' })),
    );
    await host.settle();
    // Recorded, but explicitly unverified: the runtime has not said where it lives.
    expect(summaryOf(host, 'ses_late_create').project.verification).toBe('unverifiable');

    host.push(
      v2Envelope(
        'session.created',
        sessionCreatedData({
          sessionID: 'ses_late_create',
          projectID: 'prj_a',
          location: { directory: PROJECT_A },
        }),
      ),
    );
    await host.settle();

    const summary = summaryOf(host, 'ses_late_create');
    expect(summary.project.verification).toBe('matched');
    expect(summary.usage.sourceReported?.latest.input).toBe(368);
    expect(host.observer.getSnapshot().sessionsOutOfScope).toBe(0);

    await host.close();
  });

  it('refuses a session that declares a different project, and keeps refusing it', async () => {
    const host = await createV2Host({}, { location: projectLocation(PROJECT_A, 'prj_a') });

    host.push(
      v2Envelope(
        'session.created',
        sessionCreatedData({
          sessionID: 'ses_other',
          projectID: 'prj_b',
          location: { directory: PROJECT_B },
        }),
      ),
    );
    await host.settle();

    expect(host.observer.getSummary('ses_other')).toBeUndefined();
    expect(host.observer.getSnapshot().sessionsOutOfScope).toBe(1);
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain('project-mismatch');

    // Later events for the refused session are ignored, never recorded.
    await host.tool('execute.before', toolBefore('ses_other', 'c1', `${PROJECT_B}\\notes.txt`));
    host.push(v2Envelope('session.usage.updated', v2UsageData({ sessionID: 'ses_other' })));
    await host.settle();

    expect(host.observer.getSummary('ses_other')).toBeUndefined();
    expect(host.observer.getSnapshot().sessionCount).toBe(0);
    expect(host.observer.getSnapshot().internalErrors).toBe(0);

    await host.close();
  });

  it('re-runs the scope gate when a session moves out of the project', async () => {
    const host = await createV2Host({}, { location: projectLocation(PROJECT_A, 'prj_a') });

    host.push(
      v2Envelope(
        'session.created',
        sessionCreatedData({
          sessionID: 'ses_move',
          projectID: 'prj_a',
          location: { directory: PROJECT_A },
        }),
      ),
    );
    await host.settle();
    expect(summaryOf(host, 'ses_move').project.verification).toBe('matched');

    host.push(
      v2Envelope(
        'session.moved',
        sessionMovedData({
          sessionID: 'ses_move',
          projectID: 'prj_b',
          location: { directory: PROJECT_B },
        }),
      ),
    );
    await host.settle();

    expect(host.observer.getSummary('ses_move')).toBeUndefined();
    expect(host.observer.getSnapshot().sessionsOutOfScope).toBe(1);
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain('project-mismatch');

    await host.close();
  });

  it('keeps concurrent sessions separate under interleaved events', async () => {
    const host = await createV2Host();
    const sharedPath = 'C:\\synthetic\\shared\\notes.txt';

    host.push(v2Envelope('session.created', sessionCreatedData({ sessionID: 'ses_a' })));
    host.push(v2Envelope('session.created', sessionCreatedData({ sessionID: 'ses_b' })));
    await host.tool('execute.before', toolBefore('ses_a', 'a1', sharedPath));
    await host.tool('execute.before', toolBefore('ses_b', 'b1', sharedPath));
    await host.tool('execute.after', toolAfter('ses_a', 'a1', sharedPath));
    await host.tool('execute.after', toolAfter('ses_b', 'b1', sharedPath));
    host.push(v2Envelope('session.usage.updated', v2UsageData({ sessionID: 'ses_a' })));
    host.push(
      v2Envelope(
        'session.usage.updated',
        v2UsageData({ sessionID: 'ses_b', cost: 0, tokens: { input: 7 } }),
      ),
    );
    await host.settle();

    const a = summaryOf(host, 'ses_a');
    const b = summaryOf(host, 'ses_b');
    expect(a.counts.toolStartsObserved).toBe(1);
    expect(b.counts.toolStartsObserved).toBe(1);
    expect(a.counts.correlatedCompletions).toBe(1);
    expect(b.counts.correlatedCompletions).toBe(1);
    // The same file read by two sessions is not a repeated read in either one.
    expect(a.reads.repeatedRequests).toBe(0);
    expect(b.reads.repeatedRequests).toBe(0);
    expect(a.usage.sourceReported?.latest.input).toBe(368);
    expect(b.usage.sourceReported?.latest.input).toBe(7);

    // Disposing one session leaves the other exactly as it was.
    host.push(v2Envelope('session.deleted', sessionDeletedData({ sessionID: 'ses_a' })));
    await host.settle();
    expect(host.observer.getSummary('ses_a')).toBeUndefined();

    await host.tool('execute.before', toolBefore('ses_b', 'b2', sharedPath));
    await host.settle();

    const bAfter = summaryOf(host, 'ses_b');
    expect(bAfter.counts.toolStartsObserved).toBe(2);
    // The second read in b is a repeat for b...
    expect(bAfter.reads.repeatedRequests).toBe(1);
    // ...and it never touched a's released state.
    expect(host.observer.getSummary('ses_a')).toBeUndefined();
    expect(host.observer.getSnapshot().sessionsClosed).toBe(1);

    await host.close();
  });

  it('does not mutate the lifecycle payloads it is given', async () => {
    const host = await createV2Host();
    const created = deepFreeze(sessionCreatedData({ sessionID: 'ses_frozen' }));
    const deleted = deepFreeze(sessionDeletedData({ sessionID: 'ses_frozen' }));
    const createdJson = snapshotValue(created);
    const deletedJson = snapshotValue(deleted);

    host.push(v2Envelope('session.created', created));
    host.push(v2Envelope('session.deleted', deleted));
    await host.settle();

    expect(snapshotValue(created)).toBe(createdJson);
    expect(snapshotValue(deleted)).toBe(deletedJson);
    expect(host.observer.getSnapshot().internalErrors).toBe(0);

    await host.close();
  });

  it('persists a complete lifecycle summary through the real file sink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dr-token-v2-life-'));
    const file = join(directory, 'observations.jsonl');
    try {
      const host = await createV2Host(
        { checkpointIntervalMs: 60_000, sink: createSummaryFileSink(file) },
        { location: projectLocation(PROJECT_A, 'prj_a') },
      );

      host.push(
        v2Envelope(
          'session.created',
          sessionCreatedData({
            sessionID: 'ses_file',
            projectID: 'prj_a',
            location: { directory: PROJECT_A },
          }),
        ),
      );
      await host.tool('execute.before', toolBefore('ses_file', 'f1', `${PROJECT_A}\\notes.txt`));
      await host.tool('execute.after', toolAfter('ses_file', 'f1', `${PROJECT_A}\\notes.txt`));
      host.push(v2Envelope('session.usage.updated', v2UsageData({ sessionID: 'ses_file' })));
      host.push(v2Envelope('session.deleted', sessionDeletedData({ sessionID: 'ses_file' })));
      await host.settle();
      await host.close();

      const text = await readFile(file, 'utf8');
      const lines = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as SessionObservationSummary);
      const last = lines.at(-1) as SessionObservationSummary;

      expect(last.sessionId).toBe('ses_file');
      expect(last.lifecycle.createdEvents).toBe(1);
      expect(last.counts.toolStartsObserved).toBe(1);
      expect(last.counts.toolCompletionsObserved).toBe(1);
      expect(last.usage.sourceReported?.latest.input).toBe(368);
      expect(last.project.verification).toBe('matched');
      expect(last.project.projectId).toBe('prj_a');
      expect(last.project.directoryHash).toMatch(/^[0-9a-f]{8}$/);
      // Privacy: the absolute directory never reaches the file, only its hash.
      expect(text).not.toContain('synthetic');
      expect(lines.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes nothing when observation is disabled, even with a summary file configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dr-token-v2-off-'));
    const file = join(directory, 'off.jsonl');
    try {
      const host = await createV2Host({}, { pluginOptions: { enabled: false, summaryFile: file } });

      host.push(v2Envelope('session.created', sessionCreatedData()));
      host.push(v2Envelope('session.usage.updated', v2UsageData()));
      await host.settle();
      await host.close();

      expect(host.observer.getSessionIds()).toEqual([]);
      await expect(readFile(file, 'utf8')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('contains a sink failure and still releases the session on deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dr-token-v2-badsink-'));
    try {
      const host = await createV2Host(
        {},
        // A directory that cannot exist as a file: every write fails.
        { pluginOptions: { summaryFile: join(directory, 'missing', 'observations.jsonl') } },
      );

      host.push(v2Envelope('session.created', sessionCreatedData()));
      await host.settle();
      host.push(v2Envelope('session.deleted', sessionDeletedData()));
      await host.settle();

      const snapshot = host.observer.getSnapshot();
      expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain('sink-failed');
      expect(snapshot.internalErrors).toBe(0);
      expect(snapshot.sessionsClosed).toBe(1);
      expect(host.observer.getSessionIds()).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stops consuming events, flushes, and releases state when the host unloads', async () => {
    const written: SessionObservationSummary[] = [];
    const host = await createV2Host({
      checkpointIntervalMs: 60_000,
      sink: async (summary) => {
        written.push(summary);
      },
    });

    host.push(v2Envelope('session.created', sessionCreatedData()));
    await host.tool('execute.before', toolBefore('ses_created', 'c1'));
    await host.settle();

    await host.close();

    expect(host.aborted()).toBe(true);
    expect(host.observer.getSnapshot().disposed).toBe(true);
    expect(written.at(-1)?.sessionId).toBe('ses_created');
    expect(written.at(-1)?.counts.toolStartsObserved).toBe(1);
    expect(host.observer.getSessionIds()).toEqual([]);

    // Nothing delivered after unload can create state again.
    host.push(v2Envelope('session.usage.updated', v2UsageData({ sessionID: 'ses_after_close' })));
    await host.settle();
    expect(host.observer.getSummary('ses_after_close')).toBeUndefined();
  });

  it('keeps V1 lifecycle and usage behaviour through the same subscription', async () => {
    const written: SessionObservationSummary[] = [];
    const host = await createV2Host({
      checkpointIntervalMs: 60_000,
      sink: async (summary) => {
        written.push(summary);
      },
    });

    // V1 shapes: `properties.info.id` and a per-message usage record.
    host.push({ type: 'session.created', properties: { info: { id: 'ses_v1' } } });
    host.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          sessionID: 'ses_v1',
          role: 'assistant',
          cost: 0.05,
          tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });
    host.push({ type: 'session.deleted', properties: { info: { id: 'ses_v1' } } });
    await host.settle();
    await host.close();

    const last = written.at(-1) as SessionObservationSummary;
    expect(last.sessionId).toBe('ses_v1');
    expect(last.lifecycle.createdEvents).toBe(1);
    expect(last.measurements.inputTokens).toEqual({ evidence: 'calculated', value: 1000 });
    // V1 declares no project facts, so the summary says so instead of guessing.
    expect(last.project.basis).toBe('unavailable');
    expect(last.project.verification).toBe('unverifiable');
    expect(last.project.projectId).toBeUndefined();
    expect(last.project.directoryHash).toBeUndefined();
  });
});
