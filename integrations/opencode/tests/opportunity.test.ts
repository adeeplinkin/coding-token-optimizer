import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPPORTUNITY_LIMITS,
  OPPORTUNITY_OCCURRENCE_REFUSAL_REASONS,
  OPPORTUNITY_PART_EXCLUSION_REASONS,
  SAFE_MODE_MARKER_PREFIX,
  analyseRequestOpportunities,
  emptyOccurrenceRefusalCounts,
  emptyPartExclusionCounts,
} from '../src/index.js';
import type { OpportunityLimits, RequestOpportunityAnalysis } from '../src/index.js';

/**
 * Unit tests for the Safe Mode M1 opportunity analyzer.
 *
 * The analyzer is pure and deterministic, so these tests pin exact counters.
 * Adapter-boundary behaviour (registration, opt-in, summaries, privacy) is
 * covered separately in `safe-mode-observation.test.ts`.
 */

/** Limits with the E6 threshold lowered so small fixtures stay readable. */
function limits(overrides: Partial<OpportunityLimits> = {}): OpportunityLimits {
  return { ...DEFAULT_OPPORTUNITY_LIMITS, minEligibleCharacters: 1, ...overrides };
}

function toolResultPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'tool-result', id: 'call_1', name: 'read', result: { type: 'text', value: 'x' }, ...overrides };
}

