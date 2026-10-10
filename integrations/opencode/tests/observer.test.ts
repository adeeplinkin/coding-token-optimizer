import { describe, expect, it } from 'vitest';
import { createOpenCodeObserver, defaultHash, isDisabledByEnvironment } from '../src/index.js';
import type { ObserverDiagnostic, SessionObservationSummary } from '../src/index.js';
import {
  createObservationHarness,
  deepFreeze,
  expectNoSecrets,
  fnv1aHex,
  snapshotValue,
} from './helpers.js';

const SECRET_PATH = '/home/dev/private/production-credentials.env';
const SECRET_TEXT = 'SUPER-SECRET-TOKEN-9f8e7d6c';
const SECRET_DIRECTORY = 'C:/Users/secret-owner/projects/private-repo';
const SECRETS = [SECRET_PATH, SECRET_TEXT, SECRET_DIRECTORY, 'production-credentials'];

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_1',
    sessionID: 'ses_1',
    role: 'assistant',
    cost: 0.05,
    tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function read(session: string, callID: string, args: unknown): [string, string, string, unknown] {
  return [session, 'read', callID, args];
}

describe('1. plugin initialization', () => {
  it('registers only the documented observation hooks', async () => {
    const harness = await createObservationHarness();

    expect(Object.keys(harness.hooks).sort()).toEqual([
      'dispose',
      'event',
      'tool.execute.after',
      'tool.execute.before',
    ]);
    expect(Object.keys(harness.hooks).some((name) => name.startsWith('experimental'))).toBe(false);
  });

  it('starts enabled, empty and undisposed', async () => {
    const harness = await createObservationHarness();
    const snapshot = harness.observer.getSnapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.disposed).toBe(false);
    expect(snapshot.sessionCount).toBe(0);
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.internalErrors).toBe(0);
    expect(snapshot.adapter.name).toBe('@dr-token/opencode-observer');
    expect(snapshot.adapter.pluginApi).toEqual({
      package: '@opencode-ai/plugin',
      verifiedVersion: '1.18.35',
      line: 'v1',
    });
  });

  it('records a decision-free adapter identity in every summary', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));

    const summary = harness.summary('ses_1');
    expect(summary.schemaVersion).toBe(1);
    expect(summary.adapter.name).toBe('@dr-token/opencode-observer');
    expect(summary.adapter.revision).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('2. tool execution observation', () => {
  it('counts a completed tool call once', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');
    await harness.after('ses_1', 'bash', 'c1');

    const summary = harness.summary('ses_1');
    expect(summary.counts.toolStartsObserved).toBe(1);
    expect(summary.counts.toolCompletionsObserved).toBe(1);
    expect(summary.counts.pendingCalls).toBe(0);
  });

  it('counts a started-but-unfinished call as pending, not completed', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'grep', 'c1');

    const summary = harness.summary('ses_1');
    expect(summary.counts.pendingCalls).toBe(1);
    expect(summary.counts.toolCompletionsObserved).toBe(0);
  });

  it('counts a completion with no recorded start', async () => {
    const harness = await createObservationHarness();
    await harness.after('ses_1', 'read', 'c9', { filePath: '/repo/a.ts' });

    const summary = harness.summary('ses_1');
    expect(summary.counts.uncorrelatedCompletions).toBe(1);
    expect(summary.counts.correlatedCompletions).toBe(0);
    expect(summary.counts.toolCompletionsObserved).toBe(1);
  });

  it('does not count a non-read tool as a read request', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1', { command: 'ls' });
    await harness.after('ses_1', 'bash', 'c1', { command: 'ls' });

    expect(harness.summary('ses_1').reads.requests).toBe(0);
  });

  it('never records tool arguments or tool output in a summary', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1', { command: `echo ${SECRET_TEXT}` });
    await harness.after('ses_1', 'bash', 'c1', { command: `echo ${SECRET_TEXT}` }, {
      title: 'bash',
      output: SECRET_TEXT,
      metadata: { nested: SECRET_TEXT },
    });

    expectNoSecrets(harness.observer.serializeSummary('ses_1') ?? '', SECRETS);
  });
});

describe('3. before/after event correlation', () => {
  it('correlates a completion with its recorded start', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'edit', 'call-42');
    await harness.after('ses_1', 'edit', 'call-42');

    const counts = harness.summary('ses_1').counts;
    expect(counts.correlatedCompletions).toBe(1);
    expect(counts.uncorrelatedCompletions).toBe(0);
  });

  it('keeps the started tool id when a later hook disagrees', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'edit', 'c1');
    await harness.after('ses_1', 'write', 'c1');

    const frequency = harness.summary('ses_1').toolFrequency;
    expect(frequency).toEqual([{ tool: 'edit', started: 1, completed: 1 }]);
  });

  it('removes a completed call from the pending set', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await harness.after('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });

    expect(harness.summary('ses_1').counts.pendingCalls).toBe(0);
  });
});

