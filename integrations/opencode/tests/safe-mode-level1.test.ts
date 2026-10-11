import { describe, expect, it } from 'vitest';
import {
  SAFE_MODE_ELISION_MARKER,
  SAFE_MODE_ELISION_PASS_ID,
  SAFE_MODE_ELISION_REFUSAL_REASONS,
  SAFE_MODE_MARKER_PREFIX,
  applySafeModeElision,
} from '../src/index.js';

/**
 * **Safe Mode Level 1 harness** — the deterministic request-level gate from
 * [docs/SAFE_MODE_DESIGN.md](../../../docs/SAFE_MODE_DESIGN.md) §6.2.
 *
 * It feeds built-in, synthetic request shapes through the real pass and then
 * judges the *transformed request itself* with a checker that is deliberately
 * independent of the planner: the checker re-walks the payload and reconstructs
 * what happened from the two documents, rather than trusting the outcome record.
 *
 * No model, no harness, no network, no clock: the same input always produces the
 * same output, so this runs in CI exactly as it runs here. Failing this suite
 * rejects the strategy regardless of any token measurement.
 *
 * The design's eight requirements are mapped one-to-one to the groups below:
 * (1) information preservation, (2) nothing else changed, (3) structural
 * validity, (4) marker integrity, (5) refusal cases, (6) determinism and
 * idempotence, (7) boundedness, (8) fuzz/property.
 */

const VALUE = 'L1-CANARY-0123456789-abcdefghijklmnopqrstuvwxyz '.repeat(12); // 576 characters

/* -------------------------------------------------------------------------- */
/* Independent judging                                                        */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every part of every message, in request order, with its location. */
function partsOf(payload: Json): readonly { where: string; part: Json }[] {
  const messages = Array.isArray(payload['messages']) ? payload['messages'] : [];
  const found: { where: string; part: Json }[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) {
      return;
    }
    const content = Array.isArray(message['content']) ? message['content'] : [];
    content.forEach((part, partIndex) => {
      if (isRecord(part)) {
        found.push({ where: `messages[${messageIndex}].content[${partIndex}]`, part });
      }
    });
  });
  return found;
}

function toolResultValues(payload: Json): readonly string[] {
  return partsOf(payload)
    .filter(({ part }) => part['type'] === 'tool-result')
    .map(({ part }) => {
      const result = part['result'];
      return isRecord(result) && typeof result['value'] === 'string' ? result['value'] : '';
    });
}

/** Tool-call ids and tool-result ids, in order — the provider's pairing contract. */
function callAndResultIds(payload: Json): readonly string[] {
  const ids: string[] = [];
  for (const { part } of partsOf(payload)) {
    const type = part['type'];
    if (type === 'tool-call' || type === 'tool-result') {
      const id = part['id'];
      ids.push(`${String(type)}:${typeof id === 'string' ? id : '<none>'}`);
    }
  }
  return ids;
}

/**
 * The transformed request with every edited value restored from its input.
 *
 * `edits` are the locations the *diff* found, so nothing is assumed about where
 * the pass may write: if it wrote anywhere else, the restored copy still differs.
 */
function restoreEditedValues(
  after: Json,
  edits: readonly { readonly where: string; readonly original: unknown }[],
): Json {
  const copy = structuredClone(after);
  const afterParts = partsOf(copy);
  for (const edit of edits) {
    const entry = afterParts.find((candidate) => candidate.where === edit.where);
    const result = entry === undefined ? undefined : entry.part['result'];
    if (isRecord(result)) {
      result['value'] = edit.original;
    }
  }
  return copy;
}

interface Judgement {
  /** Locations whose `result.value` changed at all. */
  readonly changedValues: readonly string[];
  /** Locations whose value became the published marker. */
  readonly markedLocations: readonly string[];
  /** Text that disappeared from a location and is now the marker there. */
  readonly removedTexts: readonly string[];
  /** Parts, ordering, identifiers and every unrelated field are unchanged. */
  readonly structureIntact: boolean;
  /** Every removed text is still present elsewhere in the same request. */
  readonly informationPreserved: boolean;
  /** No part outside the inserted markers carries the marker prefix. */
  readonly markerIntegrity: boolean;
}

/**
 * Judge one transformation from the two documents alone.
 *
 * Deliberately re-derives everything: it does not read the pass's outcome, and it
 * never assumes *where* an edit should have happened. §6.2 requirements (1)–(4).
 */
