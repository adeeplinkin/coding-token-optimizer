import { createHash } from 'node:crypto';

/**
 * Number of hexadecimal characters kept from the SHA-256 digest of a read target.
 *
 * 16 characters (64 bits) is short enough for readable reports and far longer
 * than needed to distinguish the handful of files a session can read, while
 * keeping the digest one-way.
 */
export const READ_TARGET_ID_LENGTH = 16;

/**
 * Default read-identity hasher.
 *
 * `node:crypto` is available in both Node.js and Bun (the OpenCode plugin
 * runtime). The observer never stores the value passed in — only the digest —
 * so file paths do not survive in memory or in summaries.
 */
export function defaultHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, READ_TARGET_ID_LENGTH);
}

/** Check that a value looks like an identifier produced by {@link defaultHash}. */
export function isHexDigestLike(value: string): boolean {
  return value.length === READ_TARGET_ID_LENGTH && /^[0-9a-f]+$/.test(value);
}