describe('4. tool-call frequency', () => {
  it('tracks frequency per tool id, sorted deterministically', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await harness.after('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await harness.before('ses_1', 'bash', 'c2');
    await harness.after('ses_1', 'bash', 'c2');
    await harness.before('ses_1', 'bash', 'c3');

    const summary = harness.summary('ses_1');
    expect(summary.toolFrequency).toEqual([
      { tool: 'bash', started: 2, completed: 1 },
      { tool: 'read', started: 1, completed: 1 },
    ]);
    expect(summary.counts.toolStartsObserved).toBe(3);
    expect(summary.counts.toolCompletionsObserved).toBe(2);
  });
});

describe('5. repeated identical reads', () => {
  it('counts repeated reads of the same file and range', async () => {
    const harness = await createObservationHarness();
    for (const callID of ['c1', 'c2', 'c3']) {
      await harness.before(...read('ses_1', callID, { filePath: '/repo/src/main.ts' }));
      await harness.after('ses_1', 'read', callID, { filePath: '/repo/src/main.ts' });
    }

    const summary = harness.summary('ses_1');
    expect(summary.reads.requests).toBe(3);
    expect(summary.reads.distinctTargets).toBe(1);
    expect(summary.reads.repeatedTargets).toBe(1);
    expect(summary.reads.repeatedRequests).toBe(2);
    expect(summary.reads.identifiedRequests).toBe(3);
    expect(summary.reads.unidentifiedRequests).toBe(0);
  });

  it('does not treat two reads of different files as identical', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/b.ts' }));

    const reads = harness.summary('ses_1').reads;
    expect(reads.distinctTargets).toBe(2);
    expect(reads.repeatedRequests).toBe(0);
  });

  it('counts a read only once when both hooks fire for the same call', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    await harness.after('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });

    expect(harness.summary('ses_1').reads.requests).toBe(1);
  });

  it('still observes a read completion that had no recorded start', async () => {
    const harness = await createObservationHarness();
    await harness.after('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await harness.after('ses_1', 'read', 'c2', { filePath: '/repo/a.ts' });

    const reads = harness.summary('ses_1').reads;
    expect(reads.requests).toBe(2);
    expect(reads.repeatedRequests).toBe(1);
  });

  it('states the identity scheme and claims no saving', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));

    const reads = harness.summary('ses_1').reads;
    expect(reads.identityScheme).toContain('offset');
    expect(reads.identityScheme.toLowerCase()).not.toContain('saved');
  });
});

describe('6. different file ranges', () => {
  it('keeps reads of the same file at different offsets distinct', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts', offset: 1, limit: 100 }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts', offset: 200, limit: 100 }));

    const reads = harness.summary('ses_1').reads;
    expect(reads.distinctTargets).toBe(2);
    expect(reads.repeatedRequests).toBe(0);
  });

  it('keeps reads of the same file at different limits distinct', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts', limit: 10 }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts', limit: 20 }));

    expect(harness.summary('ses_1').reads.distinctTargets).toBe(2);
  });

  it('counts a repeated identical range but not the neighbouring one', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts', offset: 1, limit: 200 }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts', offset: 1, limit: 200 }));
    await harness.before(...read('ses_1', 'c3', { filePath: '/repo/a.ts', offset: 201, limit: 200 }));

    const reads = harness.summary('ses_1').reads;
    expect(reads.distinctTargets).toBe(2);
    expect(reads.repeatedTargets).toBe(1);
    expect(reads.repeatedRequests).toBe(1);
  });
});