function textPart(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

function reasoningPart(text: string): Record<string, unknown> {
  return { type: 'reasoning', text };
}

function message(role: string, content: unknown[]): Record<string, unknown> {
  return { role, content };
}

function request(
  messages: unknown[],
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { sessionID: 'ses_test', model: {}, system: [], messages, options: {}, ...extras };
}

function analyse(
  payload: Record<string, unknown>,
  overrides: Partial<OpportunityLimits> = {},
): RequestOpportunityAnalysis {
  const analysis = analyseRequestOpportunities(payload, limits(overrides));
  if (analysis === undefined) {
    throw new Error('expected an analysis');
  }
  return analysis;
}

const duplicateText = 'duplicate content of a repeated read result';

describe('detection and eligibility', () => {
  it('detects an exact duplicate and counts one eligible occurrence', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
      ]),
    );

    expect(analysis.duplicateGroups).toBe(1);
    expect(analysis.duplicateOccurrences).toBe(1);
    expect(analysis.eligibleGroups).toBe(1);
    expect(analysis.eligibleOccurrences).toBe(1);
    expect(analysis.duplicateCharacters).toBe(duplicateText.length);
    expect(analysis.duplicateBytes).toBe(duplicateText.length);
    expect(analysis.candidateCharacters).toBe(duplicateText.length);
    expect(analysis.candidateBytes).toBe(duplicateText.length);
    expect(analysis.markerCollision).toBe(false);
    expect(analysis.bounded).toBe(false);
  });

  it('counts every later copy of a three-way duplicate and keeps the first as the retained original', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_3', result: { type: 'text', value: duplicateText } })]),
      ]),
    );

    expect(analysis.duplicateGroups).toBe(1);
    expect(analysis.duplicateOccurrences).toBe(2);
    expect(analysis.eligibleOccurrences).toBe(2);
    expect(analysis.duplicateCharacters).toBe(duplicateText.length * 2);
    expect(analysis.candidateCharacters).toBe(duplicateText.length * 2);
  });

  it('counts characters as UTF-16 units and bytes as UTF-8', () => {
    const text = 'é😀'.repeat(10);
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: text } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: text } })]),
      ]),
    );

    expect(analysis.duplicateCharacters).toBe(30);
    expect(analysis.duplicateBytes).toBe(60);
    expect(analysis.candidateCharacters).toBe(30);
    expect(analysis.candidateBytes).toBe(60);
  });

  it('never treats near-duplicates as duplicates', () => {
    const variations = [
      `${duplicateText} `,
      ` ${duplicateText}`,
      duplicateText.toUpperCase(),
      duplicateText.replace(' ', '\t'),
      're\u0301sultat', // e + combining acute: not equal to the NFC form below
    ];
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: 'résultat' } })]),
        ...variations.map((value, index) =>
          message('tool', [toolResultPart({ id: `call_${index + 3}`, result: { type: 'text', value } })]),
        ),
      ]),
    );

    expect(analysis.duplicateGroups).toBe(0);
    expect(analysis.duplicateOccurrences).toBe(0);
  });

  it('does not group identical text from different tools', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [
          toolResultPart({ id: 'call_2', name: 'bash', result: { type: 'text', value: duplicateText } }),
        ]),
      ]),
    );

    expect(analysis.duplicateGroups).toBe(0);
    expect(analysis.duplicateOccurrences).toBe(0);
  });

  it('detects a duplicate from a non-allowlisted tool but refuses it as ineligible', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ name: 'bash', result: { type: 'text', value: duplicateText } })]),
        message('tool', [
          toolResultPart({ id: 'call_2', name: 'bash', result: { type: 'text', value: duplicateText } }),
        ]),
      ]),
    );

    expect(analysis.duplicateGroups).toBe(1);
    expect(analysis.duplicateOccurrences).toBe(1);
    expect(analysis.eligibleOccurrences).toBe(0);
    expect(analysis.duplicateCharacters).toBe(duplicateText.length);
    expect(analysis.candidateCharacters).toBe(0);
    expect(analysis.refusedOccurrences['tool-not-allowlisted']).toBe(1);
  });

  it('refuses a namespaced read: a namespaced tool is never the built-in read', () => {
    const analysis = analyse(
      request([
        message('tool', [
          toolResultPart({ namespace: 'mcp', result: { type: 'text', value: duplicateText } }),
        ]),
        message('tool', [
          toolResultPart({ id: 'call_2', namespace: 'mcp', result: { type: 'text', value: duplicateText } }),
        ]),
      ]),
    );

    expect(analysis.duplicateOccurrences).toBe(1);
    expect(analysis.eligibleOccurrences).toBe(0);
    expect(analysis.refusedOccurrences['tool-not-allowlisted']).toBe(1);
  });

  it('refuses a provider-executed part: its result may carry provider-side state', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [
          toolResultPart({
            id: 'call_2',
            providerExecuted: true,
            result: { type: 'text', value: duplicateText },
          }),
        ]),
      ]),
    );

    expect(analysis.duplicateOccurrences).toBe(1);
    expect(analysis.eligibleOccurrences).toBe(0);
    expect(analysis.refusedOccurrences['provider-executed']).toBe(1);
  });

  it('detects a below-threshold duplicate and records it as ineligible', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: 'short' } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: 'short' } })]),
      ]),
      { minEligibleCharacters: 400 },
    );

    expect(analysis.duplicateGroups).toBe(1);
    expect(analysis.duplicateOccurrences).toBe(1);
    expect(analysis.eligibleOccurrences).toBe(0);
    expect(analysis.duplicateCharacters).toBe('short'.length);
    expect(analysis.candidateCharacters).toBe(0);
    expect(analysis.refusedOccurrences['below-minimum-characters']).toBe(1);
  });

  it('keeps the occurrence invariant: occurrences equal eligible plus refused', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
        message('tool', [
          toolResultPart({ id: 'call_3', name: 'bash', result: { type: 'text', value: duplicateText } }),
        ]),
        message('tool', [
          toolResultPart({ id: 'call_4', name: 'bash', result: { type: 'text', value: duplicateText } }),
        ]),
      ]),
    );

    const refused = OPPORTUNITY_OCCURRENCE_REFUSAL_REASONS.reduce(
      (total, reason) => total + analysis.refusedOccurrences[reason],
      0,
    );
    expect(analysis.duplicateOccurrences).toBe(analysis.eligibleOccurrences + refused);
  });
});

