import { describe, expect, it } from 'vitest';
import {
  OPENCODE_V2_EXECUTION_SUCCEEDED_EVENT_TYPE,
  OPENCODE_V2_USAGE_EVENT_TYPE,
} from '../src/index.js';
import type { SessionObservationSummary } from '../src/index.js';
import { createObservationHarness, deepFreeze, snapshotValue } from './helpers.js';

/**
 * V2 usage events at the observer level.
 *
 * Stage 1G observed OpenCode Desktop 2.0.24 delivering `session.usage.updated`
 * with the payload under `event.data`. The adapter must consume it without
 * assuming what the numbers mean, and without letting V2 data disturb the
 * V1 per-message path.
 */

function usageData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionID: 'ses_v2',
    cost: 0.02,
    tokens: { input: 300, output: 40, reasoning: 10, cache: { read: 2048, write: 0 } },
    ...overrides,
  };
}

function sourceReported(summary: SessionObservationSummary) {
  const block = summary.usage.sourceReported;
  if (block === undefined) {
    throw new Error('expected a sourceReported usage block');
  }
  return block;
}

describe('V2 usage event recognition', () => {
  it('records a V2 session usage snapshot delivered under `data`', async () => {
    const harness = await createObservationHarness();

    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, usageData());

    const summary = harness.summary('ses_v2');
    const block = sourceReported(summary);
    expect(block.events).toBe(1);
    expect(block.usableEvents).toBe(1);
    expect(block.latest).toEqual({
      input: 300,
      output: 40,
      reasoning: 10,
      cacheRead: 2048,
      cacheWrite: 0,
      cost: 0.02,
    });
    expect(block.reportedByField).toEqual({
      input: 1,
      output: 1,
      reasoning: 1,
      cacheRead: 1,
      cacheWrite: 1,
      cost: 1,
    });
  });

  it('declares the aggregation semantics unverified and fabricates no total', async () => {
    const harness = await createObservationHarness();

    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, usageData());
    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, usageData({ tokens: { input: 900, output: 40 } }));

    const summary = harness.summary('ses_v2');
    const block = sourceReported(summary);
    expect(block.aggregation).toBe('unverified');

    // The latest snapshot is what the source last said — never a sum.
    expect(block.latest.input).toBe(900);
    expect(block.latest.input).not.toBe(1200);

    // And no session aggregate is derived from snapshots.
    expect(summary.measurements.inputTokens).toMatchObject({ evidence: 'unavailable' });
    expect(summary.measurements.outputTokens).toMatchObject({ evidence: 'unavailable' });
    expect(summary.measurements.totalTokens).toMatchObject({ evidence: 'unavailable' });
    expect(summary.measurements.totalTokens).not.toHaveProperty('value');
  });

  it('keeps V1 per-message aggregation exactly as before', async () => {
    const harness = await createObservationHarness();

    await harness.event('message.updated', {
      info: {
        id: 'msg_1',
        sessionID: 'ses_v1',
        role: 'assistant',
        cost: 0.05,
        tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });

    const summary = harness.summary('ses_v1');
    // Per-message records remain the only source of a session aggregate, and the
    // aggregate is still classified as calculated.
    expect(summary.measurements.inputTokens).toEqual({ evidence: 'calculated', value: 1000 });
    expect(summary.usage.sourceReported).toBeUndefined();
    expect(summary.usage.messagesWithUsage).toBe(1);
  });

  it('does not mix V1 and V2 usage sources in one session', async () => {
    const harness = await createObservationHarness();

    await harness.event('message.updated', {
      info: {
        id: 'msg_1',
        sessionID: 'ses_mixed',
        role: 'assistant',
        cost: 0.05,
        tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, usageData({ sessionID: 'ses_mixed' }));

    const summary = harness.summary('ses_mixed');
    // The message aggregate stands on its own; the snapshot is reported beside it.
    expect(summary.measurements.inputTokens).toEqual({ evidence: 'calculated', value: 1000 });
    expect(sourceReported(summary).latest.input).toBe(300);
    expect(summary.usage.messagesWithUsage).toBe(1);
  });
});

describe('V2 usage session association', () => {
  it('attributes a snapshot to the session in its payload', async () => {
    const harness = await createObservationHarness();

    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, usageData({ sessionID: 'ses_a' }));
    await harness.v2Event(
      OPENCODE_V2_USAGE_EVENT_TYPE,
      usageData({ sessionID: 'ses_b', tokens: { input: 7 }, cost: 0 }),
    );

    expect(sourceReported(harness.summary('ses_a')).latest.input).toBe(300);
    expect(sourceReported(harness.summary('ses_b')).latest.input).toBe(7);
    expect(sourceReported(harness.summary('ses_a')).events).toBe(1);
    expect(harness.observer.getSessionIds()).toEqual(['ses_a', 'ses_b']);
  });

  it('counts duplicate events without double counting a value', async () => {
    const harness = await createObservationHarness();
    const same = usageData();

    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, same);
    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, same);

    const block = sourceReported(harness.summary('ses_v2'));
    expect(block.events).toBe(2);
    expect(block.usableEvents).toBe(2);
    expect(block.latest.input).toBe(300);
    expect(block.latest.input).not.toBe(600);
    // Repeating the same numbers is not evidence against cumulative semantics.
    expect(block.monotonicNonDecreasing).toBe(true);
    expect(block.decreasesObserved).toBe(0);
  });

  it('records a decrease as evidence and keeps the newest snapshot', async () => {
    const harness = await createObservationHarness();

    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, usageData({ tokens: { input: 500, output: 10 } }));
    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, usageData({ tokens: { input: 20, output: 10 } }));

    const block = sourceReported(harness.summary('ses_v2'));
    expect(block.latest.input).toBe(20);
    expect(block.decreasesObserved).toBe(1);
    expect(block.monotonicNonDecreasing).toBe(false);
    expect(harness.diagnostics.map((d) => d.code)).toContain('usage-update-regression');
  });

  it('counts a sessionID-only event as unusable rather than inventing fields', async () => {
    const harness = await createObservationHarness();

    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, { sessionID: 'ses_v2' });

    const block = sourceReported(harness.summary('ses_v2'));
    expect(block.events).toBe(1);
    expect(block.usableEvents).toBe(0);
    expect(block.latestObservedAt).toBe('never');
    expect(block.latest.input).toBeUndefined();
    expect(block.aggregation).toBe('unverified');
  });
});