describe('7. separate sessions', () => {
  it('keeps session state isolated', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts' }));
    await harness.before(...read('ses_2', 'c3', { filePath: '/repo/a.ts' }));
    await harness.before('ses_2', 'bash', 'c4');

    const first = harness.summary('ses_1');
    const second = harness.summary('ses_2');

    expect(first.reads.repeatedRequests).toBe(1);
    expect(first.counts.toolStartsObserved).toBe(2);
    expect(second.reads.repeatedRequests).toBe(0);
    expect(second.counts.toolStartsObserved).toBe(2);
    expect(harness.observer.getSessionIds()).toEqual(['ses_1', 'ses_2']);
  });

  it('keeps token totals separate per session', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 100 } }),
    });
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm2', sessionID: 'ses_2', tokens: { input: 7 } }),
    });

    expect(harness.summary('ses_1').measurements.inputTokens).toEqual({
      evidence: 'calculated',
      value: 100,
    });
    expect(harness.summary('ses_2').measurements.inputTokens).toEqual({
      evidence: 'calculated',
      value: 7,
    });
  });

  it('does not let one session complete another session call', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'edit', 'shared-call');
    await harness.after('ses_2', 'edit', 'shared-call');

    expect(harness.summary('ses_1').counts.pendingCalls).toBe(1);
    expect(harness.summary('ses_2').counts.uncorrelatedCompletions).toBe(1);
  });
});

describe('8. duplicate event handling', () => {
  it('ignores a repeated tool start for the same call id', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');
    await harness.before('ses_1', 'bash', 'c1');

    const summary = harness.summary('ses_1');
    expect(summary.counts.toolStartsObserved).toBe(1);
    expect(summary.counts.duplicateStartsIgnored).toBe(1);
    expect(harness.diagnostics.map((entry) => entry.code)).toContain('duplicate-tool-start');
  });

  it('does not count a read twice when its start is repeated', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));

    expect(harness.summary('ses_1').reads.requests).toBe(1);
  });

  it('ignores a repeated tool completion for the same call id', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');
    await harness.after('ses_1', 'bash', 'c1');
    await harness.after('ses_1', 'bash', 'c1');

    const summary = harness.summary('ses_1');
    expect(summary.counts.toolCompletionsObserved).toBe(1);
    expect(summary.counts.duplicateCompletionsIgnored).toBe(1);
    expect(summary.counts.correlatedCompletions).toBe(1);
  });

  it('does not count a repeated completion as an uncorrelated one', async () => {
    const harness = await createObservationHarness();
    await harness.after('ses_1', 'bash', 'c1');
    await harness.after('ses_1', 'bash', 'c1');

    const summary = harness.summary('ses_1');
    expect(summary.counts.uncorrelatedCompletions).toBe(1);
    expect(summary.counts.toolCompletionsObserved).toBe(1);
  });
});

describe('9. missing or malformed data', () => {
  it('ignores hook input without usable identifiers', async () => {
    const harness = await createObservationHarness();

    await harness.hooks['tool.execute.before'](
      { tool: '', sessionID: 'ses_1', callID: 'c1' },
      { args: {} },
    );
    await harness.hooks['tool.execute.before'](
      { tool: 'bash', sessionID: '  ', callID: 'c2' },
      { args: {} },
    );
    await harness.hooks.event({ event: { properties: { info: {} } } });
    await harness.hooks.event({ event: { type: '' } });

    expect(harness.observer.getSnapshot().sessionCount).toBe(0);
    expect(harness.diagnostics.map((entry) => entry.code)).toContain('hook-input-unusable');
  });

  it('counts a read request with no usable path without inventing an identity', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { offset: 5 }));
    await harness.before(...read('ses_1', 'c2', undefined));

    const reads = harness.summary('ses_1').reads;
    expect(reads.requests).toBe(2);
    expect(reads.unidentifiedRequests).toBe(2);
    expect(reads.identifiedRequests).toBe(0);
    expect(reads.distinctTargets).toBe(0);
    expect(reads.repeatedRequests).toBe(0);
  });

  it('counts a read with unusable range values and applies the documented defaults', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts', offset: 'nope' }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts' }));

    const reads = harness.summary('ses_1').reads;
    expect(reads.malformedArgumentRequests).toBe(1);
    // Both requests resolve to the documented default range, so they are repeated.
    expect(reads.repeatedRequests).toBe(1);
    expect(harness.diagnostics.map((entry) => entry.code)).toContain('malformed-read-arguments');
  });

  it('survives an event whose properties are not an object', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', 'not-an-object');
    await harness.event('message.part.updated', 42);
    await harness.event('session.idle', null);

    expect(harness.observer.getSnapshot().internalErrors).toBe(0);
  });
});

