import { expect } from 'vitest';
import type {
  ObserverDiagnostic,
  ObserverOptions,
  OpenCodeObserverHooks,
  SessionObservationSummary,
} from '../src/index.js';
import { createOpenCodeObserver } from '../src/plugin.js';
import { OpenCodeObserver } from '../src/observer.js';

/**
 * Deterministic, non-cryptographic hasher for tests.
 *
 * Production uses SHA-256 truncated to 16 hex characters. Tests inject FNV-1a so
 * identities stay short while remaining one-way enough to prove that raw paths
 * never reach a summary.
 */
export function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface FakeClock {
  readonly now: () => number;
  readonly advance: (ms?: number) => void;
}

/** Clock with a fixed start so summaries are byte-for-byte reproducible. */
export function createFakeClock(start = 1_700_000_000_000, step = 1000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms = step) => {
      current += ms;
    },
  };
}

export interface ObservationHarness {
  readonly observer: OpenCodeObserver;
  readonly hooks: OpenCodeObserverHooks;
  readonly clock: FakeClock;
  readonly diagnostics: ObserverDiagnostic[];
  readonly before: (
    sessionID: string,
    tool: string,
    callID: string,
    args?: unknown,
  ) => Promise<void>;
  readonly after: (
    sessionID: string,
    tool: string,
    callID: string,
    args?: unknown,
    result?: { readonly title?: string; readonly output?: string; readonly metadata?: unknown },
  ) => Promise<void>;
  readonly event: (type: string, properties?: unknown) => Promise<void>;
  readonly summary: (sessionID: string) => SessionObservationSummary;
}

/**
 * Build a harness that drives the adapter through the real plugin hooks — the
 * same interface OpenCode calls — rather than through internal methods.
 */
export async function createObservationHarness(
  overrides: ObserverOptions = {},
): Promise<ObservationHarness> {
  const clock = createFakeClock();
  const diagnostics: ObserverDiagnostic[] = [];
  const { onDiagnostic: callerDiagnostic, hash, now, env, ...rest } = overrides;
  const created = createOpenCodeObserver({
    ...rest,
    // Defaults here keep tests deterministic and isolated: an explicit empty
    // environment stops a developer's real environment from enabling a summary
    // file or disabling the observer inside a test.
    hash: hash ?? fnv1aHex,
    now: now ?? clock.now,
    env: env ?? {},
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
      callerDiagnostic?.(diagnostic);
    },
  });
  const hooks = await created.plugin({}, undefined);

  const summary = (sessionID: string): SessionObservationSummary => {
    const found = created.observer.getSummary(sessionID);
    expect(found, `expected a summary for session ${sessionID}`).toBeDefined();
    return found as SessionObservationSummary;
  };

  return {
    observer: created.observer,
    hooks,
    clock,
    diagnostics,
    before: (sessionID, tool, callID, args) =>
      hooks['tool.execute.before']({ tool, sessionID, callID }, { args }),
    after: (sessionID, tool, callID, args, result) =>
      hooks['tool.execute.after'](
        { tool, sessionID, callID, args },
        {
          title: result?.title ?? '',
          output: result?.output ?? '',
          metadata: result?.metadata ?? {},
        },
      ),
    event: (type, properties) => hooks.event({ event: { type, properties } }),
    summary,
  };
}

/** Deep-freeze a value so an accidental mutation throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Snapshot that can be compared before and after a hook runs. */
export function snapshotValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item === undefined ? '__undefined__' : item));
}

/** Assert that none of the supplied secrets appear in a serialized value. */
export function expectNoSecrets(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(serialized, `expected the observation output to not contain ${secret}`).not.toContain(
      secret,
    );
  }
}