describe('exclusions', () => {
  it('excludes error results and never compares them', () => {
    const analysis = analyse(
      request([
        message('tool', [
          toolResultPart({ result: { type: 'error', value: duplicateText } }),
        ]),
        message('tool', [
          toolResultPart({ id: 'call_2', result: { type: 'error', value: duplicateText } }),
        ]),
      ]),
    );

    expect(analysis.duplicateGroups).toBe(0);
    expect(analysis.excludedParts['result-error']).toBe(2);
    expect(analysis.comparedToolResultParts).toBe(0);
  });

  it('excludes json and content results: their exact model-visible text is not provable here', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'json', value: { a: 1 } } })]),
        message('tool', [
          toolResultPart({
            id: 'call_2',
            result: { type: 'content', value: [{ type: 'text', text: duplicateText }] },
          }),
        ]),
      ]),
    );

    expect(analysis.duplicateGroups).toBe(0);
    expect(analysis.excludedParts['result-type-unsupported']).toBe(2);
  });

  it('excludes malformed results without throwing', () => {
    const parts = [
      toolResultPart({ id: 'call_1', result: undefined }), // result not an object
      toolResultPart({ id: 'call_2', result: { type: 'mystery', value: 'x' } }), // unknown type
      toolResultPart({ id: 'call_3', result: { type: 'text', value: 42 } }), // text but not a string
      toolResultPart({ id: 'call_4', name: '   ', result: { type: 'text', value: 'x' } }), // identity missing
    ];
    const analysis = analyse(request(parts.map((part) => message('tool', [part]))));

    expect(analysis.excludedParts['result-malformed']).toBe(3);
    expect(analysis.excludedParts['tool-identity-missing']).toBe(1);
    expect(analysis.comparedToolResultParts).toBe(0);
  });

  it('excludes a payload larger than the per-result bound rather than truncating it', () => {
    const oversized = 'y'.repeat(50);
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: oversized } })]),
        message('tool', [
          toolResultPart({ id: 'call_2', result: { type: 'text', value: oversized } }),
        ]),
      ]),
      { maxCharactersPerToolResult: 10 },
    );

    expect(analysis.duplicateGroups).toBe(0);
    expect(analysis.excludedParts['payload-too-large']).toBe(2);
    // Not a scan bound: the request could still be analysed, so nothing else is refused.
    expect(analysis.bounded).toBe(false);
  });

  it('tolerates non-record messages and parts, and ignores unrelated part types', () => {
    const analysis = analyse(
      request([
        'not a message',
        message('user', [textPart('hello'), 'not a part', { type: 'tool-call', id: 'call_1', name: 'read' }]),
        message('assistant', [reasoningPart('thinking')]),
      ]),
    );

    expect(analysis.messagesExamined).toBe(3);
    expect(analysis.duplicateGroups).toBe(0);
    expect(analysis.bounded).toBe(false);
  });

  it('excludes a part whose accessor throws without losing the rest of the request', () => {
    const poisoned = toolResultPart();
    Object.defineProperty(poisoned, 'result', {
      enumerable: true,
      get() {
        throw new Error('hostile accessor');
      },
    });
    const analysis = analyse(
      request([
        message('tool', [poisoned]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_3', result: { type: 'text', value: duplicateText } })]),
      ]),
    );

    expect(analysis.excludedParts['result-malformed']).toBe(1);
    expect(analysis.duplicateGroups).toBe(1);
    expect(analysis.eligibleOccurrences).toBe(1);
  });
});

describe('marker collisions (E7)', () => {
  it('refuses every would-be elision when a tool result contains the marker prefix', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [
          toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } }),
        ]),
        message('tool', [
          toolResultPart({
            id: 'call_3',
            result: { type: 'text', value: `${SAFE_MODE_MARKER_PREFIX}v1 spoofed` },
          }),
        ]),
      ]),
    );

    expect(analysis.markerCollision).toBe(true);
    expect(analysis.duplicateGroups).toBe(1);
    expect(analysis.duplicateOccurrences).toBe(1);
    expect(analysis.eligibleOccurrences).toBe(0);
    expect(analysis.refusedOccurrences['marker-collision']).toBe(1);
  });

  it('refuses when a text or reasoning part carries the marker prefix', () => {
    const carriers = [
      message('user', [textPart(`${SAFE_MODE_MARKER_PREFIX} in a prompt`)]),
      message('assistant', [reasoningPart(`${SAFE_MODE_MARKER_PREFIX} thinking`)]),
    ];
    for (const carrier of carriers) {
      const analysis = analyse(
        request([
          carrier,
          message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
          message('tool', [
            toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } }),
          ]),
        ]),
      );

      expect(analysis.markerCollision).toBe(true);
      expect(analysis.eligibleOccurrences).toBe(0);
      expect(analysis.refusedOccurrences['marker-collision']).toBe(1);
    }
  });

  it('refuses when a system part carries the marker prefix', () => {
    const analysis = analyse(
      request(
        [
          message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
          message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
        ],
        { system: [{ type: 'text', text: `${SAFE_MODE_MARKER_PREFIX} in instructions` }] },
      ),
    );

    expect(analysis.markerCollision).toBe(true);
    expect(analysis.eligibleOccurrences).toBe(0);
  });
});