describe('10. token usage collection', () => {
  it('records usage from an assistant message update', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({
        id: 'm1',
        sessionID: 'ses_1',
        cost: 0.25,
        tokens: { input: 500, output: 120, reasoning: 30, cache: { read: 40, write: 8 } },
      }),
    });

    const usage = harness.summary('ses_1').usage;
    expect(usage.messagesWithUsage).toBe(1);
    expect(usage.reportedByField).toEqual({
      input: 1,
      output: 1,
      reasoning: 1,
      cacheRead: 1,
      cacheWrite: 1,
      cost: 1,
    });
  });

  it('aggregates each field across messages without inventing a total', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 100, output: 10 } }),
    });
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm2', sessionID: 'ses_1', tokens: { input: 250, output: 20 } }),
    });

    const measurements = harness.summary('ses_1').measurements;
    expect(measurements.inputTokens).toEqual({ evidence: 'calculated', value: 350 });
    expect(measurements.outputTokens).toEqual({ evidence: 'calculated', value: 30 });
    expect(measurements.totalTokens.evidence).toBe('unavailable');
  });

  it('ignores user messages and messages without session identity', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', { info: { id: 'u1', sessionID: 'ses_1', role: 'user' } });
    await harness.event('message.updated', {
      info: assistantMessage({ id: '', sessionID: 'ses_1' }),
    });

    expect(harness.observer.getSnapshot().sessionCount).toBe(0);
  });

  it('counts step-finish parts but never aggregates them into session totals', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.part.updated', {
      part: {
        type: 'step-finish',
        sessionID: 'ses_1',
        messageID: 'm1',
        cost: 9,
        tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });

    const summary = harness.summary('ses_1');
    expect(summary.usage.stepFinishPartsObserved).toBe(1);
    expect(summary.usage.messagesWithUsage).toBe(0);
    expect(summary.measurements.inputTokens.evidence).toBe('unavailable');
  });

  it('drops a usage record when OpenCode removes the message', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1' }),
    });
    await harness.event('message.removed', { sessionID: 'ses_1', messageID: 'm1' });

    expect(harness.summary('ses_1').usage.messagesWithUsage).toBe(0);
  });

  it('counts compaction and idle lifecycle events', async () => {
    const harness = await createObservationHarness();
    await harness.event('session.created', { info: { id: 'ses_1' } });
    await harness.event('session.compacted', { sessionID: 'ses_1' });
    await harness.event('session.idle', { sessionID: 'ses_1' });

    const summary = harness.summary('ses_1');
    expect(summary.lifecycle).toEqual({ createdEvents: 1, idleEvents: 1, compactedEvents: 1 });
  });
});

describe('11. repeated message-update snapshots', () => {
  it('does not count the same snapshot twice', async () => {
    const harness = await createObservationHarness();
    const info = assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 400 } });

    await harness.event('message.updated', { info });
    await harness.event('message.updated', { info });
    await harness.event('message.updated', { info });

    const summary = harness.summary('ses_1');
    expect(summary.usage.messagesWithUsage).toBe(1);
    expect(summary.measurements.inputTokens).toEqual({ evidence: 'calculated', value: 400 });
  });

  it('adopts a higher later snapshot for the same message', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 100 } }),
    });
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 900 }, cost: 0.4 }),
    });

    const summary = harness.summary('ses_1');
    expect(summary.usage.messagesWithUsage).toBe(1);
    expect(summary.measurements.inputTokens).toEqual({ evidence: 'calculated', value: 900 });
    expect(summary.usage.usageRegressionsObserved).toBe(0);
  });

  it('never lets a lower later snapshot reduce a recorded total', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 900 } }),
    });
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 2 } }),
    });

    const summary = harness.summary('ses_1');
    expect(summary.measurements.inputTokens).toEqual({ evidence: 'calculated', value: 900 });
    expect(summary.usage.usageRegressionsObserved).toBe(1);
    expect(harness.diagnostics.map((entry) => entry.code)).toContain('usage-update-regression');
  });

  it('tracks messages with and without usable usage separately', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 5 } }),
    });
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm2', sessionID: 'ses_1', tokens: undefined, cost: undefined }),
    });

    const usage = harness.summary('ses_1').usage;
    expect(usage.messagesWithUsage).toBe(1);
    expect(usage.messagesWithoutUsage).toBe(1);
    expect(usage.usageUpdatesIgnored).toBe(1);
  });
});

