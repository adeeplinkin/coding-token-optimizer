import { USAGE_FIELDS } from './types.js';
import type { UsageField } from './types.js';

/**
 * Token and cost observation for OpenCode assistant messages.
 *
 * Source-confirmed against OpenCode 1.18.35: an assistant message carries
 * `cost: number` and `tokens: { input, output, reasoning, cache: { read, write } }`,
 * and `message.updated` delivers it as `event.properties.info`
 * (`AssistantMessage` — `role: "assistant"`).
 *
 * Rules this module enforces:
 * - a value must be a finite, non-negative number to count as available;
 * - every field is optional, because providers do not all report all of them;
 * - the fields are never summed into a single total, because `reasoning` and the
 *   cache fields overlap with `output`/`input` in ways OpenCode does not
 *   document; an invented total would be a fabricated measurement.
 */

/**
 * A validated usage record for one assistant message. Absent fields are `undefined`.
 */
export interface MessageUsageSnapshot {
  readonly messageId: string;
  readonly sessionId: string;
  readonly input: number | undefined;
  readonly output: number | undefined;
  readonly reasoning: number | undefined;
  readonly cacheRead: number | undefined;
  readonly cacheWrite: number | undefined;
  readonly cost: number | undefined;
}

/** Why a `message.updated` event did not produce a usage record. */
export type UsageIgnoredReason =
  | 'not-an-assistant-message'
  | 'missing-identifier'
  | 'no-usage-fields';

export type UsageExtraction =
  | { readonly kind: 'recorded'; readonly snapshot: MessageUsageSnapshot }
  | { readonly kind: 'ignored'; readonly reason: UsageIgnoredReason };

/** Result of folding a new update into an existing record. */
export interface UsageMerge {
  readonly snapshot: MessageUsageSnapshot;
  /** True when the update reported a lower value than the recorded one. */
  readonly regressed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept only finite, non-negative numbers. Anything else is not a measurement. */
export function readUsageNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function readField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (record === undefined) {
    return undefined;
  }
  return readUsageNumber(record[key]);
}

/**
 * Extract a usage record from an `AssistantMessage`.
 *
 * A value is never guessed: a malformed or missing field stays `undefined`, and
 * a message that carries no usable field at all produces no record.
 */
export function extractAssistantUsage(info: unknown): UsageExtraction {
  if (!isRecord(info) || info['role'] !== 'assistant') {
    return { kind: 'ignored', reason: 'not-an-assistant-message' };
  }

  const messageId = info['id'];
  const sessionId = info['sessionID'];
  if (
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0
  ) {
    return { kind: 'ignored', reason: 'missing-identifier' };
  }

  const tokens = isRecord(info['tokens']) ? info['tokens'] : undefined;
  const cache = tokens !== undefined && isRecord(tokens['cache']) ? tokens['cache'] : undefined;

  const input = readField(tokens, 'input');
  const output = readField(tokens, 'output');
  const reasoning = readField(tokens, 'reasoning');
  const cacheRead = readField(cache, 'read');
  const cacheWrite = readField(cache, 'write');
  const cost = readUsageNumber(info['cost']);

  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    cost === undefined
  ) {
    return { kind: 'ignored', reason: 'no-usage-fields' };
  }

  return {
    kind: 'recorded',
    snapshot: {
      messageId,
      sessionId,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cost,
    },
  };
}

/** How many fields of a record hold a usable value. */
export function reportedUsageFieldCount(snapshot: MessageUsageSnapshot): number {
  return USAGE_FIELDS.filter((field) => snapshot[field] !== undefined).length;
}

function pickHigher(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return Math.max(a, b);
}

function isLower(next: number | undefined, previous: number | undefined): boolean {
  return next !== undefined && previous !== undefined && next < previous;
}

/* -------------------------------------------------------------------------- */
/* V2 usage events                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A validated **V2 session usage snapshot**, exactly as the source reported it.
 *
 * Stage 1G observed this payload in OpenCode Desktop 2.0.24 for the
 * `session.usage.updated` event, delivered under `event.data` (V1 uses
 * `event.properties`):
 *
 *   { id, created, type, data: { sessionID, cost,
 *       tokens: { input, output, reasoning, cache: { read, write } } } }
 *
 * The payload carries **no message identifier**, so it cannot be attributed to a
 * single assistant message the way a V1 `message.updated` record can.
 *
 * Aggregation semantics are **unverified**: nothing observed so far establishes
 * whether each event carries an increment, a cumulative session total, or a
 * per-request snapshot. This type therefore preserves the source's numbers and
 * makes no claim about what they are, and no code path sums them.
 */
export interface SessionUsageSnapshot {
  readonly sessionId: string;
  readonly input: number | undefined;
  readonly output: number | undefined;
  readonly reasoning: number | undefined;
  readonly cacheRead: number | undefined;
  readonly cacheWrite: number | undefined;
  readonly cost: number | undefined;
}