describe('bounds (E9)', () => {
  it('stops at the message bound, marks the scan bounded and refuses eligibility', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
      ]),
      { maxMessages: 1 },
    );

    expect(analysis.bounded).toBe(true);
    expect(analysis.messagesExamined).toBe(1);
    // The duplicate was never reached, so nothing was detected and nothing is eligible.
    expect(analysis.duplicateOccurrences).toBe(0);
    expect(analysis.eligibleOccurrences).toBe(0);
  });

  it('refuses a caught duplicate when the total character budget is exhausted after it', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
        message('user', [textPart('z'.repeat(1_000))]),
      ]),
      { maxCharactersPerRequest: duplicateText.length * 2 + 10 },
    );

    expect(analysis.bounded).toBe(true);
    expect(analysis.duplicateOccurrences).toBe(1);
    expect(analysis.eligibleOccurrences).toBe(0);
    expect(analysis.refusedOccurrences['scan-bounded']).toBe(1);
  });

  it('stops at the tool-result bound', () => {
    const analysis = analyse(
      request([
        message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
        message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
      ]),
      { maxToolResultParts: 1 },
    );

    expect(analysis.bounded).toBe(true);
    expect(analysis.toolResultParts).toBe(2);
    expect(analysis.duplicateOccurrences).toBe(0);
  });

  it('stops at the per-message part bound', () => {
    const analysis = analyse(
      request([message('tool', [toolResultPart(), toolResultPart({ id: 'call_2' })])]),
      { maxPartsPerMessage: 1 },
    );

    expect(analysis.bounded).toBe(true);
    expect(analysis.partsExamined).toBe(1);
  });
});

describe('shape, determinism and purity', () => {
  it('returns undefined for payloads that are not request-shaped', () => {
    const payloads: readonly unknown[] = [
      null,
      'request',
      [],
      {},
      { messages: 'nope' },
      { system: 'nope' },
    ];
    for (const payload of payloads) {
      expect(analyseRequestOpportunities(payload, limits())).toBeUndefined();
    }
  });

  it('analyses an empty message list as a reading of zeroes, not as unusable', () => {
    const analysis = analyse({ sessionID: 'ses_x', messages: [], system: [] });

    expect(analysis.duplicateGroups).toBe(0);
    expect(analysis.messagesExamined).toBe(0);
    expect(analysis.partsExamined).toBe(0);
  });

  it('is deterministic and never mutates a frozen payload', () => {
    const payload = request([
      message('tool', [toolResultPart({ result: { type: 'text', value: duplicateText } })]),
      message('tool', [toolResultPart({ id: 'call_2', result: { type: 'text', value: duplicateText } })]),
      message('user', [textPart('hello')]),
    ]);
    deepFreeze(payload);
    const before = JSON.stringify(payload);

    const first = analyse(payload);
    const second = analyse(payload);

    expect(first).toEqual(second);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('exposes every exclusion and refusal reason, zeroed, for stable records', () => {
    expect(Object.keys(emptyPartExclusionCounts()).sort()).toEqual(
      [...OPPORTUNITY_PART_EXCLUSION_REASONS].sort(),
    );
    expect(Object.keys(emptyOccurrenceRefusalCounts()).sort()).toEqual(
      [...OPPORTUNITY_OCCURRENCE_REFUSAL_REASONS].sort(),
    );
    expect(DEFAULT_OPPORTUNITY_LIMITS.minEligibleCharacters).toBe(400);
  });
});

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
}
