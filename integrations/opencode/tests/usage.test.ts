import { describe, expect, it } from 'vitest';
import {
  extractAssistantUsage,
  mergeUsageSnapshots,
  readUsageNumber,
  reportedUsageFieldCount,
} from '../src/index.js';
import type { MessageUsageSnapshot, UsageExtraction } from '../src/index.js';

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_1',
    sessionID: 'ses_1',
    role: 'assistant',
    cost: 0.0123,
    tokens: {
      input: 1200,
      output: 300,
      reasoning: 64,
      cache: { read: 800, write: 120 },
    },
    ...overrides,
  };
}

function recorded(extraction: UsageExtraction): MessageUsageSnapshot {
  if (extraction.kind !== 'recorded') {
    throw new Error('expected a recorded usage snapshot');
  }
  return extraction.snapshot;
}

describe('assistant usage extraction', () => {
  it('records every field of a complete assistant message', () => {
    const snapshot = recorded(extractAssistantUsage(assistant()));

    expect(snapshot).toMatchObject({
      messageId: 'msg_1',
      sessionId: 'ses_1',
      input: 1200,
      output: 300,
      reasoning: 64,
      cacheRead: 800,
      cacheWrite: 120,
      cost: 0.0123,
    });
  });

  it('accepts providers that report only some fields', () => {
    const extraction = extractAssistantUsage(
      assistant({ tokens: { input: 10, output: 4, reasoning: 0 }, cost: 0.001 }),
    );
    const snapshot = recorded(extraction);

    expect(snapshot.input).toBe(10);
    expect(snapshot.output).toBe(4);
    expect(snapshot.reasoning).toBe(0);
    expect(snapshot.cacheRead).toBeUndefined();
    expect(snapshot.cacheWrite).toBeUndefined();
  });

  it('treats zero as a real measurement rather than a missing value', () => {
    const snapshot = recorded(
      extractAssistantUsage(assistant({ tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0 })),
    );

    expect(reportedUsageFieldCount(snapshot)).toBe(4);
  });

  it('never derives a combined total', () => {
    const snapshot = recorded(extractAssistantUsage(assistant()));

    expect(Object.keys(snapshot).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'cost',
      'input',
      'messageId',
      'output',
      'reasoning',
      'sessionId',
    ]);
  });

  it('ignores user messages', () => {
    expect(extractAssistantUsage({ id: 'msg_2', sessionID: 'ses_1', role: 'user' })).toEqual({
      kind: 'ignored',
      reason: 'not-an-assistant-message',
    });
  });

  it('ignores unusable shapes', () => {
    for (const value of [undefined, null, 'assistant', 7, []]) {
      expect(extractAssistantUsage(value).kind).toBe('ignored');
    }
  });

  it('ignores an assistant message without usable identifiers', () => {
    expect(extractAssistantUsage(assistant({ id: '' }))).toEqual({
      kind: 'ignored',
      reason: 'missing-identifier',
    });
    expect(extractAssistantUsage(assistant({ sessionID: 42 }))).toEqual({
      kind: 'ignored',
      reason: 'missing-identifier',
    });
  });

  it('ignores a message that carries no usable usage field', () => {
    expect(extractAssistantUsage(assistant({ tokens: undefined, cost: undefined }))).toEqual({
      kind: 'ignored',
      reason: 'no-usage-fields',
    });
    expect(extractAssistantUsage(assistant({ tokens: {}, cost: undefined }))).toEqual({
      kind: 'ignored',
      reason: 'no-usage-fields',
    });
  });

  it('rejects malformed token values instead of guessing', () => {
    const extraction = extractAssistantUsage(
      assistant({
        tokens: {
          input: -5,
          output: 'many',
          reasoning: Number.NaN,
          cache: { read: Number.POSITIVE_INFINITY, write: null },
        },
        cost: -1,
      }),
    );

    expect(extraction).toEqual({ kind: 'ignored', reason: 'no-usage-fields' });
  });

  it('keeps usable fields when other fields are malformed', () => {
    const snapshot = recorded(
      extractAssistantUsage(assistant({ tokens: { input: 12, output: 'lots' } })),
    );

    expect(snapshot.input).toBe(12);
    expect(snapshot.output).toBeUndefined();
  });

  it('validates numbers through readUsageNumber', () => {
    expect(readUsageNumber(0)).toBe(0);
    expect(readUsageNumber(1.5)).toBe(1.5);
    expect(readUsageNumber(-0.1)).toBeUndefined();
    expect(readUsageNumber(Number.NaN)).toBeUndefined();
    expect(readUsageNumber('12')).toBeUndefined();
    expect(readUsageNumber(undefined)).toBeUndefined();
  });
});

describe('usage snapshot merging', () => {
  const base = recorded(extractAssistantUsage(assistant()));

  it('reports no regression for an identical repeated update', () => {
    const merge = mergeUsageSnapshots(base, base);

    expect(merge.regressed).toBe(false);
    expect(merge.snapshot).toEqual(base);
  });

  it('adopts higher values from a later update', () => {
    const later = recorded(
      extractAssistantUsage(assistant({ tokens: { input: 1500, output: 300 }, cost: 0.02 })),
    );
    const merge = mergeUsageSnapshots(base, later);

    expect(merge.regressed).toBe(false);
    expect(merge.snapshot.input).toBe(1500);
    expect(merge.snapshot.cost).toBe(0.02);
    expect(merge.snapshot.reasoning).toBe(64);
  });

  it('keeps the higher value and flags a regression when an update reports less', () => {
    const stale = recorded(
      extractAssistantUsage(assistant({ tokens: { input: 10, output: 5 }, cost: 0.0001 })),
    );
    const merge = mergeUsageSnapshots(base, stale);

    expect(merge.regressed).toBe(true);
    expect(merge.snapshot.input).toBe(1200);
    expect(merge.snapshot.output).toBe(300);
    expect(merge.snapshot.cost).toBe(0.0123);
  });

  it('treats a regression with no comparable fields as no regression', () => {
    const empty = recorded(extractAssistantUsage(assistant({ tokens: { reasoning: 5 } })));
    const merge = mergeUsageSnapshots(
      recorded(extractAssistantUsage(assistant({ tokens: undefined }))),
      empty,
    );

    expect(merge.regressed).toBe(false);
    expect(merge.snapshot.reasoning).toBe(5);
  });
});
