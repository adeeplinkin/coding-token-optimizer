import { describe, expect, it } from 'vitest';
import { resolveSafeModeSetting } from '../src/index.js';
import {
  createV2Host,
  projectLocation,
  sessionCreatedData,
  sessionDeletedData,
  v2Envelope,
} from './v2-host.js';

/**
 * Safe Mode M1 observation, tested through the **real V2 adapter boundary**.
 *
 * Every test drives `createOpenCodeObserverV2` through the fake-but-strict V2
 * host (`v2-host.ts`): the adapter's `setup` runs exactly as V2 runs it, the
 * session hook is invoked exactly as the host's request assembler would invoke
 * it, and assertions read the summaries the observer would actually write.
 * Nothing here calls the analyzer directly — that is what
 * `opportunity.test.ts` is for.
 */

function toolCall(id: string, name: string): Record<string, unknown> {
  return { type: 'tool-call', id, name, input: {} };
}

function toolResult(id: string, name: string, value: string): Record<string, unknown> {
  return { type: 'tool-result', id, name, result: { type: 'text', value } };
}

/**
 * A request shaped like the Stage 1P evidence: one user turn, then two `read`
 * executions whose results are byte-identical.
 */
function repeatedReadRequest(sessionID: string, value: string): Record<string, unknown> {
  return {
    sessionID,
    agent: 'build',
    model: { id: 'test-model', providerID: 'test' },
    system: [{ type: 'text', text: 'system instructions' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read the file twice.' }] },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'I will read it.' }, toolCall('call_1', 'read')],
      },
      { role: 'tool', content: [toolResult('call_1', 'read', value)] },
      { role: 'assistant', content: [toolCall('call_2', 'read')] },
      { role: 'tool', content: [toolResult('call_2', 'read', value)] },
    ],
    options: { temperature: 0 },
  };
}

async function hostWithSession(
  options: Parameters<typeof createV2Host>[0] = {},
  environment: Parameters<typeof createV2Host>[1] = {},
  sessionID = 'ses_created',
) {
  const host = await createV2Host(options, environment);
  host.push(v2Envelope('session.created', sessionCreatedData({ sessionID })));
  await host.settle();
  return host;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
}

describe('resolveSafeModeSetting', () => {
  it('defaults to off when nothing is set', () => {
    expect(resolveSafeModeSetting(undefined, {})).toEqual({
      mode: 'off',
      applyRequested: false,
      ignored: false,
    });
  });

  it('reads the environment switch, case-insensitively and trimmed', () => {
    expect(resolveSafeModeSetting(undefined, { DR_TOKEN_SAFE_MODE: ' OBSERVE ' }).mode).toBe(
      'observe',
    );
    expect(resolveSafeModeSetting(undefined, { DR_TOKEN_SAFE_MODE: 'off' }).mode).toBe('off');
  });

  it('lets an explicit option win over the environment', () => {
    expect(resolveSafeModeSetting('off', { DR_TOKEN_SAFE_MODE: 'observe' }).mode).toBe('off');
    expect(resolveSafeModeSetting('observe', { DR_TOKEN_SAFE_MODE: 'off' }).mode).toBe('observe');
  });

  it('downgrades apply to observe and reports it, rather than silently ignoring the request', () => {
    expect(resolveSafeModeSetting(undefined, { DR_TOKEN_SAFE_MODE: 'apply' })).toEqual({
      mode: 'observe',
      applyRequested: true,
      ignored: false,
    });
  });

  it('reports an unusable value instead of guessing', () => {
    expect(resolveSafeModeSetting(undefined, { DR_TOKEN_SAFE_MODE: 'sometimes' })).toEqual({
      mode: 'off',
      applyRequested: false,
      ignored: true,
    });
    expect(resolveSafeModeSetting(true, {})).toEqual({
      mode: 'off',
      applyRequested: false,
      ignored: true,
    });
  });

  it('treats an empty value as off, not as an error', () => {
    expect(resolveSafeModeSetting(undefined, { DR_TOKEN_SAFE_MODE: '  ' })).toEqual({
      mode: 'off',
      applyRequested: false,
      ignored: false,
    });
  });
});