/** Why a V2 `session.usage.updated` event produced no snapshot. */
export type SessionUsageIgnoredReason = 'missing-identifier' | 'no-usage-fields';

export type SessionUsageExtraction =
  | { readonly kind: 'recorded'; readonly snapshot: SessionUsageSnapshot }
  | { readonly kind: 'ignored'; readonly reason: SessionUsageIgnoredReason };

/** The six usage fields of a V2 snapshot, keyed by the shared field names. */
export function sessionUsageFields(
  snapshot: SessionUsageSnapshot,
): Readonly<Record<UsageField, number | undefined>> {
  return {
    input: snapshot.input,
    output: snapshot.output,
    reasoning: snapshot.reasoning,
    cacheRead: snapshot.cacheRead,
    cacheWrite: snapshot.cacheWrite,
    cost: snapshot.cost,
  };
}

/** What comparing two consecutive V2 snapshots establishes. */
export interface SessionUsageComparison {
  /** Fields that reported a lower value than the previous snapshot. */
  readonly decreasedFields: number;
  /** A field reported a value while the previous snapshot did not. */
  readonly reportedNewFields: number;
}

/**
 * Compare a newer V2 snapshot with the previous one.
 *
 * This is **evidence gathering, not aggregation**. A field that decreases is
 * evidence against "each event carries a cumulative session total"; fields that
 * only ever grow are consistent with it but do not prove it (per-request
 * increments after the first are also non-negative). Nothing here adds values
 * together, and the result is only used to label uncertainty honestly.
 *
 * A field absent from either snapshot is skipped: silence is not a decrease.
 */
export function compareSessionUsage(
  previous: SessionUsageSnapshot,
  incoming: SessionUsageSnapshot,
): SessionUsageComparison {
  let decreasedFields = 0;
  let reportedNewFields = 0;
  for (const field of USAGE_FIELDS) {
    const before = previous[field];
    const after = incoming[field];
    if (after === undefined) {
      continue;
    }
    if (before === undefined) {
      reportedNewFields += 1;
      continue;
    }
    if (after < before) {
      decreasedFields += 1;
    }
  }
  return { decreasedFields, reportedNewFields };
}

/**
 * Extract a V2 session usage snapshot from an event payload.
 *
 * Only the six documented fields are read, and each must be a finite,
 * non-negative number to count — the same rule the V1 path applies, reused so
 * both lines validate identically. A value is never guessed, an unsupported
 * field is never read, and no unrelated event content is retained.
 */
export function extractSessionUsage(payload: unknown): SessionUsageExtraction {
  if (!isRecord(payload)) {
    return { kind: 'ignored', reason: 'missing-identifier' };
  }
  const sessionId = payload['sessionID'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { kind: 'ignored', reason: 'missing-identifier' };
  }

  const tokens = isRecord(payload['tokens']) ? payload['tokens'] : undefined;
  const cache = tokens !== undefined && isRecord(tokens['cache']) ? tokens['cache'] : undefined;

  const input = readField(tokens, 'input');
  const output = readField(tokens, 'output');
  const reasoning = readField(tokens, 'reasoning');
  const cacheRead = readField(cache, 'read');
  const cacheWrite = readField(cache, 'write');
  const cost = readUsageNumber(payload['cost']);

  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    cost === undefined
  ) {
    return { kind: 'ignored', reason: 'no-usage-fields' };
  }

  return {
    kind: 'recorded',
    snapshot: { sessionId, input, output, reasoning, cacheRead, cacheWrite, cost },
  };
}

/**
 * Fold a newer usage snapshot into the recorded one.
 *
 * OpenCode may publish a message several times while it streams. Only one record
 * per message id is kept, so the same snapshot can never be counted twice. For
 * each field, the higher observed value is retained: a field only ever becomes
 * non-zero once the provider reports it, and a lower value is therefore treated
 * as a stale or partial update rather than a correction. Lower values are still
 * signalled through `regressed` so the frequency is visible.
 */
export function mergeUsageSnapshots(
  previous: MessageUsageSnapshot,
  incoming: MessageUsageSnapshot,
): UsageMerge {
  const regressed =
    isLower(incoming.input, previous.input) ||
    isLower(incoming.output, previous.output) ||
    isLower(incoming.reasoning, previous.reasoning) ||
    isLower(incoming.cacheRead, previous.cacheRead) ||
    isLower(incoming.cacheWrite, previous.cacheWrite) ||
    isLower(incoming.cost, previous.cost);

  return {
    snapshot: {
      messageId: incoming.messageId,
      sessionId: incoming.sessionId,
      input: pickHigher(previous.input, incoming.input),
      output: pickHigher(previous.output, incoming.output),
      reasoning: pickHigher(previous.reasoning, incoming.reasoning),
      cacheRead: pickHigher(previous.cacheRead, incoming.cacheRead),
      cacheWrite: pickHigher(previous.cacheWrite, incoming.cacheWrite),
      cost: pickHigher(previous.cost, incoming.cost),
    },
    regressed,
  };
}