describe('V2 usage failure containment and hygiene', () => {
  it('ignores a malformed event without failing the hook', async () => {
    const harness = await createObservationHarness();

    await expect(harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, null)).resolves.toBeUndefined();
    await expect(harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, 'nope')).resolves.toBeUndefined();
    await expect(
      harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, { tokens: { input: 1 } }),
    ).resolves.toBeUndefined();

    expect(harness.observer.getSnapshot().internalErrors).toBe(0);
    expect(harness.observer.getSnapshot().eventsIgnored).toBeGreaterThanOrEqual(3);
  });

  it('contains a payload whose accessor throws', async () => {
    const harness = await createObservationHarness();
    const hostile = {
      sessionID: 'ses_v2',
      get cost(): number {
        throw new Error('boom');
      },
      tokens: { input: 5 },
    };

    await expect(harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, hostile)).resolves.toBeUndefined();

    // The failure is contained and visible; the host would never see it.
    expect(harness.observer.getSnapshot().internalErrors).toBe(1);
    expect(harness.diagnostics.map((d) => d.code)).toContain('internal-failure');
  });

  it('does not mutate the event object it was given', async () => {
    const harness = await createObservationHarness();
    const data = deepFreeze(usageData());
    const before = snapshotValue(data);

    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, data);

    expect(snapshotValue(data)).toBe(before);
  });

  it('still flushes on the V2 execution-completed event without counting it as idle', async () => {
    const written: SessionObservationSummary[] = [];
    const harness = await createObservationHarness({
      sink: (summary) => {
        written.push(summary);
      },
    });

    await harness.v2Event(OPENCODE_V2_USAGE_EVENT_TYPE, usageData());
    await harness.v2Event(OPENCODE_V2_EXECUTION_SUCCEEDED_EVENT_TYPE, { sessionID: 'ses_v2' });

    const summary = harness.summary('ses_v2');
    expect(summary.lifecycle.idleEvents).toBe(0);
    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(written.at(-1)?.sessionId).toBe('ses_v2');
  });
});
