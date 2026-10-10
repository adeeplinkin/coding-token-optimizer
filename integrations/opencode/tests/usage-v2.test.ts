import { describe, expect, it } from 'vitest';
import {
  compareSessionUsage,
  extractSessionUsage,
  readUsageNumber,
  sessionUsageFields,
} from '../src/index.js';
import type { SessionUsageSnapshot } from '../src/index.js';
import { deepFreeze, snapshotValue } from './helpers.js';

/**
 * V2 usage extraction.
 *
 * The payload below is the structure Stage 1G observed in OpenCode Desktop 2.0.24
 * for `session.usage.updated`, delivered under `event.data`:
 * `{ id, created, type, data: { sessionID, cost, tokens: { input, output,
 *    reasoning, cache: { read, write } } } }`.
 */
function v2Usage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionID: 'ses_v2',
    cost: 0.0123,
    tokens: { input: 368, output: 75, reasoning: 91, cache: { read: 10496, write: 0 } },
    ...overrides,
  };
}

function recorded(payload: unknown): SessionUsageSnapshot {
  const result = extractSessionUsage(payload);
  if (result.kind !== 'recorded') {
    throw new Error(`expected a recorded snapshot, got ${result.reason}`);
  }
  return result.snapshot;
}

describe('V2 session usage extraction', () => {
  it('extracts every supported field exactly as reported', () => {
    const snapshot = recorded(v2Usage());

    expect(snapshot).toEqual({
      sessionId: 'ses_v2',
      input: 368,
      output: 75,
      reasoning: 91,
      cacheRead: 10496,
      cacheWrite: 0,
      cost: 0.0123,
    });
  });

  it('keeps a reported zero and leaves an absent field undefined', () => {
    const snapshot = recorded({
      sessionID: 'ses_v2',
      cost: 0,
      tokens: { input: 0, cache: { write: 7 } },
    });

    // Zero is a measurement; missing is not.
    expect(snapshot.cost).toBe(0);
    expect(snapshot.input).toBe(0);
    expect(snapshot.output).toBeUndefined();
    expect(snapshot.reasoning).toBeUndefined();
    expect(snapshot.cacheRead).toBeUndefined();
    expect(snapshot.cacheWrite).toBe(7);
  });

  it('rejects payloads without a usable session identity', () => {
    expect(extractSessionUsage(undefined)).toEqual({
      kind: 'ignored',
      reason: 'missing-identifier',
    });
    expect(extractSessionUsage(null)).toEqual({ kind: 'ignored', reason: 'missing-identifier' });
    expect(extractSessionUsage('nope')).toEqual({
      kind: 'ignored',
      reason: 'missing-identifier',
    });
    expect(extractSessionUsage([])).toEqual({ kind: 'ignored', reason: 'missing-identifier' });
    expect(extractSessionUsage({ tokens: { input: 5 } })).toEqual({
      kind: 'ignored',
      reason: 'missing-identifier',
    });
    expect(extractSessionUsage({ sessionID: '' })).toEqual({
      kind: 'ignored',
      reason: 'missing-identifier',
    });
    expect(extractSessionUsage({ sessionID: 42, tokens: { input: 5 } })).toEqual({
      kind: 'ignored',
      reason: 'missing-identifier',
    });
  });

  it('ignores a payload that carries no usable usage field', () => {
    expect(extractSessionUsage({ sessionID: 'ses_v2' })).toEqual({
      kind: 'ignored',
      reason: 'no-usage-fields',
    });
    expect(extractSessionUsage({ sessionID: 'ses_v2', tokens: {} })).toEqual({
      kind: 'ignored',
      reason: 'no-usage-fields',
    });
  });

  it('accepts only finite, non-negative numbers', () => {
    const snapshot = recorded({
      sessionID: 'ses_v2',
      cost: -1,
      tokens: {
        input: Number.NaN,
        output: Number.POSITIVE_INFINITY,
        reasoning: '91',
        cache: { read: null, write: 4 },
      },
    });

    expect(snapshot.cost).toBeUndefined();
    expect(snapshot.input).toBeUndefined();
    expect(snapshot.output).toBeUndefined();
    // A numeric string is not a measurement.
    expect(snapshot.reasoning).toBeUndefined();
    expect(snapshot.cacheRead).toBeUndefined();
    expect(snapshot.cacheWrite).toBe(4);
  });

  it('never reads fields outside the supported set', () => {
    const snapshot = recorded(
      v2Usage({ prompt: 'do not retain me', text: 'nor me', directory: '/secret/path' }),
    );

    expect(Object.keys(snapshot).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'cost',
      'input',
      'output',
      'reasoning',
      'sessionId',
    ]);
    const serialized = snapshotValue(snapshot);
    expect(serialized).not.toContain('do not retain me');
    expect(serialized).not.toContain('/secret/path');
  });

  it('does not mutate the payload it reads', () => {
    const payload = deepFreeze(v2Usage());

    expect(() => recorded(payload)).not.toThrow();
  });

  it('shares the numeric rule with the V1 path', () => {
    expect(readUsageNumber(0)).toBe(0);
    expect(readUsageNumber(-0.5)).toBeUndefined();
    expect(readUsageNumber(Number.NaN)).toBeUndefined();
    expect(readUsageNumber('10')).toBeUndefined();
  });

  it('maps a snapshot onto the shared usage field names', () => {
    expect(sessionUsageFields(recorded(v2Usage()))).toEqual({
      input: 368,
      output: 75,
      reasoning: 91,
      cacheRead: 10496,
      cacheWrite: 0,
      cost: 0.0123,
    });
  });
});

describe('V2 snapshot comparison (evidence, not aggregation)', () => {
  const base: SessionUsageSnapshot = {
    sessionId: 'ses_v2',
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 1000,
    cacheWrite: 0,
    cost: 0.01,
  };

  it('reports no decrease for equal or growing values', () => {
    expect(compareSessionUsage(base, { ...base, input: 100, output: 80 })).toEqual({
      decreasedFields: 0,
      reportedNewFields: 0,
    });
  });

  it('reports a decrease, which is evidence against cumulative semantics', () => {
    expect(compareSessionUsage(base, { ...base, input: 40, output: 10 })).toEqual({
      decreasedFields: 2,
      reportedNewFields: 0,
    });
  });

  it('treats a field that went silent as silence, not as a decrease', () => {
    // Only `reasoning` is reported; every other field is absent, and absence is
    // not evidence of anything.
    const sparse: SessionUsageSnapshot = {
      sessionId: 'ses_v2',
      input: undefined,
      output: undefined,
      reasoning: 5,
      cacheRead: undefined,
      cacheWrite: undefined,
      cost: undefined,
    };

    expect(compareSessionUsage(base, sparse)).toEqual({ decreasedFields: 0, reportedNewFields: 0 });
  });

  it('treats a value that drops to zero as a decrease, and fields appearing as new', () => {
    const sparse: SessionUsageSnapshot = {
      sessionId: 'ses_v2',
      input: undefined,
      output: undefined,
      reasoning: 5,
      cacheRead: undefined,
      cacheWrite: undefined,
      cost: undefined,
    };

    // base reports 5 fields that the previous snapshot omitted (new evidence),
    // and `reasoning` falls from 5 to 0 (a real decrease).
    expect(compareSessionUsage(sparse, base)).toEqual({ decreasedFields: 1, reportedNewFields: 5 });
  });

  it('never returns a sum', () => {
    // A comparison has no numeric total to mistake for a session aggregate.
    expect(Object.keys(compareSessionUsage(base, base)).sort()).toEqual([
      'decreasedFields',
      'reportedNewFields',
    ]);
  });
});