describe('opt-in surface', () => {
  it('registers nothing by default and reports no safeMode section', async () => {
    const host = await hostWithSession();

    expect(host.observer.isSafeModeObserving()).toBe(false);
    expect(host.registeredSessionHooks()).toEqual([]);
    expect(host.observer.getSnapshot().sessions).toHaveLength(1);
    const summary = host.observer.getSummary('ses_created');
    expect(summary).toBeDefined();
    expect(summary !== undefined && 'safeMode' in summary).toBe(false);

    await host.close();
  });

  it('registers the request hook when the environment opts in', async () => {
    const host = await createV2Host({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });

    expect(host.observer.isSafeModeObserving()).toBe(true);
    expect(host.registeredSessionHooks()).toEqual(['context']);
    // The tool surface is unchanged by the opt-in.
    expect([...host.registeredHooks()].sort()).toEqual(['execute.after', 'execute.before']);

    await host.close();
  });

  it('registers the request hook when the plugin option opts in', async () => {
    const host = await createV2Host({}, { pluginOptions: { safeMode: 'observe' } });

    expect(host.observer.isSafeModeObserving()).toBe(true);
    expect(host.registeredSessionHooks()).toEqual(['context']);

    await host.close();
  });

  it('reports apply as unavailable and observes instead', async () => {
    const host = await createV2Host({ env: { DR_TOKEN_SAFE_MODE: 'apply' } });

    expect(host.observer.isSafeModeObserving()).toBe(true);
    expect(host.registeredSessionHooks()).toEqual(['context']);
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'safe-mode-apply-unavailable',
    );

    await host.close();
  });

  it('leaves safe mode off and reports an unusable setting', async () => {
    const host = await createV2Host({ env: { DR_TOKEN_SAFE_MODE: 'compromise' } });

    expect(host.observer.isSafeModeObserving()).toBe(false);
    expect(host.registeredSessionHooks()).toEqual([]);
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'safe-mode-setting-ignored',
    );

    await host.close();
  });

  it('notes a missing session domain and keeps observing everything else', async () => {
    const host = await createV2Host(
      { env: { DR_TOKEN_SAFE_MODE: 'observe' } },
      { omitSessionDomain: true },
    );

    expect(host.observer.isSafeModeObserving()).toBe(true);
    expect(host.registeredSessionHooks()).toEqual([]);
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'unsupported-plugin-capability',
    );
    expect([...host.registeredHooks()].sort()).toEqual(['execute.after', 'execute.before']);

    await host.close();
  });
});

