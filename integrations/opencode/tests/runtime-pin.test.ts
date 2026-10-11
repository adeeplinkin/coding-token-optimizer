import { describe, expect, it } from 'vitest';
import {
  PINNED_OPENCODE_RUNTIME,
  describeRuntimeRefusal,
  isPinnedRuntimeVerified,
  verifyPinnedRuntime,
} from '../src/runtime-pin.js';
import type { RuntimeProbe } from '../src/runtime-pin.js';

/**
 * The pin's fail-closed rule, tested without an OpenCode installation.
 *
 * The point of these tests is not the happy path — it is that *nothing else*
 * passes: a missing runtime, an unreadable hash, a different patch version and a
 * same-version-different-binary each refuse, so the wire experiment can never run
 * against a revision whose evidence does not exist.
 */

/** A probe that exactly matches the pin, with per-test overrides. */
function matchingProbe(overrides: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    exists: true,
    version: PINNED_OPENCODE_RUNTIME.version,
    sha256: PINNED_OPENCODE_RUNTIME.sha256,
    bytes: PINNED_OPENCODE_RUNTIME.bytes,
    ...overrides,
  };
}

describe('the pinned runtime', () => {
  it('pins a version, a digest and a size, and nothing weaker', () => {
    expect(PINNED_OPENCODE_RUNTIME.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PINNED_OPENCODE_RUNTIME.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(PINNED_OPENCODE_RUNTIME.bytes)).toBe(true);
    expect(PINNED_OPENCODE_RUNTIME.bytes).toBeGreaterThan(0);
  });

  it('verifies an exact match, case-insensitively and trimmed', () => {
    const verdict = verifyPinnedRuntime(
      matchingProbe({ sha256: `  ${PINNED_OPENCODE_RUNTIME.sha256.toUpperCase()}  ` }),
    );

    expect(verdict.kind).toBe('verified');
    expect(isPinnedRuntimeVerified(verdict)).toBe(true);
    expect(describeRuntimeRefusal(verdict)).toContain(PINNED_OPENCODE_RUNTIME.version);
  });
});

describe('the runtime pin fails closed', () => {
  const refusals: readonly (readonly [string, RuntimeProbe])[] = [
    ['a missing runtime', matchingProbe({ exists: false })],
    ['an unreadable version', matchingProbe({ version: undefined })],
    ['an empty version', matchingProbe({ version: '' })],
    ['a different patch version', matchingProbe({ version: '2.0.23' })],
    ['a newer minor version', matchingProbe({ version: '2.1.0' })],
    ['a prerelease of the same version', matchingProbe({ version: '2.0.24-beta.1' })],
    ['an unreadable digest', matchingProbe({ sha256: undefined })],
    ['the same version with a different binary', matchingProbe({ sha256: 'f'.repeat(64) })],
    ['a truncated digest', matchingProbe({ sha256: PINNED_OPENCODE_RUNTIME.sha256.slice(0, 32) })],
    ['an unreadable size', matchingProbe({ bytes: undefined })],
    ['a different size with the pinned digest', matchingProbe({ bytes: PINNED_OPENCODE_RUNTIME.bytes + 1 })],
  ];

  it.each(refusals)('refuses %s', (_label, probe) => {
    const verdict = verifyPinnedRuntime(probe);

    expect(verdict.kind).not.toBe('verified');
    expect(isPinnedRuntimeVerified(verdict)).toBe(false);
    expect(describeRuntimeRefusal(verdict).length).toBeGreaterThan(0);
  });

  it('names what it observed when the version differs', () => {
    const verdict = verifyPinnedRuntime(matchingProbe({ version: '2.0.23' }));

    expect(verdict).toEqual({
      kind: 'version-mismatch',
      expected: PINNED_OPENCODE_RUNTIME.version,
      observed: '2.0.23',
    });
  });

  it('names both digests and sizes when the binary differs', () => {
    const verdict = verifyPinnedRuntime(
      matchingProbe({ sha256: 'a'.repeat(64), bytes: 1 }),
    );

    expect(verdict).toEqual({
      kind: 'digest-mismatch',
      expectedSha256: PINNED_OPENCODE_RUNTIME.sha256,
      observedSha256: 'a'.repeat(64),
      expectedBytes: PINNED_OPENCODE_RUNTIME.bytes,
      observedBytes: 1,
    });
    expect(describeRuntimeRefusal(verdict)).toContain('refusing to run');
  });

  it('never reports a verification it did not perform', () => {
    // The decision is a pure function of the probe: a caller that supplies an
    // unreadable probe cannot obtain a `verified` verdict by omission.
    expect(verifyPinnedRuntime({ exists: true, version: undefined, sha256: undefined, bytes: undefined }))
      .toMatchObject({ kind: 'version-mismatch' });
  });
});