describe('12. missing cost and token data', () => {
  it('reports unavailable token fields with a reason instead of a number', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');

    const measurements = harness.summary('ses_1').measurements;
    for (const field of [
      measurements.inputTokens,
      measurements.outputTokens,
      measurements.reasoningTokens,
      measurements.cacheReadTokens,
      measurements.cacheWriteTokens,
    ]) {
      expect(field.evidence).toBe('unavailable');
      expect(field.evidence === 'unavailable' ? field.note.length : 0).toBeGreaterThan(0);
    }
    expect(measurements.cost).toMatchObject({ evidence: 'unavailable' });
  });

  it('reports only the fields a provider actually supplies', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 10 }, cost: undefined }),
    });

    const measurements = harness.summary('ses_1').measurements;
    expect(measurements.inputTokens).toEqual({ evidence: 'calculated', value: 10 });
    expect(measurements.outputTokens.evidence).toBe('unavailable');
    expect(measurements.cacheReadTokens.evidence).toBe('unavailable');
    expect(measurements.cost.evidence).toBe('unavailable');
  });

  it('always reports total tokens as unavailable and explains why', async () => {
    const harness = await createObservationHarness();
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1' }),
    });

    const total = harness.summary('ses_1').measurements.totalTokens;
    expect(total.evidence).toBe('unavailable');
    if (total.evidence === 'unavailable') {
      expect(total.note).toContain('double count');
    }
  });

  it('never infers a monetary saving from repeated reads', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts' }));

    const measurements = harness.summary('ses_1').measurements;
    expect(measurements.repeatedFileReads).toEqual({ evidence: 'calculated', value: 1 });
    expect(measurements.cost.evidence).toBe('unavailable');
    expect(harness.observer.serializeSummary('ses_1')).not.toContain('saved');
  });
});

describe('13. calculated versus measured evidence', () => {
  it('classifies direct observations as measured', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');
    await harness.after('ses_1', 'bash', 'c1');
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts' }));

    const measurements = harness.summary('ses_1').measurements;
    expect(measurements.toolStartsObserved).toEqual({ evidence: 'measured', value: 2 });
    expect(measurements.toolCompletionsObserved).toEqual({ evidence: 'measured', value: 1 });
    expect(measurements.readRequestsObserved).toEqual({ evidence: 'measured', value: 1 });
    expect(measurements.identifiedReadRequests).toEqual({ evidence: 'measured', value: 1 });
  });

  it('classifies derived aggregates as calculated', async () => {
    const harness = await createObservationHarness();
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts' }));
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 20, output: 2 } }),
    });

    const measurements = harness.summary('ses_1').measurements;
    expect(measurements.distinctReadTargets).toEqual({ evidence: 'calculated', value: 1 });
    expect(measurements.repeatedReadTargets).toEqual({ evidence: 'calculated', value: 1 });
    expect(measurements.repeatedFileReads).toEqual({ evidence: 'calculated', value: 1 });
    expect(measurements.inputTokens).toEqual({ evidence: 'calculated', value: 20 });
  });

  it('never reports a benchmark-verified or estimated class', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts' }));

    const serialized = harness.observer.serializeSummary('ses_1') ?? '';
    expect(serialized).not.toContain('benchmark-verified');
    expect(serialized).not.toContain('"estimated"');
  });

  it('carries a static note that observation is not proof of saving', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');

    const summary = harness.summary('ses_1');
    expect(summary.notes.some((note) => note.includes('does not prove'))).toBe(true);
  });
});

describe('14. observer bypass', () => {
  it('records nothing while disabled and leaves OpenCode behavior untouched', async () => {
    const harness = await createObservationHarness({ enabled: false });

    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    await harness.after('ses_1', 'read', 'c1', { filePath: '/repo/a.ts' });
    await harness.event('message.updated', { info: assistantMessage() });

    expect(harness.observer.isEnabled()).toBe(false);
    expect(harness.observer.getSnapshot().sessionCount).toBe(0);
    expect(harness.observer.getSnapshot().eventsObserved).toBe(0);
  });

  it('resumes recording after being re-enabled and keeps earlier summaries', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');
    const before = harness.summary('ses_1');

    harness.observer.setEnabled(false);
    await harness.before('ses_1', 'bash', 'c2');
    expect(harness.summary('ses_1').counts.toolStartsObserved).toBe(1);

    harness.observer.setEnabled(true);
    await harness.before('ses_1', 'bash', 'c3');
    expect(harness.summary('ses_1').counts.toolStartsObserved).toBe(2);
    expect(before.counts.toolStartsObserved).toBe(1);
  });

  it('honours the documented environment switch', async () => {
    const harness = await createObservationHarness({
      env: { DR_TOKEN_OPENCODE_OBSERVER: 'off' },
    });
    await harness.before('ses_1', 'bash', 'c1');

    expect(harness.observer.getSnapshot().sessionCount).toBe(0);
  });

  it('recognises every documented disable value and nothing else', () => {
    for (const value of ['off', 'OFF', 'false', '0', 'no', 'disabled', ' false ']) {
      expect(isDisabledByEnvironment({ DR_TOKEN_OPENCODE_OBSERVER: value })).toBe(true);
    }
    for (const value of ['on', 'true', '1', '']) {
      expect(isDisabledByEnvironment({ DR_TOKEN_OPENCODE_OBSERVER: value })).toBe(false);
    }
    expect(isDisabledByEnvironment({})).toBe(false);
  });
});