describe('request observation through the adapter', () => {
  it('mirrors the Stage 1P evidence: a 135-character duplicate is detected but below the threshold', async () => {
    const value = 'x'.repeat(135);
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await host.session('context', repeatedReadRequest('ses_created', value));

    const summary = host.observer.getSummary('ses_created');
    expect(summary?.safeMode).toBeDefined();
    const safeMode = summary?.safeMode;
    if (safeMode === undefined) {
      throw new Error('expected a safeMode section');
    }

    expect(safeMode.mode).toBe('observe');
    expect(safeMode.requestsObserved).toBe(1);
    expect(safeMode.requestsUnusable).toBe(0);
    expect(safeMode.requestsWithoutDuplicates).toBe(0);
    expect(safeMode.messagesExamined).toBe(5);
    // 6 message parts (1 text, 1 reasoning, 2 tool-call, 2 tool-result) + 1 system part.
    expect(safeMode.partsExamined).toBe(7);
    expect(safeMode.toolResultPartsExamined).toBe(2);
    expect(safeMode.comparedToolResultParts).toBe(2);
    expect(safeMode.duplicateGroups).toBe(1);
    expect(safeMode.duplicateOccurrences).toBe(1);
    expect(safeMode.eligibleOccurrences).toBe(0);
    // The recorded Stage 1P duplicate WAS 135 characters: it is measured, and
    // it is refused because the design's E6 threshold is 400.
    expect(safeMode.duplicateCharacters).toBe(135);
    expect(safeMode.duplicateBytes).toBe(135);
    expect(safeMode.candidateCharacters).toBe(0);
    expect(safeMode.candidateBytes).toBe(0);
    expect(safeMode.refusedOccurrences['below-minimum-characters']).toBe(1);
    expect(safeMode.minimumEligibleCharacters).toBe(400);
    expect(safeMode.notes.length).toBeGreaterThan(0);

    await host.close();
  });

  it('counts an above-threshold duplicate as an eligible candidate', async () => {
    const value = 'y'.repeat(500);
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await host.session('context', repeatedReadRequest('ses_created', value));

    const safeMode = host.observer.getSummary('ses_created')?.safeMode;
    if (safeMode === undefined) {
      throw new Error('expected a safeMode section');
    }

    expect(safeMode.duplicateGroups).toBe(1);
    expect(safeMode.duplicateOccurrences).toBe(1);
    expect(safeMode.eligibleGroups).toBe(1);
    expect(safeMode.eligibleOccurrences).toBe(1);
    expect(safeMode.duplicateCharacters).toBe(500);
    expect(safeMode.duplicateBytes).toBe(500);
    expect(safeMode.candidateCharacters).toBe(500);
    expect(safeMode.candidateBytes).toBe(500);
    expect(safeMode.refusedOccurrences['below-minimum-characters']).toBe(0);

    await host.close();
  });

  it('honours a configured eligibility threshold end to end', async () => {
    const host = await hostWithSession({
      env: { DR_TOKEN_SAFE_MODE: 'observe' },
      opportunityLimits: { minEligibleCharacters: 100 },
    });
    await host.session('context', repeatedReadRequest('ses_created', 'x'.repeat(135)));

    const safeMode = host.observer.getSummary('ses_created')?.safeMode;
    expect(safeMode?.minimumEligibleCharacters).toBe(100);
    expect(safeMode?.eligibleOccurrences).toBe(1);
    expect(safeMode?.candidateCharacters).toBe(135);

    await host.close();
  });

  it('counts retries as separate request assemblies instead of claiming deduplication', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    const payload = repeatedReadRequest('ses_created', 'z'.repeat(500));
    await host.session('context', payload);
    await host.session('context', payload);

    const safeMode = host.observer.getSummary('ses_created')?.safeMode;
    expect(safeMode?.requestsObserved).toBe(2);
    expect(safeMode?.duplicateGroups).toBe(2);
    expect(safeMode?.eligibleOccurrences).toBe(2);

    await host.close();
  });

  it('keeps sessions independent', async () => {
    const host = await createV2Host({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    host.push(v2Envelope('session.created', sessionCreatedData({ sessionID: 'ses_a' })));
    host.push(v2Envelope('session.created', sessionCreatedData({ sessionID: 'ses_b' })));
    await host.settle();

    await host.session('context', repeatedReadRequest('ses_a', 'a'.repeat(500)));
    await host.session('context', repeatedReadRequest('ses_b', 'b'.repeat(500)));
    await host.session('context', repeatedReadRequest('ses_b', 'b'.repeat(500)));

    expect(host.observer.getSummary('ses_a')?.safeMode?.requestsObserved).toBe(1);
    expect(host.observer.getSummary('ses_b')?.safeMode?.requestsObserved).toBe(2);
    expect(host.observer.getSummary('ses_a')?.safeMode?.eligibleOccurrences).toBe(1);
    expect(host.observer.getSummary('ses_b')?.safeMode?.eligibleOccurrences).toBe(2);

    await host.close();
  });

  it('counts one request independently in each plugin instance, with no cross-instance deduplication', async () => {
    const payload = repeatedReadRequest('ses_created', 'm'.repeat(500));

    const first = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    const second = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await first.session('context', payload);
    await second.session('context', payload);

    // Stage 1P showed every registered plugin is invoked for the same request.
    // Each instance records what it saw; nothing pretends the two counts are
    // one deduplicated request.
    expect(first.observer.getSummary('ses_created')?.safeMode?.requestsObserved).toBe(1);
    expect(second.observer.getSummary('ses_created')?.safeMode?.requestsObserved).toBe(1);

    await first.close();
    await second.close();
  });

  it('is deterministic: the same request yields the same section on another instance', async () => {
    const payload = repeatedReadRequest('ses_created', 'd'.repeat(500));

    const first = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await first.session('context', payload);
    const firstSafeMode = first.observer.getSummary('ses_created')?.safeMode;

    const second = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await second.session('context', payload);
    const secondSafeMode = second.observer.getSummary('ses_created')?.safeMode;

    expect(firstSafeMode).toEqual(secondSafeMode);

    await first.close();
    await second.close();
  });

  it('counts a request with no duplicate as no-opportunity', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await host.session('context', {
      sessionID: 'ses_created',
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    const safeMode = host.observer.getSummary('ses_created')?.safeMode;
    expect(safeMode?.requestsObserved).toBe(1);
    expect(safeMode?.requestsWithoutDuplicates).toBe(1);
    expect(safeMode?.duplicateGroups).toBe(0);

    await host.close();
  });
});

describe('safety and containment', () => {
  it('never modifies a frozen request', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    const payload = repeatedReadRequest('ses_created', 'f'.repeat(500));
    deepFreeze(payload);
    const before = JSON.stringify(payload);

    await host.session('context', payload);

    expect(JSON.stringify(payload)).toBe(before);
    expect(host.observer.getSummary('ses_created')?.safeMode?.eligibleOccurrences).toBe(1);

    await host.close();
  });

  it('contains a throwing accessor in one part without losing the request or raising an internal error', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    const poisoned = toolResult('call_9', 'read', 'ignored');
    Object.defineProperty(poisoned, 'result', {
      enumerable: true,
      get() {
        throw new Error('hostile accessor');
      },
    });
    const payload = repeatedReadRequest('ses_created', 'g'.repeat(500));
    (payload['messages'] as unknown[]).push({ role: 'tool', content: [poisoned] });

    await host.session('context', payload);

    const safeMode = host.observer.getSummary('ses_created')?.safeMode;
    expect(safeMode?.requestsObserved).toBe(1);
    expect(safeMode?.excludedParts['result-malformed']).toBe(1);
    expect(safeMode?.eligibleOccurrences).toBe(1);
    expect(host.observer.getSnapshot().internalErrors).toBe(0);

    await host.close();
  });

  it('counts a request with a session id but no request shape as unusable', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await host.session('context', { sessionID: 'ses_created' });

    const safeMode = host.observer.getSummary('ses_created')?.safeMode;
    expect(safeMode?.requestsObserved).toBe(1);
    expect(safeMode?.requestsUnusable).toBe(1);
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'safe-mode-request-unusable',
    );

    await host.close();
  });

  it('ignores a request with no usable session id instead of attributing it', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await host.session('context', { messages: [] });

    expect(host.observer.getSummary('ses_created')?.safeMode?.requestsObserved).toBe(0);
    expect(host.observer.getSnapshot().eventsIgnored).toBeGreaterThan(0);

    await host.close();
  });

  it('records nothing while the observer itself is bypassed', async () => {
    const host = await createV2Host({
      env: { DR_TOKEN_OPENCODE_OBSERVER: 'off', DR_TOKEN_SAFE_MODE: 'observe' },
    });
    host.push(v2Envelope('session.created', sessionCreatedData()));
    await host.settle();
    await host.session('context', repeatedReadRequest('ses_created', 'h'.repeat(500)));

    expect(host.observer.getSummaries()).toHaveLength(0);

    await host.close();
  });

  it('honours the enabled=false plugin option for the request hook as well', async () => {
    const host = await createV2Host(
      { env: { DR_TOKEN_SAFE_MODE: 'observe' } },
      { pluginOptions: { enabled: false } },
    );
    host.push(v2Envelope('session.created', sessionCreatedData()));
    await host.settle();
    await host.session('context', repeatedReadRequest('ses_created', 'i'.repeat(500)));

    expect(host.observer.getSummaries()).toHaveLength(0);

    await host.close();
  });

  it('refuses a session that declares a different project, for request observation too', async () => {
    const host = await createV2Host(
      { env: { DR_TOKEN_SAFE_MODE: 'observe' } },
      { location: projectLocation('C:\\synthetic\\project', 'prj_a') },
    );
    host.push(
      v2Envelope(
        'session.created',
        sessionCreatedData({ sessionID: 'ses_other', projectID: 'prj_b' }),
      ),
    );
    await host.settle();
    await host.session('context', repeatedReadRequest('ses_other', 'j'.repeat(500)));

    expect(host.observer.getSummary('ses_other')).toBeUndefined();
    expect(host.observer.getSnapshot().sessionsOutOfScope).toBe(1);

    await host.close();
  });

  it('refuses a late request for a deleted session', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    host.push(v2Envelope('session.deleted', sessionDeletedData({ sessionID: 'ses_created' })));
    await host.settle();
    await host.session('context', repeatedReadRequest('ses_created', 'k'.repeat(500)));

    expect(host.observer.getSummary('ses_created')).toBeUndefined();
    expect(host.observer.getSnapshot().lateEventsIgnored).toBeGreaterThan(0);

    await host.close();
  });
});

describe('privacy', () => {
  it('records counts only: no tool content, prompt text, path or canary reaches a summary', async () => {
    const canaries = [
      'CANARY_TOOL_CONTENT_9f3a',
      'CANARY_PROMPT_a17c',
      'C:\\canary\\secret\\target.ts',
    ];
    const value = `${canaries[0]}`.repeat(30);
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    const payload = repeatedReadRequest('ses_created', value);
    (payload['messages'] as unknown[]).push({
      role: 'user',
      content: [{ type: 'text', text: `${canaries[1]} ${canaries[2]}` }],
    });

    await host.session('context', payload);

    const written = JSON.stringify(host.observer.getSummaries());
    for (const canary of canaries) {
      expect(written).not.toContain(canary);
    }
    expect(written).not.toContain('9f3a');
    expect(written).not.toContain('secret');

    const safeMode = host.observer.getSummary('ses_created')?.safeMode;
    expect(safeMode?.candidateCharacters).toBe(value.length);
    expect(safeMode?.notes.join(' ')).not.toContain('CANARY');

    await host.close();
  });
});