function judge(before: Json, after: Json): Judgement {
  const beforeParts = partsOf(before);
  const afterParts = partsOf(after);

  const changedValues: string[] = [];
  const markedLocations: string[] = [];
  const removedTexts: string[] = [];
  const edits: { where: string; original: unknown }[] = [];

  for (let index = 0; index < Math.min(beforeParts.length, afterParts.length); index += 1) {
    const beforeValue = (beforeParts[index]!.part['result'] as Json | undefined)?.['value'];
    const afterValue = (afterParts[index]!.part['result'] as Json | undefined)?.['value'];
    if (beforeValue === afterValue) {
      continue;
    }
    changedValues.push(beforeParts[index]!.where);
    edits.push({ where: beforeParts[index]!.where, original: beforeValue });
    if (afterValue === SAFE_MODE_ELISION_MARKER) {
      markedLocations.push(beforeParts[index]!.where);
      removedTexts.push(typeof beforeValue === 'string' ? beforeValue : '<not-a-string>');
    }
  }

  const structureIntact =
    beforeParts.length === afterParts.length &&
    beforeParts.every((entry, index) => entry.where === afterParts[index]!.where) &&
    JSON.stringify(callAndResultIds(before)) === JSON.stringify(callAndResultIds(after)) &&
    JSON.stringify(restoreEditedValues(after, edits)) === JSON.stringify(before);

  // (1) Information preservation, re-derived the way E4 states it: for every
  // marked location, at least one *other* location in the same transformed
  // request still holds the exact removed text.
  const afterValues = afterParts.map(({ where, part }) => ({
    where,
    value: (part['result'] as Json | undefined)?.['value'],
  }));
  const informationPreserved = markedLocations.every((where, index) => {
    const removed = removedTexts[index];
    return afterValues.some((entry) => entry.where !== where && entry.value === removed);
  });

  // (4) Marker integrity, relative to the input: the set of locations carrying
  // the marker prefix after the pass must be exactly the locations that carried
  // it before, plus the locations that were just written.
  const prefixedBefore = new Set(prefixedLocations(beforeParts));
  const prefixedAfter = new Set(prefixedLocations(afterParts));
  const expectedPrefixed = new Set([...prefixedBefore, ...markedLocations]);
  const markerIntegrity =
    prefixedAfter.size === expectedPrefixed.size &&
    [...prefixedAfter].every((where) => expectedPrefixed.has(where));

  return {
    changedValues,
    markedLocations,
    removedTexts,
    structureIntact,
    informationPreserved,
    markerIntegrity,
  };
}

/** Locations whose tool-result value carries the marker prefix. */
function prefixedLocations(parts: readonly { where: string; part: Json }[]): readonly string[] {
  return parts
    .filter(({ part }) => {
      const result = part['result'];
      return isRecord(result) && typeof result['value'] === 'string'
        ? result['value'].includes(SAFE_MODE_MARKER_PREFIX)
        : false;
    })
    .map(({ where }) => where);
}

/* -------------------------------------------------------------------------- */
/* Request shapes                                                             */
/* -------------------------------------------------------------------------- */

interface ShapeOptions {
  readonly value?: string;
  readonly tool?: string;
  readonly duplicate?: boolean;
  readonly resultType?: string;
  readonly eligible?: boolean;
  readonly markerPresent?: boolean;
  readonly namespace?: string;
}

/** One user turn, two `read` executions, byte-identical results by default. */
function request(options: ShapeOptions = {}): Json {
  const value = options.value ?? VALUE;
  const tool = options.tool ?? 'read';
  const resultType = options.resultType ?? 'text';
  const duplicated = options.duplicate ?? true;

  const result = (id: string): Json => ({
    type: 'tool-result',
    id,
    name: tool,
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    result: { type: resultType, value: resultType === 'text' ? value : { nested: value } },
  });

  const markerLine: Json = options.markerPresent
    ? { role: 'tool', content: [result('call_seed')] }
    : { role: 'user', content: [{ type: 'text', text: 'Notes' }] };

  return {
    sessionID: 'ses_level1',
    agent: 'build',
    model: { id: 'level1-model', providerID: 'level1' },
    system: [{ type: 'text', text: 'system instructions' }],
    messages: [
      ...(options.markerPresent
        ? [
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  id: 'call_seed',
                  name: 'read',
                  result: { type: 'text', value: `text carrying ${SAFE_MODE_MARKER_PREFIX} already` },
                },
              ],
            },
          ]
        : [markerLine]),
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: tool, input: { path: 'a.ts' } }] },
      { role: 'tool', content: [result('call_1')] },
      ...(duplicated
        ? [
            {
              role: 'assistant',
              content: [{ type: 'tool-call', id: 'call_2', name: tool, input: { path: 'a.ts' } }],
            },
            { role: 'tool', content: [result('call_2')] },
          ]
        : []),
    ],
    options: { temperature: 0 },
    tools: { read: { description: 'read a file', input: {} } },
  };
}

