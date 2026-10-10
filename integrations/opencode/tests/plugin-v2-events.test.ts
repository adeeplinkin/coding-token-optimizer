import { describe, expect, it } from 'vitest';
import {
  OPENCODE_V2_EXECUTION_SUCCEEDED_EVENT_TYPE,
  OPENCODE_V2_USAGE_EVENT_TYPE,
  asRuntimeEvent,
  createOpenCodeObserverV2,
} from '../src/index.js';
import type { ObserverDiagnostic, SessionObservationSummary } from '../src/index.js';
import { deepFreeze, snapshotValue } from './helpers.js';
import { createV2Host } from './v2-host.js';

/**
 * The V2 adapter seen from the **host** side.
 *
 * Stage 1H's live run showed that every event in a real V2 session reached the
 * observer with an empty payload: `asRuntimeEvent` normalised `type` and
 * `properties` but dropped `data`, which is where V2 actually puts an event body.
 * The observer handled `session.usage.updated` correctly all along — it simply
 * never received the payload.
 *
 * Neither the Stage 1G tests nor the Stage 1G live harness could have caught
 * that: both handed events to the observer's V1-shaped hook and skipped the
 * normaliser. These tests drive the real plugin through a V2 host instead.
 */

/** A runtime-shaped V2 envelope, exactly as the 2.0.24 server delivers it. */
function v2Envelope(type: string, data: unknown): Record<string, unknown> {
  return { id: 'evt_1', created: 1_700_000_000_000, type, data };
}

function usageData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionID: 'ses_host',
    cost: 0.02,
    tokens: { input: 368, output: 75, reasoning: 91, cache: { read: 10496, write: 0 } },
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

describe('asRuntimeEvent', () => {
  it('preserves the payload V2 delivers under `data`', () => {
    const event = asRuntimeEvent(v2Envelope('session.usage.updated', { sessionID: 'ses_1' }));

    expect(event.type).toBe('session.usage.updated');
    // The regression: dropping `data` blinded every V2 event handler.
    expect(event.data).toEqual({ sessionID: 'ses_1' });
  });

  it('still carries a V1-style payload under `properties`', () => {
    const event = asRuntimeEvent({ type: 'message.updated', properties: { info: { id: 'm' } } });

    expect(event.properties).toEqual({ info: { id: 'm' } });
  });

  it('keeps both when a host sends both, so precedence can be decided downstream', () => {
    const event = asRuntimeEvent({
      type: 'session.usage.updated',
      properties: { sessionID: 'from-properties' },
      data: { sessionID: 'from-data' },
    });

    expect(event.properties).toEqual({ sessionID: 'from-properties' });
    expect(event.data).toEqual({ sessionID: 'from-data' });
  });

  it('never fabricates a payload for a non-object event', () => {
    expect(asRuntimeEvent(undefined)).toEqual({});
    expect(asRuntimeEvent(null)).toEqual({});
    expect(asRuntimeEvent('nope')).toEqual({});
    expect(asRuntimeEvent(7)).toEqual({});
  });

  it('omits an absent type rather than setting it to undefined', () => {
    expect(Object.hasOwn(asRuntimeEvent({ data: 1 }), 'type')).toBe(false);
  });
});

