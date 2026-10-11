import { describe, expect, it } from 'vitest';
import { SAFE_MODE_ELISION_MARKER } from '../src/index.js';
import type { SessionObservationSummary } from '../src/index.js';
import { createV2Host, sessionCreatedData, v2Envelope } from './v2-host.js';

/**
 * The Safe Mode **apply** counters a session summary carries.
 *
 * Why these are tested through the adapter: the counters are what a benchmark
 * needs to prove that a shorter outbound request *is* the recorded elision rather
 * than an unrelated difference (design §6.3 mechanism evidence). They are only
 * useful if they come out of the same summary the observer writes, are scoped to
 * the session they describe, and never carry request content.
 *
 * The aggregate moved from the observer instance to the session in Stage 1U: one
 * plugin instance can observe several sessions, and instance-wide counters
 * reported under a session id would attribute one session's elisions to another.
 */

function toolCall(id: string): Record<string, unknown> {
  return { type: 'tool-call', id, name: 'read', input: {} };
}

function toolResult(id: string, value: string): Record<string, unknown> {
  return { type: 'tool-result', id, name: 'read', result: { type: 'text', value } };
}

/** Two byte-identical `read` results in one primary request, as in Stage 1T. */
function repeatedReadRequest(sessionID: string, value: string): Record<string, unknown> {
  return {
    sessionID,
    agent: 'build',
    model: { id: 'test-model', providerID: 'test' },
    system: [{ type: 'text', text: 'system instructions' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read the file twice.' }] },
      { role: 'assistant', content: [toolCall('call_1')] },
      { role: 'tool', content: [toolResult('call_1', value)] },
      { role: 'assistant', content: [toolCall('call_2')] },
      { role: 'tool', content: [toolResult('call_2', value)] },
    ],
    options: { temperature: 0 },
    tools: { read: { description: 'read a file', input: {} } },
  };
}

async function hostWithSession(
  options: Parameters<typeof createV2Host>[0] = {},
  sessionID = 'ses_created',
) {
  const host = await createV2Host(options, {});
  host.push(v2Envelope('session.created', sessionCreatedData({ sessionID })));
  await host.settle();
  return host;
}

describe('Safe Mode apply counters in the session summary', () => {
  it('records this session\u2019s own request-size facts, and no content', async () => {
    const canary = `canary-${'n'.repeat(500)}`;
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'apply' } });

    await host.session('context', repeatedReadRequest('ses_created', canary));

    const summary = host.observer.getSummary('ses_created');
    const apply = summary?.safeModeApply;
    expect(apply?.mode).toBe('apply');
    expect(apply?.requestsAttempted).toBe(1);
    expect(apply?.requestsApplied).toBe(1);
    expect(apply?.elidedOccurrences).toBe(1);
    expect(apply?.elidedCharacters).toBe(canary.length);
    expect(apply?.elidedBytes).toBe(Buffer.byteLength(canary, 'utf8'));
    expect(apply?.markerBytes).toBe(Buffer.byteLength(SAFE_MODE_ELISION_MARKER, 'utf8'));
    expect(apply?.refused['disabled']).toBe(0);

    // A number may not travel without the statement that it is a request-size
    // fact rather than a token measurement.
    expect(apply?.notes.join(' ')).toMatch(/not a token measurement|No token figure/i);

    // Nothing from the request may appear in the counters.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('canary');
    expect(serialized).not.toContain(canary.slice(0, 40));

    await host.close();
  });

  it('is absent entirely while apply was never requested', async () => {
    const observing = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'observe' } });
    await observing.session('context', repeatedReadRequest('ses_created', 'q'.repeat(500)));
    expect(observing.observer.getSummary('ses_created')?.safeModeApply).toBeUndefined();
    await observing.close();

    const off = await hostWithSession();
    // With Safe Mode off the adapter registers no request hook at all, so there is
    // no path by which a summary could report apply counters.
    expect(off.registeredSessionHooks()).not.toContain('context');
    expect(off.observer.getSummary('ses_created')?.safeModeApply).toBeUndefined();
    await off.close();
  });

  it('counts each session separately, and the instance view is their sum', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'apply' } });
    host.push(v2Envelope('session.created', sessionCreatedData({ sessionID: 'ses_second' })));
    await host.settle();

    const first = 'a'.repeat(500);
    const second = 'b'.repeat(700);
    await host.session('context', repeatedReadRequest('ses_created', first));
    await host.session('context', repeatedReadRequest('ses_second', second));

    const firstSummary = host.observer.getSummary('ses_created');
    const secondSummary = host.observer.getSummary('ses_second');
    expect(firstSummary?.safeModeApply?.elidedBytes).toBe(500);
    expect(secondSummary?.safeModeApply?.elidedBytes).toBe(700);
    // The marker is written once per session, not once per instance.
    expect(firstSummary?.safeModeApply?.markerBytes).toBe(
      Buffer.byteLength(SAFE_MODE_ELISION_MARKER, 'utf8'),
    );
    expect(secondSummary?.safeModeApply?.markerBytes).toBe(
      Buffer.byteLength(SAFE_MODE_ELISION_MARKER, 'utf8'),
    );

    const instance = host.observer.getSafeModeApplySummary();
    expect(instance?.requestsApplied).toBe(2);
    expect(instance?.elidedBytes).toBe(1200);

    await host.close();
  });

  it('stops touching requests and stays reportable when apply is switched off', async () => {
    const host = await hostWithSession({ env: { DR_TOKEN_SAFE_MODE: 'apply' } });
    await host.session('context', repeatedReadRequest('ses_created', 'c'.repeat(600)));

    host.observer.applyPluginOptions({ safeMode: 'off' });
    expect(host.observer.isSafeModeApplying()).toBe(false);

    // The hook may still be registered, but it is inert: switching Safe Mode off
    // makes the observer return before it analyses or passes the payload, so the
    // request is byte-identical to what the host assembled.
    const later = repeatedReadRequest('ses_created', 'd'.repeat(600));
    const before = structuredClone(later);
    await host.session('context', later);
    expect(later).toEqual(before);
    expect(JSON.stringify(later).split(SAFE_MODE_ELISION_MARKER).length - 1).toBe(0);

    // The counters still describe what happened, because a switch flipped later
    // must not erase the record of an earlier elision.
    const summary = host.observer.getSummary('ses_created');
    expect(summary?.safeModeApply?.requestsApplied).toBe(1);
    expect(summary?.safeModeApply?.elidedBytes).toBe(600);

    await host.close();
  });

  it('reports no counters when apply is requested but observation is disabled', async () => {
    const host = await hostWithSession({
      env: { DR_TOKEN_SAFE_MODE: 'apply' },
      enabled: false,
    });
    await host.session('context', repeatedReadRequest('ses_created', 'e'.repeat(600)));

    const summary = host.observer.getSummary('ses_created') as
      | SessionObservationSummary
      | undefined;
    expect(summary?.safeModeApply?.requestsApplied ?? 0).toBe(0);
    expect(summary?.safeModeApply?.elidedBytes ?? 0).toBe(0);
    expect(host.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'safe-mode-apply-unavailable',
    );

    await host.close();
  });
});
