/**
 * Pin of the OpenCode runtime the repository's wire evidence was produced
 * against, and the fail-closed decision built on it.
 *
 * ## Why this exists
 *
 * Dr. Token's Safe Mode wire evidence is only evidence for the runtime it was
 * measured on: "the pass reached the outbound request" is a fact about one
 * installed CLI, not about OpenCode in general. A regression check that silently
 * ran against a different (or missing) runtime would be worse than no check at
 * all, because it would report a stale conclusion as current.
 *
 * So the check is **fail-closed**: the experiment may run only when the runtime's
 * version, byte size and SHA-256 all match {@link PINNED_OPENCODE_RUNTIME}.
 * Anything else — missing, unreadable, a different version, a different digest,
 * or a digest that could not be computed — is a refusal, and a refusal means "do
 * not run the experiment and do not report a result".
 *
 * ## Why it is pure
 *
 * This module performs no I/O and reads no environment: the caller computes a
 * {@link RuntimeProbe} (hashing a file is the harness's job) and this module
 * decides. That keeps the plugin's no-filesystem rule intact, makes the decision
 * testable without an OpenCode installation, and leaves exactly one place where
 * the pin is interpreted.
 *
 * Not exported from the package entry point: nothing in the shipped plugin may
 * depend on a specific runtime being installed.
 */

/** What the installed runtime was found to be. Absent fields mean "not readable". */
export interface RuntimeProbe {
  /** Version reported by the runtime, e.g. `2.0.24`. */
  readonly version: string | undefined;
  /** Lower-case hex SHA-256 of the runtime binary. */
  readonly sha256: string | undefined;
  /** Size of the runtime binary in bytes. */
  readonly bytes: number | undefined;
  /** True when the runtime file was found at all. */
  readonly exists: boolean;
}

/** The one runtime revision this repository's wire evidence covers. */
export const PINNED_OPENCODE_RUNTIME = {
  /** Product the pin refers to, for readable diagnostics. */
  product: 'OpenCode Desktop (opencode-cli)',
  /** Runtime version, as reported by the runtime itself and by its version file. */
  version: '2.0.24',
  /** SHA-256 of the binary the Stage 1T/1U experiments were run against. */
  sha256: '37cafb7e6f9f80ae3d198dc5a248d9b8c24fde58b96cf865f823c633cb4d37fc',
  /** Size of that binary in bytes. */
  bytes: 206_128_008,
} as const;

/**
 * Outcome of checking an installation against the pin.
 *
 * `verified` is the only outcome that permits the wire experiment to run; every
 * other outcome is a refusal with the reason it could not be verified.
 */
export type RuntimePinVerdict =
  | { readonly kind: 'verified'; readonly version: string }
  | { readonly kind: 'missing'; readonly note: string }
  | {
      readonly kind: 'version-mismatch';
      readonly expected: string;
      readonly observed: string | undefined;
    }
  | {
      readonly kind: 'digest-mismatch';
      readonly expectedSha256: string;
      readonly observedSha256: string | undefined;
      readonly expectedBytes: number;
      readonly observedBytes: number | undefined;
    };

/**
 * Decide whether an installation may be used for the wire experiment.
 *
 * Every check is exact. A probe field that is `undefined` (unreadable) is never
 * treated as a match, and the digest is compared case-insensitively after
 * trimming, because hex case carries no information.
 */
export function verifyPinnedRuntime(probe: RuntimeProbe): RuntimePinVerdict {
  if (!probe.exists) {
    return {
      kind: 'missing',
      note: `No ${PINNED_OPENCODE_RUNTIME.product} runtime was found, so the wire experiment cannot be run against the pinned revision.`,
    };
  }

  const observedVersion = typeof probe.version === 'string' ? probe.version.trim() : undefined;
  if (observedVersion !== PINNED_OPENCODE_RUNTIME.version) {
    return {
      kind: 'version-mismatch',
      expected: PINNED_OPENCODE_RUNTIME.version,
      observed: observedVersion,
    };
  }

  const observedSha256 = typeof probe.sha256 === 'string' ? probe.sha256.trim().toLowerCase() : undefined;
  const bytesMatch =
    typeof probe.bytes === 'number' && probe.bytes === PINNED_OPENCODE_RUNTIME.bytes;
  if (
    observedSha256 !== PINNED_OPENCODE_RUNTIME.sha256 ||
    !bytesMatch
  ) {
    return {
      kind: 'digest-mismatch',
      expectedSha256: PINNED_OPENCODE_RUNTIME.sha256,
      observedSha256,
      expectedBytes: PINNED_OPENCODE_RUNTIME.bytes,
      observedBytes: probe.bytes,
    };
  }

  return { kind: 'verified', version: observedVersion };
}

/** True only for an exact match. The single gate the harness consults. */
export function isPinnedRuntimeVerified(verdict: RuntimePinVerdict): boolean {
  return verdict.kind === 'verified';
}

/**
 * A content-free explanation of a refusal.
 *
 * It names versions, digests and sizes — all of which are properties of an
 * installed program, never of a request or a session — and never claims the
 * runtime is wrong, only that it is not the revision this evidence covers.
 */
export function describeRuntimeRefusal(verdict: RuntimePinVerdict): string {
  switch (verdict.kind) {
    case 'verified':
      return `The runtime matches the pinned ${PINNED_OPENCODE_RUNTIME.product} ${PINNED_OPENCODE_RUNTIME.version} (SHA-256 ${PINNED_OPENCODE_RUNTIME.sha256}).`;
    case 'missing':
      return verdict.note;
    case 'version-mismatch':
      return `The installed ${PINNED_OPENCODE_RUNTIME.product} is version ${verdict.observed ?? 'unknown'}, but this evidence covers only ${verdict.expected}; refusing to run rather than report a stale conclusion.`;
    case 'digest-mismatch':
      return `The installed ${PINNED_OPENCODE_RUNTIME.product} ${PINNED_OPENCODE_RUNTIME.version} does not match the pinned binary (expected SHA-256 ${verdict.expectedSha256} / ${verdict.expectedBytes} bytes, observed ${verdict.observedSha256 ?? 'unreadable'} / ${verdict.observedBytes ?? 'unreadable'} bytes); refusing to run against an unverified runtime.`;
  }
}