describe('V2 events through the real plugin', () => {
  it('records a session usage event whose payload is under `data`', async () => {
    const host = await createV2Host();

    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, usageData()));
    await host.settle();

    const summary = host.observer.getSummary('ses_host');
    expect(summary).toBeDefined();
    const block = sourceReported(summary as SessionObservationSummary);
    expect(block.events).toBe(1);
    expect(block.usableEvents).toBe(1);
    expect(block.latest).toEqual({
      input: 368,
      output: 75,
      reasoning: 91,
      cacheRead: 10496,
      cacheWrite: 0,
      cost: 0.02,
    });
    // No aggregate is derived from a snapshot, whatever its values.
    expect(summary?.measurements.inputTokens).toMatchObject({ evidence: 'unavailable' });

    await host.close();
  });

  it('records a lifecycle event whose payload is under `data`', async () => {
    const host = await createV2Host();

    host.push(v2Envelope('session.created', { info: { id: 'ses_life' } }));
    host.push(v2Envelope('session.updated', { info: { id: 'ses_life' } }));
    await host.settle();

    const summary = host.observer.getSummary('ses_life');
    expect(summary?.lifecycle.createdEvents).toBe(1);

    await host.close();
  });

  it('attributes each snapshot to the session id in its own payload', async () => {
    const host = await createV2Host();

    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, usageData({ sessionID: 'ses_a' })));
    host.push(
      v2Envelope(
        OPENCODE_V2_USAGE_EVENT_TYPE,
        usageData({ sessionID: 'ses_b', tokens: { input: 7 }, cost: 0 }),
      ),
    );
    await host.settle();

    const a = host.observer.getSummary('ses_a') as SessionObservationSummary;
    const b = host.observer.getSummary('ses_b') as SessionObservationSummary;
    expect(sourceReported(a).latest.input).toBe(368);
    expect(sourceReported(b).latest.input).toBe(7);
    expect(sourceReported(a).events).toBe(1);
    expect(sourceReported(b).events).toBe(1);

    await host.close();
  });

  it('keeps the V1 per-message path working through the same subscription', async () => {
    const host = await createV2Host();

    // A host that still emits V1-shaped events must aggregate exactly as before.
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
    await host.settle();

    const summary = host.observer.getSummary('ses_v1') as SessionObservationSummary;
    expect(summary.measurements.inputTokens).toEqual({ evidence: 'calculated', value: 1000 });
    expect(summary.usage.sourceReported).toBeUndefined();

    await host.close();
  });

  it('ignores an unknown event type without recording anything', async () => {
    const host = await createV2Host();

    host.push(v2Envelope('some.unknown.event', { anything: true }));
    await host.settle();

    expect(host.observer.getSnapshot().eventsIgnored).toBe(1);
    expect(host.observer.getSnapshot().sessionCount).toBe(0);
    expect(host.observer.getSnapshot().internalErrors).toBe(0);

    await host.close();
  });

  it('contains a hostile payload without disturbing the host', async () => {
    const host = await createV2Host();
    const hostile = {
      sessionID: 'ses_host',
      get tokens(): unknown {
        throw new Error('boom');
      },
    };

    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, hostile));
    await host.settle();

    expect(host.observer.getSnapshot().internalErrors).toBe(1);
    // The subscription survived the failure and kept working.
    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, usageData()));
    await host.settle();
    expect(
      sourceReported(host.observer.getSummary('ses_host') as SessionObservationSummary).usableEvents,
    ).toBe(1);

    await host.close();
  });

  it('registers only the two observation-only tool hooks', async () => {
    const host = await createV2Host();

    expect([...host.registeredHooks()].sort()).toEqual(['execute.after', 'execute.before']);

    await host.close();
  });

  it('observes tool execution without mutating the event it was given', async () => {
    const host = await createV2Host();
    const before = deepFreeze({
      tool: 'read',
      sessionID: 'ses_tool',
      agent: 'build',
      messageID: 'msg_1',
      id: 'call_1',
      input: { path: '/repo/a.ts', offset: 1, limit: 10 },
    });
    const after = deepFreeze({
      tool: 'read',
      sessionID: 'ses_tool',
      messageID: 'msg_1',
      id: 'call_1',
      input: { path: '/repo/a.ts', offset: 1, limit: 10 },
      status: 'completed',
      result: { title: 'a.ts', output: 'file contents' },
    });
    const beforeJson = snapshotValue(before);
    const afterJson = snapshotValue(after);

    await host.tool('execute.before', before);
    await host.tool('execute.after', after);

    expect(snapshotValue(before)).toBe(beforeJson);
    expect(snapshotValue(after)).toBe(afterJson);

    const summary = host.observer.getSummary('ses_tool') as SessionObservationSummary;
    expect(summary.counts.toolStartsObserved).toBe(1);
    expect(summary.counts.toolCompletionsObserved).toBe(1);
    expect(summary.counts.correlatedCompletions).toBe(1);
    // The path is identified, not retained: only its identity is recorded.
    expect(summary.reads.identifiedRequests).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('/repo/a.ts');
    expect(JSON.stringify(summary)).not.toContain('file contents');

    await host.close();
  });

  it('stops consuming events, flushes, and releases state when the host aborts', async () => {
    const written: SessionObservationSummary[] = [];
    const host = await createV2Host({
      checkpointIntervalMs: 60_000,
      sink: (summary) => {
        written.push(summary);
      },
    });

    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, usageData()));
    await host.settle();
    expect(host.observer.getSummary('ses_host')).toBeDefined();

    await host.close();

    expect(host.aborted()).toBe(true);
    expect(host.observer.getSnapshot().disposed).toBe(true);
    // Unload flushes what was observed...
    expect(written.at(-1)?.sessionId).toBe('ses_host');
    // ...and then releases the retained state, which stays bounded.
    expect(host.observer.getSessionIds()).toEqual([]);
  });

  it('reports a missing capability instead of failing to load', async () => {
    const diagnostics: ObserverDiagnostic[] = [];
    const created = createOpenCodeObserverV2({
      env: {},
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    // A host that exposes neither capability: the adapter must still load.
    const cleanup = await created.plugin.setup({});

    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('unsupported-plugin-capability');
    expect(created.observer.getSnapshot().internalErrors).toBe(0);
    await cleanup?.();
  });
});