function apply(payload: unknown, overrides: Record<string, unknown> = {}) {
  return applySafeModeElision(payload, {
    requestKindBasis: 'context-hook',
    enabled: true,
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* §6.2 (1)–(4): the transformation itself                                    */
/* -------------------------------------------------------------------------- */

describe('Level 1: a legal transformation preserves information and changes nothing else', () => {
  it('elides exactly the later duplicate, keeps the original, and touches nothing else', () => {
    const payload = request();
    const before = structuredClone(payload);
    const outcome = apply(payload);
    const verdict = judge(before, payload);

    expect(outcome.applied).toBe(true);
    expect(outcome.passId).toBe(SAFE_MODE_ELISION_PASS_ID);

    // (2) Nothing else changed: structure, ordering, identifiers and every
    // unrelated field are byte-identical after restoring the marker values.
    expect(verdict.structureIntact).toBe(true);
    // messages[1]/[2] are the first call and its result; [3]/[4] the second.
    expect(verdict.changedValues).toEqual(['messages[4].content[0]']);
    // (1) The removed text survives in the same request.
    expect(verdict.removedTexts).toEqual([VALUE]);
    expect(verdict.informationPreserved).toBe(true);
    // (4) The only new text is the published marker.
    expect(verdict.markedLocations).toEqual(verdict.changedValues);
    expect(verdict.markerIntegrity).toBe(true);
    expect(toolResultValues(payload)).toEqual([VALUE, SAFE_MODE_ELISION_MARKER]);
    // (3) The tool-call/tool-result pairing is intact: both ids are still there.
    expect(JSON.stringify(callAndResultIds(payload))).toBe(JSON.stringify(callAndResultIds(before)));
  });

  it('records counts that the transformed request independently confirms', () => {
    const payload = request();
    const outcome = apply(payload);
    const values = toolResultValues(payload);

    expect(outcome.elidedOccurrences).toBe(1);
    expect(outcome.markerWrites).toBe(1);
    expect(outcome.elidedCharacters).toBe(VALUE.length);
    expect(outcome.elidedBytes).toBe(Buffer.byteLength(VALUE, 'utf8'));
    expect(outcome.markerBytes).toBe(Buffer.byteLength(SAFE_MODE_ELISION_MARKER, 'utf8'));
    expect(values.filter((value) => value === SAFE_MODE_ELISION_MARKER)).toHaveLength(
      outcome.markerWrites,
    );
    expect(values.filter((value) => value === VALUE)).toHaveLength(1);
  });

  it('handles three identical copies by eliding only the later ones', () => {
    const payload = request();
    const messages = payload['messages'] as Json[];
    messages.push(
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_3', name: 'read', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', id: 'call_3', name: 'read', result: { type: 'text', value: VALUE } },
        ],
      },
    );
    const before = structuredClone(payload);
    const outcome = apply(payload);
    const verdict = judge(before, payload);

    expect(outcome.elidedOccurrences).toBe(2);
    expect(verdict.structureIntact).toBe(true);
    expect(verdict.informationPreserved).toBe(true);
    expect(toolResultValues(payload)).toEqual([
      VALUE,
      SAFE_MODE_ELISION_MARKER,
      SAFE_MODE_ELISION_MARKER,
    ]);
  });

  it('leaves a request with two different but equal-length results alone', () => {
    const payload = request();
    const messages = payload['messages'] as Json[];
    ((messages[4] as Json)['content'] as Json[])[0] = {
      type: 'tool-result',
      id: 'call_2',
      name: 'read',
      result: { type: 'text', value: `${VALUE.slice(0, -1)}Z` },
    };
    const before = JSON.stringify(payload);

    expect(apply(payload).applied).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.2 (5): refusal cases leave the request completely untouched             */
/* -------------------------------------------------------------------------- */

describe('Level 1: every refusal leaves the request byte-identical', () => {
  const cases: readonly (readonly [string, Json])[] = [
    ['a non-allowlisted tool', request({ tool: 'write' })],
    ['a namespaced read', request({ namespace: 'other' })],
    ['an error result', request({ resultType: 'error' })],
    ['a json result', request({ resultType: 'json' })],
    ['a duplicate below the size threshold', request({ value: 'short-but-identical'.repeat(5) })],
    ['no duplicate at all', request({ duplicate: false })],
    ['a request already carrying the marker prefix', request({ markerPresent: true })],
    ['a request with no tool registry', { ...request(), tools: {} }],
    ['a payload that is not request-shaped', { messages: 'not-an-array', agent: 'build', tools: { read: {} } }],
  ];

  it.each(cases)('refuses %s without touching it', (_label, payload) => {
    const before = JSON.stringify(payload);
    const outcome = apply(payload);

    expect(outcome.applied).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
    expect(JSON.stringify(outcome)).not.toContain('ses_level1');
  });

  it('reports every refusal with a declared reason', () => {
    for (const [, payload] of cases) {
      const outcome = apply(payload);
      const total = SAFE_MODE_ELISION_REFUSAL_REASONS.reduce(
        (sum, reason) => sum + outcome.refused[reason],
        0,
      );
      if (outcome.applied) {
        continue;
      }
      // A refusal is always accounted for; a request with simply no opportunity
      // is `attempted` with zero refusals, which is not an error.
      expect(total > 0 || outcome.attempted).toBe(true);
    }
  });

  it('refuses a request whose earlier copy was dropped (only the later copy survives)', () => {
    const payload = request({ duplicate: false });
    const messages = payload['messages'] as Json[];
    messages.push(
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: 'read', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', id: 'call_2', name: 'read', result: { type: 'text', value: VALUE } },
        ],
      },
    );
    // The first `read` result is replaced by the "cleared by compaction" shape a
    // host may leave behind, so no earlier copy of the text remains.
    ((messages[2] as Json)['content'] as Json[])[0] = {
      type: 'tool-result',
      id: 'call_1',
      name: 'read',
      result: { type: 'text', value: '[Old tool result content cleared]' },
    };
    const before = JSON.stringify(payload);

    expect(apply(payload).applied).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.2 (6): determinism and idempotence                                      */
/* -------------------------------------------------------------------------- */

describe('Level 1: determinism and idempotence', () => {
  it('produces the same outcome and the same request for the same input', () => {
    const first = request();
    const second = request();
    const firstOutcome = apply(first);
    const secondOutcome = apply(second);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(firstOutcome)).toBe(JSON.stringify(secondOutcome));
  });

  it('changes nothing further when run on its own output', () => {
    const payload = request();
    const firstOutcome = apply(payload);
    const once = JSON.stringify(payload);
    const secondOutcome = apply(payload);

    expect(firstOutcome.applied).toBe(true);
    expect(secondOutcome.applied).toBe(false);
    expect(secondOutcome.refused['marker-collision']).toBe(1);
    expect(JSON.stringify(payload)).toBe(once);
  });

  it('is order-independent: the marker written by a neighbour does not change this payload', () => {
    const sibling = request();
    const payload = request();
    apply(sibling);
    const outcome = apply(payload);

    expect(outcome.applied).toBe(true);
    expect(outcome.elidedOccurrences).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.2 (7): boundedness                                                      */
/* -------------------------------------------------------------------------- */

describe('Level 1: boundedness on pathological requests', () => {
  it('refuses an oversized single result instead of truncating it', () => {
    const huge = 'x'.repeat(1_000_001);
    const payload = request({ value: huge });
    const before = JSON.stringify(payload);
    const started = performance.now();
    const outcome = apply(payload);

    expect(outcome.applied).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses a request beyond the total-character budget and writes nothing', () => {
    const payload = request();
    const before = JSON.stringify(payload);
    const outcome = apply(payload, { limits: { maxCharactersPerRequest: 100 } });

    expect(outcome.applied).toBe(false);
    expect(outcome.refused['scan-bounded']).toBe(1);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('elides inside its message budget on a very long request', () => {
    const payload = request();
    const messages = payload['messages'] as Json[];
    for (let index = 0; index < 3_000; index += 1) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `filler ${index}` }],
      });
    }
    expect(messages.length).toBeLessThanOrEqual(4_000);
    const before = JSON.stringify(payload);
    const started = performance.now();
    const outcome = apply(payload);

    // Still elides, still preserves, and the pass never grows: no state, no
    // accumulation, and the work stays inside the documented budget.
    expect(outcome.applied).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(judge(JSON.parse(before) as Json, payload).informationPreserved).toBe(true);
  });

  it('refuses — and writes nothing — once the message budget is exceeded', () => {
    const payload = request();
    const messages = payload['messages'] as Json[];
    for (let index = 0; index < 4_000; index += 1) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `filler ${index}` }],
      });
    }
    expect(messages.length).toBeGreaterThan(4_000);
    const before = JSON.stringify(payload);
    const started = performance.now();
    const outcome = apply(payload);

    // Fail-closed at the budget: the whole request refuses rather than eliding
    // part of a request the pass could not account for.
    expect(outcome.applied).toBe(false);
    expect(outcome.refused['scan-bounded']).toBe(1);
    expect(JSON.stringify(payload)).toBe(before);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('refuses a request past the part budget rather than scanning forever', () => {
    const payload = request();
    const messages = payload['messages'] as Json[];
    const content: Json[] = [];
    for (let index = 0; index < 600; index += 1) {
      content.push({ type: 'tool-result', id: `call_${index}`, name: 'read', result: { type: 'text', value: VALUE } });
    }
    messages.push({ role: 'tool', content });
    const before = JSON.stringify(payload);
    const outcome = apply(payload);

    expect(outcome.applied).toBe(false);
    expect(outcome.refused['scan-bounded']).toBe(1);
    expect(JSON.stringify(payload)).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.2 (8): fuzz / property                                                  */
/* -------------------------------------------------------------------------- */

describe('Level 1: randomized requests never violate the invariants', () => {
  /** Deterministic PRNG (mulberry32) so a failure is reproducible from its seed. */
  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomRequest(random: () => number, seed: number): Json {
    const toolNames = ['read', 'write', 'grep', 'read'];
    const texts = [
      'A'.repeat(500),
      'B'.repeat(399),
      'C'.repeat(401),
      `${'D'.repeat(450)}-${seed}`,
      'short',
      `prefix ${SAFE_MODE_MARKER_PREFIX} inside`,
    ];
    const messageCount = 1 + Math.floor(random() * 6);
    const messages: Json[] = [];
    for (let index = 0; index < messageCount; index += 1) {
      const parts: Json[] = [];
      const partCount = 1 + Math.floor(random() * 3);
      for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
        const roll = random();
        if (roll < 0.6) {
          parts.push({
            type: 'tool-result',
            id: `call_${index}_${partIndex}`,
            name: toolNames[Math.floor(random() * toolNames.length)],
            result: {
              type: random() < 0.85 ? 'text' : 'error',
              value: texts[Math.floor(random() * texts.length)],
            },
          });
        } else if (roll < 0.8) {
          parts.push({ type: 'text', text: texts[Math.floor(random() * texts.length)] });
        } else {
          parts.push({ type: 'tool-call', id: `call_${index}_${partIndex}`, name: 'read', input: {} });
        }
      }
      messages.push({ role: random() < 0.5 ? 'tool' : 'assistant', content: parts });
    }
    return {
      sessionID: `ses_fuzz_${seed}`,
      agent: 'build',
      messages,
      system: [{ type: 'text', text: 'system' }],
      tools: { read: { description: 'read', input: {} } },
    };
  }

  const seeds = Array.from({ length: 80 }, (_unused, index) => index + 1);

  it.each(seeds)('seed %i: invariants (1)–(4) hold', (seed) => {
    const payload = randomRequest(prng(seed), seed);
    const before = structuredClone(payload);
    const outcome = apply(payload);
    const verdict = judge(before, payload);

    // (1) information preservation, (2) nothing else changed,
    // (3) structural validity, (4) marker integrity.
    expect(verdict.structureIntact, `seed ${seed} changed something other than a value`).toBe(true);
    expect(verdict.informationPreserved, `seed ${seed} lost information`).toBe(true);
    expect(verdict.markerIntegrity, `seed ${seed} broke marker integrity`).toBe(true);
    expect(verdict.markedLocations).toEqual(verdict.changedValues);
    expect(outcome.markerWrites).toBe(verdict.markedLocations.length);

    // Idempotence holds for every generated request, and a second pass never
    // writes: either it refuses on the marker, or there is nothing left to elide.
    const once = JSON.stringify(payload);
    expect(apply(payload).applied).toBe(false);
    expect(JSON.stringify(payload)).toBe(once);
  });
});
