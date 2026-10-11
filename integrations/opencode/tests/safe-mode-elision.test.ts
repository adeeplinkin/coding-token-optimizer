import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPPORTUNITY_LIMITS,
  SAFE_MODE_ELISION_MARKER,
  SAFE_MODE_ELISION_NOTES,
  SAFE_MODE_ELISION_PASS_ID,
  SAFE_MODE_ELISION_REFUSAL_REASONS,
  SAFE_MODE_ELISION_VERSION,
  SAFE_MODE_MARKER_PREFIX,
  analyseRequestOpportunities,
  applySafeModeElision,
  emptyElisionRefusals,
  isAgentLoopContextPayload,
} from '../src/index.js';

const VALUE = 'DRTOKEN-SAFE-MODE-CANARY '.repeat(25); // 625 characters

/** A primary-shaped request with two byte-identical `read` results. */
function duplicateRequest(options: { readonly value?: string; readonly tool?: string } = {}) {
  const value = options.value ?? VALUE;
  const tool = options.tool ?? 'read';
  return {
    sessionID: 'ses_test',
    agent: 'build',
    model: { id: 'test-model', providerID: 'test' },
    system: [{ type: 'text', text: 'system instructions' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read the file twice.' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: tool, input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'call_1', name: tool, result: { type: 'text', value } }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: tool, input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'call_2', name: tool, result: { type: 'text', value } }] },
    ],
    options: { temperature: 0 },
    tools: { read: { description: 'read a file', input: {} } },
  };
}

function resultValues(payload: Record<string, unknown>): readonly unknown[] {
  const messages = payload['messages'] as readonly Record<string, unknown>[];
  return messages
    .flatMap((message) => (Array.isArray(message['content']) ? message['content'] : []))
    .filter(
      (part): part is Record<string, unknown> =>
        typeof part === 'object' && part !== null && (part as Record<string, unknown>)['type'] === 'tool-result',
    )
    .map((part) => (part['result'] as Record<string, unknown>)['value']);
}

/** The `result` member of the single part of one message of {@link duplicateRequest}. */
function resultPart(payload: Record<string, unknown>, index: number): Record<string, unknown> {
  return toolPart(payload, index)['result'] as Record<string, unknown>;
}

/** The single part of one message of {@link duplicateRequest}. */
function toolPart(payload: Record<string, unknown>, index: number): Record<string, unknown> {
  const messages = payload['messages'] as Record<string, unknown>[];
  const content = (messages[index] as Record<string, unknown>)['content'] as Record<string, unknown>[];
  return content[0] as Record<string, unknown>;
}

function apply(payload: unknown, overrides: Partial<Parameters<typeof applySafeModeElision>[1]> = {}) {
  return applySafeModeElision(payload, { requestKindBasis: 'context-hook', enabled: true, ...overrides });
}

describe('safe mode elision defaults and identity', () => {
  it('is versioned, opt-in and off unless apply is explicitly enabled', () => {
    const payload = duplicateRequest();
    const outcome = applySafeModeElision(payload, { requestKindBasis: 'context-hook' });

    expect(outcome.passId).toBe(SAFE_MODE_ELISION_PASS_ID);
    expect(outcome.version).toBe(SAFE_MODE_ELISION_VERSION);
    expect(outcome.attempted).toBe(false);
    expect(outcome.applied).toBe(false);
    expect(outcome.refused['disabled']).toBe(1);
    // Not even examined: the payload is byte-identical to the input.
    expect(resultValues(payload)).toEqual([VALUE, VALUE]);
  });

  it('keeps the 400-character threshold as the default', () => {
    expect(DEFAULT_OPPORTUNITY_LIMITS.minEligibleCharacters).toBe(400);

    const below = duplicateRequest({ value: 'd'.repeat(399) });
    const atThreshold = duplicateRequest({ value: 'd'.repeat(400) });

    expect(apply(below).applied).toBe(false);
    expect(apply(atThreshold).applied).toBe(true);
  });

  it('carries the pass notes with every outcome', () => {
    expect(apply(duplicateRequest()).notes).toEqual(SAFE_MODE_ELISION_NOTES);
    expect(SAFE_MODE_ELISION_NOTES.join(' ')).toMatch(/not a token measurement|No token figure/i);
  });

  it('marks the replacement with the versioned marker after the M1 prefix', () => {
    expect(SAFE_MODE_ELISION_MARKER.startsWith('[dr-token/safe-mode/')).toBe(true);
    expect(SAFE_MODE_ELISION_MARKER).toContain(SAFE_MODE_MARKER_PREFIX);
    // Short enough that the marker itself can never be an eligible duplicate.
    expect(SAFE_MODE_ELISION_MARKER.length).toBeLessThan(
      DEFAULT_OPPORTUNITY_LIMITS.minEligibleCharacters,
    );
  });

  it('reports every refusal reason as zero for a fresh outcome', () => {
    expect(Object.keys(emptyElisionRefusals()).sort()).toEqual(
      [...SAFE_MODE_ELISION_REFUSAL_REASONS].sort(),
    );
    expect(Object.values(emptyElisionRefusals()).every((count) => count === 0)).toBe(true);
  });
});

describe('safe mode elision request gates', () => {
  it('refuses when the request kind could not be established', () => {
    const payload = duplicateRequest();
    const outcome = apply(payload, { requestKindBasis: 'unknown' });

    expect(outcome.attempted).toBe(false);
    expect(outcome.refused['request-kind-unverified']).toBe(1);
    expect(resultValues(payload)).toEqual([VALUE, VALUE]);
  });

  it.each([
    ['a non-object payload', 'not-a-payload'],
    ['an array payload', []],
    ['a payload with no messages', { sessionID: 's', agent: 'build', tools: {} }],
    ['a payload whose messages is not an array', { sessionID: 's', agent: 'build', tools: {}, messages: 'no' }],
    ['a payload with no agent', { sessionID: 's', tools: {}, messages: [] }],
    ['a payload with no tools', { sessionID: 's', agent: 'build', messages: [] }],
    ['a payload whose tool registry is empty', { sessionID: 's', agent: 'build', tools: {}, messages: [] }],
    ['a payload whose tools is not a registry', { sessionID: 's', agent: 'build', tools: [], messages: [] }],
    ['the live title payload shape', { sessionID: 's', messages: [], model: {}, options: {}, system: [] }],
  ])('refuses %s without touching it', (_label, payload) => {
    const outcome = apply(payload);

    expect(outcome.attempted).toBe(false);
    expect(outcome.applied).toBe(false);
    expect(outcome.refused['payload-not-agent-loop-shaped']).toBe(1);
  });

  it('refuses a request that already carries the marker prefix', () => {
    const alreadyMarked = duplicateRequest();
    const part = resultPart(alreadyMarked, 2);
    part['value'] = 'already contains dr-token/safe-mode/ somewhere';

    const outcome = apply(alreadyMarked);

    expect(outcome.attempted).toBe(true);
    expect(outcome.applied).toBe(false);
    expect(outcome.refused['marker-collision']).toBe(1);
  });

  it('refuses a bounded scan instead of eliding part of a request', () => {
    const payload = duplicateRequest();
    const outcome = apply(payload, { limits: { maxCharactersPerRequest: 10 } });

    expect(outcome.applied).toBe(false);
    expect(outcome.refused['scan-bounded']).toBe(1);
    expect(resultValues(payload)).toEqual([VALUE, VALUE]);
  });

  it('does nothing, successfully, when there is no eligible duplicate', () => {
    const payload = duplicateRequest({ value: 'tiny' });
    const outcome = apply(payload);

    expect(outcome.attempted).toBe(true);
    expect(outcome.applied).toBe(false);
    expect(outcome.elidedOccurrences).toBe(0);
    expect(resultValues(payload)).toEqual(['tiny', 'tiny']);
  });
});

describe('safe mode elision eligibility', () => {
  it('replaces the later copy only, preserving the original and every unrelated field', () => {
    const payload = duplicateRequest();
    const before = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

    const outcome = apply(payload);

    expect(outcome.applied).toBe(true);
    expect(outcome.elidedOccurrences).toBe(1);
    expect(outcome.markerWrites).toBe(1);
    expect(outcome.elidedCharacters).toBe(VALUE.length);
    expect(outcome.elidedBytes).toBe(625);
    expect(resultValues(payload)).toEqual([VALUE, SAFE_MODE_ELISION_MARKER]);

    // Only the later value changed: compare everything else back.
    const after = JSON.parse(JSON.stringify(payload)) as {
      messages: { content: { result: { value: unknown } }[] }[];
    };
    (after.messages[4]!.content[0]!.result as { value: unknown }).value = VALUE;
    expect(after).toEqual(before);
  });

  it('never elides an error result, a non-text result or a non-allowlisted tool', () => {
    const errorRequest = duplicateRequest();
    resultPart(errorRequest, 4)['type'] = 'error';
    expect(apply(errorRequest).applied).toBe(false);
    expect(resultValues(errorRequest)).toEqual([VALUE, VALUE]);

    const jsonRequest = duplicateRequest();
    resultPart(jsonRequest, 4)['type'] = 'json';
    expect(apply(jsonRequest).applied).toBe(false);

    const otherTool = duplicateRequest({ tool: 'write' });
    expect(apply(otherTool).applied).toBe(false);
    expect(resultValues(otherTool)).toEqual([VALUE, VALUE]);

    const providerExecuted = duplicateRequest();
    const messages = providerExecuted['messages'] as Record<string, unknown>[];
    const content = (messages[4] as Record<string, unknown>)['content'] as Record<string, unknown>[];
    (content[0] as Record<string, unknown>)['providerExecuted'] = true;
    expect(apply(providerExecuted).applied).toBe(false);
  });

  it('does not group identical text from different tools or namespaces', () => {
    const payload = duplicateRequest();
    const messages = payload['messages'] as Record<string, unknown>[];
    const content = (messages[4] as Record<string, unknown>)['content'] as Record<string, unknown>[];
    (content[0] as Record<string, unknown>)['namespace'] = 'other';

    const outcome = apply(payload);

    expect(outcome.applied).toBe(false);
    expect(resultValues(payload)).toEqual([VALUE, VALUE]);
  });

  it('skips malformed parts instead of guessing at them', () => {
    const payload = duplicateRequest();
    const messages = payload['messages'] as Record<string, unknown>[];
    const content = (messages[4] as Record<string, unknown>)['content'] as Record<string, unknown>[];
    content[0] = { type: 'tool-result', name: 'read', result: 'not-an-object' };

    expect(() => apply(payload)).not.toThrow();
    expect(resultValues(payload)).toEqual([VALUE, undefined]);
  });
});

describe('safe mode elision failure containment', () => {
  it('contains a frozen payload and reports the skipped write', () => {
    const payload = duplicateRequest();
    Object.freeze(resultPart(payload, 4));

    const outcome = apply(payload);

    expect(outcome.applied).toBe(false);
    expect(outcome.refused['assignment-guard-failed']).toBe(1);
    expect(resultValues(payload)).toEqual([VALUE, VALUE]);
  });

  it('skips a write when the value changed after the plan was made', () => {
    const payload = duplicateRequest();
    const part = resultPart(payload, 4);
    let reads = 0;
    Object.defineProperty(part, 'value', {
      configurable: true,
      get() {
        reads += 1;
        return reads <= 2 ? VALUE : 'changed by someone else';
      },
      set() {
        // A silent setter: the write must never be reached in this test.
        throw new Error('the guard let a stale write through');
      },
    });

    const outcome = apply(payload);

    expect(outcome.applied).toBe(false);
    expect(outcome.refused['assignment-guard-failed']).toBe(1);
  });

  it('fails closed when the analyzer and the locator disagree', () => {
    const payload = duplicateRequest();
    const part = toolPart(payload, 4);
    // A hostile accessor. The analyzer's own read is `typeof part['namespace'] === 'string' ?
    // part['namespace'] : ''`, so it consumes two reads and sees an empty namespace
    // (allowlisted); the locator's two reads then see a namespace, so the two disagree about
    // how many occurrences are eligible. The pass must refuse rather than write.
    let reads = 0;
    Object.defineProperty(part, 'namespace', {
      configurable: true,
      get() {
        reads += 1;
        return reads <= 2 ? '' : 'namespace';
      },
    });

    const outcome = apply(payload);

    expect(outcome.applied).toBe(false);
    expect(outcome.refused['plan-mismatch']).toBe(1);
    // Nothing was written even though the analyzer believed one occurrence eligible.
    expect(resultPart(payload, 4)['value']).toBe(VALUE);
  });
});

describe('safe mode elision evidence', () => {
  it('never reports content, digest or identifier in an outcome', () => {
    const payload = duplicateRequest();
    const outcome = apply(payload);
    const serialized = JSON.stringify(outcome);

    expect(outcome.applied).toBe(true);
    expect(serialized).not.toContain('DRTOKEN-SAFE-MODE-CANARY');
    expect(serialized).not.toContain('ses_test');
    expect(serialized).not.toContain('safe-mode/v1:');
    expect(serialized).not.toContain('Read the file twice');
    expect(serialized).not.toContain('test-model');
  });

  it('agrees with the M1 analyzer about how many occurrences were eligible', () => {
    const payloads: readonly Record<string, unknown>[] = [
      duplicateRequest(),
      duplicateRequest({ value: 's'.repeat(135) }),
      duplicateRequest({ value: 'd'.repeat(400) }),
      duplicateRequest({ value: 'x'.repeat(2_000) }),
      duplicateRequest({ tool: 'write' }),
    ];

    for (const payload of payloads) {
      const expected = analyseRequestOpportunities(structuredClone(payload));
      const outcome = apply(payload);

      if (outcome.applied) {
        expect(expected?.eligibleOccurrences).toBe(outcome.elidedOccurrences);
        expect(outcome.markerWrites).toBe(outcome.elidedOccurrences);
      } else {
        expect(outcome.elidedOccurrences).toBe(0);
      }
    }
  });

  it('does not elide twice when the same payload is applied again', () => {
    const payload = duplicateRequest();
    const first = apply(payload);
    const afterFirst = resultValues(payload);
    const second = apply(payload);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.refused['marker-collision']).toBe(1);
    expect(resultValues(payload)).toEqual(afterFirst);
    expect(afterFirst[1]).toBe(SAFE_MODE_ELISION_MARKER);
  });

  it('recognises an agent-loop payload and rejects the title shape', () => {
    expect(isAgentLoopContextPayload(duplicateRequest())).toBe(true);
    expect(isAgentLoopContextPayload({ sessionID: 's', messages: [], model: {}, options: {}, system: [] })).toBe(false);
    expect(isAgentLoopContextPayload(undefined)).toBe(false);
  });

  it('requires a non-empty tool registry, so a payload declaring no tools is refused', () => {
    // Measured: every live primary request declared 12 tool definitions. A payload
    // with none is not the agent loop, whichever hook delivered it.
    const noTools = { ...duplicateRequest(), tools: {} };
    expect(noTools['tools']).toBeDefined();
    expect(isAgentLoopContextPayload(noTools)).toBe(false);

    const outcome = apply(noTools);
    expect(outcome.attempted).toBe(false);
    expect(outcome.refused['payload-not-agent-loop-shaped']).toBe(1);
    expect(resultValues(noTools)).toEqual([VALUE, VALUE]);
  });

  it('is deterministic and stateless: two identical payloads get identical outcomes', () => {
    // No cache, TTL, session map or file is involved, so a retry, a concurrent request or a
    // host reload can only ever see the request it was handed.
    const first = apply(duplicateRequest());
    const second = apply(duplicateRequest());

    expect({ ...first, notes: undefined }).toEqual({ ...second, notes: undefined });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(true);
  });
});