describe('15. internal failure handling', () => {
  it('contains a failing hasher without aborting the tool call', async () => {
    const harness = await createObservationHarness({
      hash: () => {
        throw new Error('hasher exploded');
      },
    });

    await expect(
      harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' })),
    ).resolves.toBeUndefined();

    expect(harness.observer.getSnapshot().internalErrors).toBe(1);
    expect(harness.diagnostics.map((entry) => entry.code)).toContain('internal-failure');
  });

  it('keeps observing after an internal failure', async () => {
    let shouldThrow = true;
    const harness = await createObservationHarness({
      hash: (value: string) => {
        if (shouldThrow) {
          throw new Error('hasher exploded');
        }
        return fnv1aHex(value);
      },
    });

    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    shouldThrow = false;
    await harness.before('ses_1', 'bash', 'c2');

    const summary = harness.summary('ses_1');
    expect(summary.counts.toolStartsObserved).toBe(2);
    expect(harness.observer.getSnapshot().internalErrors).toBe(1);
  });

  it('contains a throwing diagnostic callback', async () => {
    const harness = await createObservationHarness({
      onDiagnostic: () => {
        throw new Error('callback exploded');
      },
    });

    await expect(harness.before('ses_1', 'bash', 'c1')).resolves.toBeUndefined();
    await expect(harness.before('ses_1', 'bash', 'c1')).resolves.toBeUndefined();
    expect(harness.summary('ses_1').counts.toolStartsObserved).toBe(1);
  });

  it('contains a failing clock', async () => {
    const harness = await createObservationHarness({
      now: () => {
        throw new Error('clock exploded');
      },
    });

    await harness.before('ses_1', 'bash', 'c1');

    const summary = harness.summary('ses_1');
    expect(summary.counts.toolStartsObserved).toBe(1);
    expect(summary.observedFromAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('contains a failing sink', async () => {
    const harness = await createObservationHarness({
      sink: () => {
        throw new Error('sink exploded');
      },
    });
    await harness.before('ses_1', 'bash', 'c1');

    await expect(harness.event('session.idle', { sessionID: 'ses_1' })).resolves.toBeUndefined();
    expect(harness.diagnostics.map((entry) => entry.code)).toContain('sink-failed');
  });
});

describe('16. hook inputs and outputs are never modified', () => {
  it('leaves tool execute inputs and outputs untouched', async () => {
    const harness = await createObservationHarness();
    const beforeInput = deepFreeze({ tool: 'read', sessionID: 'ses_1', callID: 'c1' });
    const beforeOutput = deepFreeze({ args: { filePath: '/repo/a.ts', offset: 3, limit: 4 } });
    const afterInput = deepFreeze({
      tool: 'read',
      sessionID: 'ses_1',
      callID: 'c1',
      args: { filePath: '/repo/a.ts', offset: 3, limit: 4 },
    });
    const afterOutput = deepFreeze({ title: 'a.ts', output: 'line one\nline two', metadata: { m: 1 } });

    const beforeInputSnapshot = snapshotValue(beforeInput);
    const beforeOutputSnapshot = snapshotValue(beforeOutput);
    const afterInputSnapshot = snapshotValue(afterInput);
    const afterOutputSnapshot = snapshotValue(afterOutput);

    await harness.hooks['tool.execute.before'](beforeInput, beforeOutput);
    await harness.hooks['tool.execute.after'](afterInput, afterOutput);

    expect(snapshotValue(beforeInput)).toBe(beforeInputSnapshot);
    expect(snapshotValue(beforeOutput)).toBe(beforeOutputSnapshot);
    expect(snapshotValue(afterInput)).toBe(afterInputSnapshot);
    expect(snapshotValue(afterOutput)).toBe(afterOutputSnapshot);
    expect(harness.observer.getSnapshot().internalErrors).toBe(0);
  });

  it('leaves event payloads untouched', async () => {
    const harness = await createObservationHarness();
    const event = deepFreeze({
      event: {
        type: 'message.updated',
        properties: { info: assistantMessage({ id: 'm1', sessionID: 'ses_1' }) },
      },
    });
    const snapshot = snapshotValue(event);

    await harness.hooks.event(event);

    expect(snapshotValue(event)).toBe(snapshot);
    expect(harness.observer.getSnapshot().internalErrors).toBe(0);
  });

  it('keeps no reference to tool arguments after the hook returns', async () => {
    const harness = await createObservationHarness();
    const args: { filePath: string; nested: { secret: string } } = {
      filePath: '/repo/a.ts',
      nested: { secret: SECRET_TEXT },
    };
    await harness.hooks['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_1', callID: 'c1' },
      { args },
    );

    args.nested.secret = 'mutated-after-the-call';
    const serialized = JSON.stringify(harness.observer.getSnapshot());
    expectNoSecrets(serialized, SECRETS);
    expect(serialized).not.toContain('mutated-after-the-call');
  });
});

describe('17. session cleanup and bounds', () => {
  it('drops session state when OpenCode deletes the session', async () => {
    const flushed: SessionObservationSummary[] = [];
    const harness = await createObservationHarness({
      sink: (summary) => {
        flushed.push(summary);
      },
    });
    await harness.before('ses_1', 'bash', 'c1');
    await harness.event('session.deleted', { info: { id: 'ses_1' } });

    expect(harness.observer.getSessionIds()).toEqual([]);
    expect(harness.observer.getSnapshot().sessionsClosed).toBe(1);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.counts.toolStartsObserved).toBe(1);
  });

  it('flushes and stops on dispose', async () => {
    const flushed: SessionObservationSummary[] = [];
    const harness = await createObservationHarness({
      sink: (summary) => {
        flushed.push(summary);
      },
    });
    await harness.before('ses_1', 'bash', 'c1');
    await harness.hooks.dispose();

    expect(flushed).toHaveLength(1);
    expect(harness.observer.getSnapshot().disposed).toBe(true);
    expect(harness.observer.getSessionIds()).toEqual([]);

    await harness.before('ses_1', 'bash', 'c2');
    expect(harness.observer.getSnapshot().sessionCount).toBe(0);
  });

  it('can be disposed twice without side effects', async () => {
    const harness = await createObservationHarness();
    await harness.hooks.dispose();
    await expect(harness.hooks.dispose()).resolves.toBeUndefined();
  });

  it('evicts the least recently used session at the session bound', async () => {
    const harness = await createObservationHarness({ limits: { maxSessions: 2 } });
    await harness.before('ses_1', 'bash', 'c1');
    harness.clock.advance();
    await harness.before('ses_2', 'bash', 'c2');
    harness.clock.advance();
    await harness.before('ses_1', 'bash', 'c3');
    harness.clock.advance();
    await harness.before('ses_3', 'bash', 'c4');

    expect(harness.observer.getSessionIds()).toEqual(['ses_1', 'ses_3']);
    expect(harness.observer.getSnapshot().sessionsEvicted).toBe(1);
  });

  it('bounds the tracked read targets and counts what was dropped', async () => {
    const harness = await createObservationHarness({ limits: { maxReadTargets: 1 } });
    await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
    await harness.before(...read('ses_1', 'c2', { filePath: '/repo/b.ts' }));

    const reads = harness.summary('ses_1').reads;
    expect(reads.distinctTargets).toBe(1);
    expect(reads.targetsDropped).toBe(1);
    expect(harness.diagnostics.map((entry) => entry.code)).toContain('read-target-limit-reached');
  });

  it('bounds pending calls and counts what was dropped', async () => {
    const harness = await createObservationHarness({ limits: { maxPendingCalls: 1 } });
    await harness.before('ses_1', 'bash', 'c1');
    await harness.before('ses_1', 'bash', 'c2');

    const counts = harness.summary('ses_1').counts;
    expect(counts.pendingCalls).toBe(1);
    expect(counts.pendingCallsDropped).toBe(1);
  });

  it('bounds tracked messages and counts what was dropped', async () => {
    const harness = await createObservationHarness({ limits: { maxTrackedMessages: 1 } });
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 1 } }),
    });
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm2', sessionID: 'ses_1', tokens: { input: 2 } }),
    });

    const summary = harness.summary('ses_1');
    expect(summary.usage.messagesWithUsage).toBe(1);
    expect(summary.usage.usageRecordsDropped).toBe(1);
  });

  it('bounds the retained diagnostic list', async () => {
    const harness = await createObservationHarness({ limits: { maxDiagnostics: 2 } });
    for (const callID of ['c1', 'c2', 'c3']) {
      await harness.before('ses_1', 'bash', callID);
      await harness.before('ses_1', 'bash', callID);
    }

    expect(harness.observer.getSnapshot().recentDiagnostics.length).toBeLessThanOrEqual(2);
  });

  it('clears all retained state on demand', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');
    harness.observer.clear();

    expect(harness.observer.getSessionIds()).toEqual([]);
  });
});

