import { createHash } from 'node:crypto';

/**
 * One-way identifiers for the Codex observer.
 *
 * The same scheme the OpenCode adapter uses — SHA-256 truncated to 16 hex
 * characters — so evidence from both adapters is comparable and, more
 * importantly, so no raw path or directory can ever reach a summary. The scheme
 * is duplicated here rather than imported across adapter packages: the hook entry
 * point runs once per tool call, and pulling another adapter's whole module graph
 * into that path would cost more than four lines of hashing.
 */

/** Number of hexadecimal characters kept from the SHA-256 digest of an identity. */
export const IDENTITY_LENGTH = 16;

/**
 * Default hasher for read targets and working directories.
 *
 * The caller never stores the value passed in — only the digest — so file paths
 * and directories do not survive in memory or on disk.
 */
export function defaultHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, IDENTITY_LENGTH);
}

/** Check that a value looks like an identifier produced by {@link defaultHash}. */
export function isDigestLike(value: string): boolean {
  return value.length === IDENTITY_LENGTH && /^[0-9a-f]+$/.test(value);
}

/**
 * Normalize a path only for identity purposes.
 *
 * Trims surrounding whitespace, unifies Windows separators, and collapses
 * repeated separators so `src\\a.ts`, `src/a.ts` and `src//a.ts` share one
 * identity. It deliberately does **not** resolve symlinks, `..`, or case:
 * doing so would require filesystem access and could merge genuinely different
 * targets.
 */
export function normalizePath(value: string): string {
  const unified = value.trim().replace(/\\/g, '/');
  const collapsed = unified.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}
