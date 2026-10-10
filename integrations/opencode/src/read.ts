import { READ_TARGET_ID_LENGTH } from './hash.js';

/**
 * Read-request identification for the OpenCode built-in `read` tool.
 *
 * Source-confirmed against OpenCode 1.18.35 (`packages/opencode/src/tool/read.ts`):
 * the tool parameters are `{ filePath: string, offset?: NonNegativeInt,
 * limit?: NonNegativeInt }`, the documented default offset is 1 and the
 * documented default limit is 2000. The adapter applies those defaults so an
 * explicit `offset: 1` and an omitted offset are treated as the same request.
 *
 * This module is pure: it computes an identity, it never reads a file, never
 * caches content, and never holds the raw path.
 */

/** Id of the OpenCode built-in read tool. */
export const READ_TOOL_ID = 'read';

/** Documented default offset for the read tool (1-indexed). */
export const DEFAULT_READ_OFFSET = 1;

/** Documented default limit for the read tool. */
export const DEFAULT_READ_LIMIT = 2000;

/** Static description of the identity scheme, surfaced in summaries. */
export const READ_IDENTITY_SCHEME =
  `hash(normalized file path, ${READ_TARGET_ID_LENGTH} hex characters) + read offset + read limit`;

/** Successful identification of a read request. */
export interface IdentifiedReadRequest {
  readonly identified: true;
  /** One-way identifier of the file; the raw path is discarded. */
  readonly targetId: string;
  /** Effective offset (documented default applied when absent). */
  readonly offset: number;
  /** Effective limit (documented default applied when absent). */
  readonly limit: number;
  /** True when offset or limit was present but not a usable non-negative integer. */
  readonly malformed: boolean;
  /** Identity of this exact request: target plus range. */
  readonly key: string;
}

/** A read request that could not be identified. */
export interface UnidentifiedReadRequest {
  readonly identified: false;
  readonly reason: 'missing-path';
}

export type ReadRequestIdentification = IdentifiedReadRequest | UnidentifiedReadRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a path only for identity purposes.
 *
 * Trims surrounding whitespace, converts Windows separators, and collapses
 * repeated separators so `src\\a.ts`, `src/a.ts` and `src//a.ts` share one
 * identity. It deliberately does **not** resolve symlinks, `..`, or case,
 * because doing so would require filesystem access and could merge genuinely
 * different targets.
 */
export function normalizeReadPath(filePath: string): string {
  const unified = filePath.trim().replace(/\\/g, '/');
  const collapsed = unified.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

interface RangeValue {
  readonly value: number;
  readonly malformed: boolean;
}

function readRangeValue(value: unknown, fallback: number): RangeValue {
  if (value === undefined || value === null) {
    return { value: fallback, malformed: false };
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return { value, malformed: false };
  }
  return { value: fallback, malformed: true };
}

/**
 * Identify a read request from tool arguments.
 *
 * Returns an unidentified result when the arguments carry no usable path, so the
 * caller can count the request without inventing a file identity. Never throws.
 */
export function identifyReadRequest(
  args: unknown,
  hash: (value: string) => string,
): ReadRequestIdentification {
  if (!isRecord(args)) {
    return { identified: false, reason: 'missing-path' };
  }
  const rawPath = args['filePath'];
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { identified: false, reason: 'missing-path' };
  }

  const offset = readRangeValue(args['offset'], DEFAULT_READ_OFFSET);
  const limit = readRangeValue(args['limit'], DEFAULT_READ_LIMIT);
  const targetId = hash(normalizeReadPath(rawPath));

  return {
    identified: true,
    targetId,
    offset: offset.value,
    limit: limit.value,
    malformed: offset.malformed || limit.malformed,
    key: `${targetId}:${offset.value}:${limit.value}`,
  };
}