describe('18. sensitive-data exclusion', () => {
  it('keeps paths, prompts and tool output out of summaries and diagnostics', async () => {
    const harness = await createObservationHarness({ hash: defaultHash });

    await harness.before(...read('ses_1', 'c1', { filePath: SECRET_PATH }));
    await harness.after('ses_1', 'read', 'c1', { filePath: SECRET_PATH }, {
      title: SECRET_PATH,
      output: `${SECRET_TEXT} content of the file`,
      metadata: { filePath: SECRET_PATH },
    });
    await harness.before('ses_1', 'bash', 'c2', { command: `echo ${SECRET_TEXT}` });
    await harness.event('message.updated', {
      info: assistantMessage({ id: 'm1', sessionID: 'ses_1' }),
    });

    const secrets = [...SECRETS, 'content of the file', 'echo '];
    expectNoSecrets(JSON.stringify(harness.observer.getSnapshot()), secrets);
    expectNoSecrets(harness.observer.serializeSummary('ses_1') ?? '', secrets);
    expectNoSecrets(JSON.stringify(harness.diagnostics), secrets);
  });

  it('never reads the plugin context, which carries directory and client', async () => {
    const secrets = [SECRET_DIRECTORY, 'api-key-value', SECRET_TEXT];
    const { observer, plugin } = createOpenCodeObserver({ hash: defaultHash, env: {} });
    await plugin({
      directory: SECRET_DIRECTORY,
      worktree: SECRET_DIRECTORY,
      client: { app: { log: () => SECRET_TEXT } },
      project: { worktree: SECRET_DIRECTORY, id: SECRET_TEXT },
      serverUrl: 'https://example.invalid',
    });
    await observer.observeToolBefore(
      { tool: 'read', sessionID: 'ses_1', callID: 'c1' },
      { args: { filePath: SECRET_PATH } },
    );

    expectNoSecrets(JSON.stringify(observer.getSnapshot()), secrets);
  });

  it('keeps diagnostics content-free for every code', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1', { command: SECRET_TEXT });
    await harness.before('ses_1', 'bash', 'c1');
    await harness.event('file.edited', { file: SECRET_PATH });

    expect(harness.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of harness.diagnostics) {
      expectNoSecrets(JSON.stringify(diagnostic), SECRETS);
      expect(diagnostic.message).not.toMatch(/[\\/]/);
    }
  });
});