describe('one-shot persistence through the real plugin', () => {
  it('writes a summary as soon as a usage snapshot arrives, without waiting for the interval', async () => {
    const written: SessionObservationSummary[] = [];
    const host = await createV2Host({
      // Long enough that only an immediate flush can explain a write.
      checkpointIntervalMs: 60_000,
      sink: (summary) => {
        written.push(summary);
      },
    });

    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, usageData()));
    await host.settle();

    expect(written.length).toBeGreaterThanOrEqual(1);
    const last = written.at(-1) as SessionObservationSummary;
    expect(last.sessionId).toBe('ses_host');
    expect(last.usage.sourceReported?.latest.input).toBe(368);
    // Nothing was disposed: this is the one-shot case Stage 1G lost.
    expect(host.observer.getSnapshot().disposed).toBe(false);

    await host.close();
  });

  it('keeps the summary on disk current as a session reports more', async () => {
    const written: SessionObservationSummary[] = [];
    const host = await createV2Host({
      checkpointIntervalMs: 60_000,
      sink: (summary) => {
        written.push(summary);
      },
    });

    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, usageData()));
    await host.settle();
    host.push(
      v2Envelope(
        OPENCODE_V2_USAGE_EVENT_TYPE,
        usageData({ tokens: { input: 900, output: 120 } }),
      ),
    );
    await host.settle();

    const values = written.map((summary) => summary.usage.sourceReported?.latest.input);
    // Both observations are on disk, newest last, and never summed.
    expect(values.at(-1)).toBe(900);
    expect(values.length).toBeGreaterThanOrEqual(2);

    await host.close();
  });

  it('still writes a usage snapshot when the periodic checkpoint is disabled', async () => {
    const written: SessionObservationSummary[] = [];
    const host = await createV2Host({
      // `0` disables the periodic timer, not persistence: a usage snapshot is
      // written when it arrives, which is what keeps a one-shot run from losing
      // the only numbers it collected.
      checkpointIntervalMs: 0,
      sink: (summary) => {
        written.push(summary);
      },
    });

    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, usageData()));
    await host.settle();

    expect(written.at(-1)?.usage.sourceReported?.latest.input).toBe(368);

    await host.close();
  });

  it('writes nothing when persistence is not configured', async () => {
    const host = await createV2Host({ checkpointIntervalMs: 60_000 });

    host.push(v2Envelope(OPENCODE_V2_USAGE_EVENT_TYPE, usageData()));
    host.push(v2Envelope(OPENCODE_V2_EXECUTION_SUCCEEDED_EVENT_TYPE, { sessionID: 'ses_host' }));
    await host.settle();

    // No sink exists, so no write path exists — the default.
    expect(host.observer.getSummary('ses_host')).toBeDefined();

    await host.close();
  });
});