describe('determinism and inspection', () => {
  it('produces identical summaries for identical event streams', async () => {
    const runOnce = async (): Promise<string> => {
      const harness = await createObservationHarness();
      await harness.before(...read('ses_1', 'c1', { filePath: '/repo/a.ts' }));
      await harness.before(...read('ses_1', 'c2', { filePath: '/repo/a.ts' }));
      await harness.event('message.updated', {
        info: assistantMessage({ id: 'm1', sessionID: 'ses_1', tokens: { input: 12 } }),
      });
      return harness.observer.serializeSummary('ses_1') ?? '';
    };

    expect(await runOnce()).toBe(await runOnce());
  });

  it('reports unknown sessions as undefined rather than an empty summary', async () => {
    const harness = await createObservationHarness();
    expect(harness.observer.getSummary('missing')).toBeUndefined();
    expect(harness.observer.serializeSummary('missing')).toBeUndefined();
  });

  it('emits a summary to the sink when the session goes idle', async () => {
    const flushed: SessionObservationSummary[] = [];
    const harness = await createObservationHarness({
      sink: (summary) => {
        flushed.push(summary);
      },
    });
    await harness.before('ses_1', 'bash', 'c1');
    await harness.event('session.idle', { sessionID: 'ses_1' });

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.sessionId).toBe('ses_1');
    expect(flushed[0]?.measurements.toolStartsObserved).toEqual({ evidence: 'measured', value: 1 });
  });

  it('records diagnostics as a bounded, inspectable list', async () => {
    const harness = await createObservationHarness();
    await harness.before('ses_1', 'bash', 'c1');
    await harness.before('ses_1', 'bash', 'c1');

    const diagnostics: readonly ObserverDiagnostic[] =
      harness.observer.getSnapshot().recentDiagnostics;
    expect(diagnostics.map((entry) => entry.code)).toContain('duplicate-tool-start');
    expect(diagnostics.every((entry) => typeof entry.at === 'string')).toBe(true);
  });
});
