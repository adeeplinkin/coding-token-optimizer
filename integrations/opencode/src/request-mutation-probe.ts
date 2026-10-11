/**
 * OpenCode V2 **request-mutation probe** (Stage 1R) — a validation aid, **not part of the product**.
 *
 * It exists to answer one question with runtime evidence: does the installed OpenCode 2.0.24 runtime
 * actually send the value a plugin writes into the assembled request inside
 * `ctx.session.hook("context")`? Stage 1P proved the *delivery* half (the callback fires during
 * assembly with the complete request); this probe is the influence half. It is deliberately separate
 * from the shipped adapter and from `request-probe.ts`, and it is **never exported from the package
 * entry point**, so loading the product cannot enable it.
 *
 * *** THIS MODULE CAN MODIFY AN ASSEMBLED REQUEST WHEN EXPLICITLY ENABLED. ***
 *
 * Guarantees, in the order they matter:
 *
 * 1. **Disabled by default.** Mutation happens only when *both* conditions hold: the caller supplies a
 *    `mutation` configuration (`original` + `replacement`), **and** the environment switch is exactly
 *    `mutate`. With no configuration, or with any other value (including unset), the probe only
 *    records. The switch value `off`/`false`/`0`/`no`/`disabled` registers nothing at all.
 * 2. **Exactly one substitution, synthetic content only.** The only assignment in this module is
 *    `part.result.value = <text with one occurrence replaced>` on a `tool-result` part whose
 *    `result.type` is `text` and whose value is a string containing the configured `original`
 *    **exactly once in the whole request**. Zero occurrences, more than one part, or more than one
 *    occurrence per part all refuse the edit and record why. Nothing else — not `system`, not
 *    `options` (model settings), not `tools`, not `agent`, not permissions, not tool-call inputs — is
 *    ever assigned to, deleted or redefined.
 * 3. **Content-free.** Records carry counts, key *names*, booleans, lengths and one-way digests —
 *    never prompt text, tool-result content, file paths, URLs, header values or request bodies. The
 *    three marker booleans are computed only when the caller has already named those exact strings in
 *    the mutation configuration, and the body itself is never stored.
 * 4. **Bounded and fail-open.** Every scan is capped, the record set is capped, and every hook body is
 *    wrapped: a failure is counted as a content-free diagnostic and never thrown into the host.
 * 5. **Bypassable.** `enabled: false` or the environment switch registers nothing.
 *
 * The probe reads **no environment of its own**: the caller passes the environment in (`options.env`),
 * which keeps this module a pure function of its options and preserves the source guard's rule that
 * only the observer module reads `process.env`. The validation harness supplies it.
 */
import { analyseRequest, DEFAULT_REQUEST_PROBE_LIMITS, defaultProbeHash } from './request-probe.js';
import type { RequestAnalysis, RequestProbeLimits } from './request-probe.js';

/** Default caps. Large enough to observe any real request, small enough to bound one. */
export const DEFAULT_MUTATION_PROBE_LIMITS = {
  /** Messages examined per request. */
  maxMessages: 4_000,
  /** Content parts examined per message. */
  maxPartsPerMessage: 500,
  /** Tool-result payloads examined per request. */
  maxTextResultsScanned: 500,
  /** Characters taken from a single payload. */
  maxCharsPerPayload: 1_000_000,
  /** Total characters examined per request, across all payloads. */
  maxTotalChars: 4_000_000,
  /** Occurrences counted inside one payload before it is treated as ambiguous. */
  maxOccurrencesPerText: 64,
  /** Records the probe will emit for one process. */
  maxRecords: 2_000,
} as const;

export interface MutationProbeLimits {
  readonly maxMessages: number;
  readonly maxPartsPerMessage: number;
  readonly maxTextResultsScanned: number;
  readonly maxCharsPerPayload: number;
  readonly maxTotalChars: number;
  readonly maxOccurrencesPerText: number;
  readonly maxRecords: number;
}

/**
 * Environment switch that governs the probe.
 *
 * - `mutate` — mutation is permitted (still requires a `mutation` configuration).
 * - `off` / `false` / `0` / `no` / `disabled` — the probe registers nothing.
 * - anything else, including unset — observe only. **This is the default.**
 */
export const MUTATION_PROBE_ENV = 'DR_TOKEN_M2_PROBE';
/**
 * Environment switch naming where content-free evidence records are appended.
 *
 * Used by the validation harness, not by this module (the module takes an injected `sink`).
 */
export const MUTATION_PROBE_EVIDENCE_ENV = 'DR_TOKEN_M2_PROBE_EVIDENCE';

/** Stable id used in the `Plugin`-shaped registration. */
export const MUTATION_PROBE_PLUGIN_ID = 'dr-token-m2-mutation-probe';

/** The in-place edit the probe is allowed to make, and only in `mutate` mode. */
export interface MutationProbeMutation {
  /** Exact synthetic string to find. Must occur exactly once in the request to be edited. */
  readonly original: string;
  /** Exact synthetic string to substitute. Must differ from `original`. */
  readonly replacement: string;
}

/** How the probe is running. `mutate` is never the default. */
export type MutationProbeMode = 'observe' | 'mutate';

/** Capabilities the probe records, and whether the host exposed them. */
export interface MutationProbeCapabilities {
  readonly sessionHook: boolean;
  readonly sessionContextHook: boolean;
  readonly httpRequestHook: boolean;
}

/**
 * Why an edit was refused. Content-free by construction.
 *
 * There is deliberately no "not configured" reason: `mode` is only ever `mutate` when a
 * configuration is present, so "no configuration" cannot be a refusal — it is simply observation.
 */
export type MutationRefusalReason =
  | 'invalid-config'
  | 'target-absent'
  | 'target-ambiguous'
  | 'target-occurrences-not-unique'
  | 'assignment-failed';

/** Evidence kinds. All content-free by construction. */
export type MutationProbeRecord =
  | {
      readonly kind: 'probe-start';
      readonly at: string;
      readonly pluginId: string;
      readonly mode: MutationProbeMode;
      readonly mutationConfigured: boolean;
      readonly capabilities: MutationProbeCapabilities;
    }
  | {
      readonly kind: 'context';
      readonly at: string;
      readonly invocation: number;
      readonly sessionHash: string;
      readonly mode: MutationProbeMode;
      /** Key *names* of the callback payload — the evidence that the context payload has no `kind`. */
      readonly outerKeys: readonly string[];
      readonly outerHasContext: boolean;
      /** The payload's own `kind` member when it is a string, else `null`. */
      readonly outerKind: string | null;
      readonly messages: number;
      readonly parts: number;
      readonly toolResultParts: number;
      readonly stringTextResults: number;
      readonly targetParts: number;
      readonly targetOccurrences: number;
      readonly mutationAttempted: boolean;
      readonly mutationApplied: boolean;
      readonly refusalReason: MutationRefusalReason | null;
      readonly textBeforeLength: number | null;
      readonly textAfterLength: number | null;
      readonly analysis: RequestAnalysis;
    }
  | {
      readonly kind: 'http-request';
      readonly at: string;
      readonly invocation: number;
      readonly requestKind: string;
      readonly urlIsString: boolean;
      readonly headerCount: number;
      /** `typeof`/constructor name of the outbound body, e.g. `string`, `Uint8Array`, `absent`. */
      readonly bodyType: string;
      readonly bodyLength: number | null;
      /** Marker booleans — populated only when the caller named the markers. */
      readonly bodyHasOriginal: boolean | null;
      readonly bodyHasReplacement: boolean | null;
    }
  | { readonly kind: 'unsupported'; readonly at: string; readonly capability: string }
  | { readonly kind: 'internal-error'; readonly at: string; readonly code: string }
  | { readonly kind: 'records-capped'; readonly at: string; readonly emitted: number }
  | { readonly kind: 'bypassed'; readonly at: string; readonly reason: string }
  | { readonly kind: 'cleanup'; readonly at: string; readonly disposed: number };

/** Observable counters, exposed for tests and for a caller that wants a live view. */
export interface MutationProbeEvidence {
  readonly records: readonly MutationProbeRecord[];
  readonly contextInvocations: number;
  readonly httpRequestInvocations: number;
  readonly mutationsApplied: number;
  readonly mutationsAttempted: number;
  readonly internalErrors: number;
  readonly unsupported: readonly string[];
  readonly capped: boolean;
  readonly mode: MutationProbeMode;
  readonly capabilities: MutationProbeCapabilities;
}

export interface MutationProbeOptions {
  /** `false` disables the probe: `setup` registers nothing. */
  readonly enabled?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where records go. Omitting it keeps everything in memory (tests, dry runs). */
  readonly sink?: (record: MutationProbeRecord) => void | Promise<void>;
  /** One-way hasher for session identifiers. Defaults to SHA-256 truncated to 16 hex characters. */
  readonly hash?: (value: string) => string;
  readonly now?: () => number;
  readonly limits?: Partial<MutationProbeLimits>;
  /**
   * The permitted edit. Presence alone does **not** enable mutation: the environment switch must
   * also be `mutate`.
   */
  readonly mutation?: MutationProbeMutation;
}

export interface CreatedMutationProbe {
  /** A V2 `Plugin`-shaped object: `{ id, setup }`, where `setup` returns the cleanup function. */
  readonly plugin: { readonly id: string; readonly setup: (context: unknown) => () => void };
  readonly evidence: MutationProbeEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One located edit target: the `result` object and the `value` key inside it. */
interface MutationTarget {
  readonly container: Record<string, unknown>;
  readonly text: string;
  readonly occurrences: number;
}

interface ScanResult {
  readonly messages: number;
  readonly parts: number;
  readonly toolResultParts: number;
  readonly stringTextResults: number;
  readonly targets: readonly MutationTarget[];
  readonly targetOccurrences: number;
}

/**
 * Walk the request's messages and locate every `tool-result` part that is a plain `text` result whose
 * value is a string containing `original`. Read-only: it returns containers to edit and never edits.
 *
 * `original: null` counts the shapes only — the mode used when no marker is configured, so an
 * observation run still reports what the request was made of.
 */
function locateTargets(
  context: Record<string, unknown>,
  original: string | null,
  limits: MutationProbeLimits,
): ScanResult {
  const messages = Array.isArray(context['messages']) ? context['messages'] : [];
  const messageLimit = Math.min(messages.length, limits.maxMessages);
  const targets: MutationTarget[] = [];
  let parts = 0;
  let toolResultParts = 0;
  let stringTextResults = 0;
  let totalChars = 0;
  let targetOccurrences = 0;

  for (let messageIndex = 0; messageIndex < messageLimit; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message)) {
      continue;
    }
    const content = Array.isArray(message['content']) ? message['content'] : [];
    const partLimit = Math.min(content.length, limits.maxPartsPerMessage);
    for (let partIndex = 0; partIndex < partLimit; partIndex += 1) {
      const part = content[partIndex];
      if (!isRecord(part) || part['type'] !== 'tool-result') {
        continue;
      }
      parts += 1;
      toolResultParts += 1;

      const result = part['result'];
      if (!isRecord(result) || result['type'] !== 'text') {
        continue;
      }
      const value = result['value'];
      if (typeof value !== 'string') {
        continue;
      }
      stringTextResults += 1;
      if (original === null || original.length === 0) {
        continue;
      }
      if (stringTextResults > limits.maxTextResultsScanned) {
        continue;
      }
      if (totalChars + value.length > limits.maxTotalChars) {
        continue;
      }
      totalChars += value.length;

      const bounded = value.length > limits.maxCharsPerPayload ? value.slice(0, limits.maxCharsPerPayload) : value;
      if (!bounded.includes(original)) {
        continue;
      }
      // Count occurrences without retaining the text beyond the scan.
      let occurrences = 0;
      let from = 0;
      for (;;) {
        const at = bounded.indexOf(original, from);
        if (at === -1) {
          break;
        }
        occurrences += 1;
        if (occurrences >= limits.maxOccurrencesPerText) {
          break;
        }
        from = at + original.length;
      }
      targets.push({ container: result, text: value, occurrences });
      targetOccurrences += occurrences;
    }
  }

  return { messages: messageLimit, parts, toolResultParts, stringTextResults, targets, targetOccurrences };
}

/**
 * Resolve the mode from the options and the caller-supplied environment.
 *
 * Mutation requires the exact switch value `mutate`; everything else observes. This is the single
 * gate, and it is deliberately boring so it can be verified by reading it.
 */
export function resolveMutationProbeMode(
  env: Readonly<Record<string, string | undefined>>,
  mutation: MutationProbeMutation | undefined,
): MutationProbeMode {
  if (mutation === undefined) {
    return 'observe';
  }
  const value = String(env[MUTATION_PROBE_ENV] ?? '').trim().toLowerCase();
  return value === 'mutate' ? 'mutate' : 'observe';
}

/** True when the switch asks for the probe to register nothing. */
function switchDisables(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = String(env[MUTATION_PROBE_ENV] ?? '').trim().toLowerCase();
  return ['off', 'false', '0', 'no', 'disabled'].includes(value);
}

/** The `Request`-like body, described structurally. Never returns or stores the body. */
function describeBody(
  request: Record<string, unknown> | undefined,
  markers: MutationProbeMutation | undefined,
): {
  bodyType: string;
  bodyLength: number | null;
  bodyHasOriginal: boolean | null;
  bodyHasReplacement: boolean | null;
} {
  const none = { bodyType: 'absent', bodyLength: null, bodyHasOriginal: null, bodyHasReplacement: null };
  if (request === undefined) {
    return none;
  }
  let body: unknown;
  try {
    body = request['body'];
  } catch {
    return { bodyType: 'unreadable', bodyLength: null, bodyHasOriginal: null, bodyHasReplacement: null };
  }
  if (body === undefined || body === null) {
    return none;
  }
  let bodyType: string;
  if (typeof body === 'string') {
    bodyType = 'string';
  } else if (typeof body === 'object') {
    try {
      bodyType = (body as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    } catch {
      bodyType = 'object';
    }
  } else {
    bodyType = typeof body;
  }
  if (typeof body !== 'string') {
    return { bodyType, bodyLength: null, bodyHasOriginal: null, bodyHasReplacement: null };
  }
  return {
    bodyType,
    bodyLength: body.length,
    // Only when the caller named the markers: a marker boolean about content the caller did not
    // configure would be a content reading, and this probe does not take one.
    bodyHasOriginal: markers === undefined ? null : body.includes(markers.original),
    bodyHasReplacement: markers === undefined ? null : body.includes(markers.replacement),
  };
}

/** Header *count* of a `Request`-like object. Values are never read, compared or stored. */
function countHeaders(headers: Record<string, unknown>): number {
  const entries = (headers as { entries?: unknown }).entries;
  if (typeof entries === 'function') {
    let count = 0;
    for (const entry of (headers as unknown as { entries: () => Iterable<[string, string]> }).entries()) {
      void entry;
      count += 1;
      if (count >= 512) {
        break;
      }
    }
    return count;
  }
  return Object.keys(headers).length;
}

/**
 * Create the probe.
 *
 * Nothing here needs `@opencode/plugin`, so the probe has no dependency the host must resolve.
 */
export function createMutationProbe(options: MutationProbeOptions = {}): CreatedMutationProbe {
  // Deliberately not `process.env`: the caller supplies the environment (see the module note).
  const env = options.env ?? {};
  const limits: MutationProbeLimits = { ...DEFAULT_MUTATION_PROBE_LIMITS, ...(options.limits ?? {}) };
  const hash = options.hash ?? defaultProbeHash;
  const mutation = options.mutation;
  const mode = resolveMutationProbeMode(env, mutation);
  const analysisLimits: RequestProbeLimits = {
    ...DEFAULT_REQUEST_PROBE_LIMITS,
    maxMessages: limits.maxMessages,
    maxPartsPerMessage: limits.maxPartsPerMessage,
    maxCharsPerPayload: limits.maxCharsPerPayload,
    maxDigestChars: limits.maxTotalChars,
  };
  const nowIso = (): string => {
    try {
      const at = (options.now ?? Date.now)();
      const date = new Date(at);
      return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const records: MutationProbeRecord[] = [];
  const unsupported: string[] = [];
  const state = {
    contextInvocations: 0,
    httpRequestInvocations: 0,
    mutationsApplied: 0,
    mutationsAttempted: 0,
    internalErrors: 0,
    capped: false,
    capabilities: {
      sessionHook: false,
      sessionContextHook: false,
      httpRequestHook: false,
    } as MutationProbeCapabilities,
  };

  const emit = (record: MutationProbeRecord): void => {
    if (records.length >= limits.maxRecords) {
      if (!state.capped) {
        state.capped = true;
        records.push({ kind: 'records-capped', at: nowIso(), emitted: records.length });
      }
      return;
    }
    records.push(record);
    try {
      options.sink?.(record);
    } catch {
      state.internalErrors += 1;
    }
  };

  const disabled = options.enabled === false || switchDisables(env);

  const plugin = {
    id: MUTATION_PROBE_PLUGIN_ID,
    setup: (rawContext: unknown): (() => void) => {
      const disposers: Array<() => void> = [];
      let cleanedUp = false;

      /** Record a capability the host did not expose. Never guessed, only counted. */
      const noteUnsupported = (capability: string): void => {
        unsupported.push(capability);
        emit({ kind: 'unsupported', at: nowIso(), capability });
      };

      try {
        if (disabled) {
          emit({ kind: 'bypassed', at: nowIso(), reason: 'switch' });
          return () => {};
        }
        if (isRecord(rawContext) && rawContext['options'] !== undefined) {
          const configured = isRecord(rawContext['options']) ? rawContext['options']['enabled'] : undefined;
          if (configured === false) {
            emit({ kind: 'bypassed', at: nowIso(), reason: 'option' });
            return () => {};
          }
        }

        const context = isRecord(rawContext) ? rawContext : {};
        const session = isRecord(context['session']) ? context['session'] : {};
        const hook = session['hook'];
        if (typeof hook !== 'function') {
          noteUnsupported('session.hook');
        } else {
          const register = hook as (
            name: string,
            callback: (input: unknown) => Promise<void> | void,
          ) => unknown;

          state.capabilities = { ...state.capabilities, sessionHook: true };

          /**
           * Record one `context` invocation and, in `mutate` mode only, apply the single permitted
           * edit. Read-only passes run first, so the structural record always describes what the host
           * assembled rather than what this probe left behind.
           */
          const handleContext = (input: unknown, invocation: number): void => {
            const outer = isRecord(input) ? input : undefined;
            if (outer === undefined) {
              noteUnsupported('context-payload');
              return;
            }
            const outerKeys = Object.keys(outer);
            const outerHasContext = Object.prototype.hasOwnProperty.call(outer, 'context');
            const candidate = outerHasContext ? outer['context'] : outer;
            if (
              !isRecord(candidate) ||
              (!Array.isArray(candidate['messages']) && !Array.isArray(candidate['system']))
            ) {
              noteUnsupported('context-payload');
              return;
            }
            const outerKind = typeof outer['kind'] === 'string' ? outer['kind'] : null;
            const analysis = analyseRequest(candidate, hash, analysisLimits);
            if (analysis === undefined) {
              noteUnsupported('context-payload');
              return;
            }

            // Scan for the configured marker. With no configuration this is a read-only walk that
            // reports the shapes it saw.
            const marker =
              mutation !== undefined && mutation.original.length > 0 ? mutation.original : null;
            const scan = locateTargets(candidate, marker, limits);

            let mutationAttempted = false;
            let mutationApplied = false;
            let refusalReason: MutationRefusalReason | null = null;
            let textBeforeLength: number | null = null;
            let textAfterLength: number | null = null;

            if (mode === 'mutate' && mutation !== undefined) {
              if (mutation.original.length === 0 || mutation.replacement === mutation.original) {
                mutationAttempted = true;
                refusalReason = 'invalid-config';
              } else if (scan.targets.length === 0) {
                mutationAttempted = true;
                refusalReason = 'target-absent';
              } else if (scan.targets.length > 1) {
                mutationAttempted = true;
                refusalReason = 'target-ambiguous';
              } else if (scan.targets[0]?.occurrences !== 1) {
                mutationAttempted = true;
                refusalReason = 'target-occurrences-not-unique';
              } else {
                mutationAttempted = true;
                const target = scan.targets[0];
                const at = target.text.indexOf(mutation.original);
                textBeforeLength = target.text.length;
                try {
                  target.container['value'] =
                    target.text.slice(0, at) +
                    mutation.replacement +
                    target.text.slice(at + mutation.original.length);
                  mutationApplied = true;
                  textAfterLength = String(target.container['value']).length;
                  state.mutationsApplied += 1;
                } catch {
                  // A frozen or accessor-only payload is a legitimate outcome: refuse and record.
                  refusalReason = 'assignment-failed';
                }
              }
              if (mutationAttempted) {
                state.mutationsAttempted += 1;
              }
            }

            emit({
              kind: 'context',
              at: nowIso(),
              invocation,
              sessionHash: analysis.sessionHash,
              mode,
              outerKeys,
              outerHasContext,
              outerKind,
              messages: analysis.messages,
              parts: scan.parts,
              toolResultParts: scan.toolResultParts,
              stringTextResults: scan.stringTextResults,
              targetParts: scan.targets.length,
              targetOccurrences: scan.targetOccurrences,
              mutationAttempted,
              mutationApplied,
              refusalReason,
              textBeforeLength,
              textAfterLength,
              analysis,
            });
          };

          /** Record that a model call is about to happen, and how, without retaining its content. */
          const handleHttpRequest = (input: unknown, invocation: number): void => {
            const record = isRecord(input) ? input : {};
            const request = isRecord(record['request']) ? record['request'] : undefined;
            let headerCount = 0;
            if (request !== undefined && isRecord(request['headers'])) {
              try {
                headerCount = countHeaders(request['headers']);
              } catch {
                headerCount = 0;
              }
            }
            emit({
              kind: 'http-request',
              at: nowIso(),
              invocation,
              requestKind: typeof record['kind'] === 'string' ? record['kind'] : 'unknown',
              urlIsString: request !== undefined && typeof request['url'] === 'string',
              headerCount,
              ...describeBody(request, mutation),
            });
          };

          const attach = (name: 'context' | 'http.request'): void => {
            let registration: unknown;
            try {
              registration = register(name, (input: unknown) => {
                if (name === 'context') {
                  state.contextInvocations += 1;
                  try {
                    handleContext(input, state.contextInvocations);
                  } catch {
                    state.internalErrors += 1;
                    emit({ kind: 'internal-error', at: nowIso(), code: 'context-callback' });
                  }
                  return;
                }
                state.httpRequestInvocations += 1;
                try {
                  handleHttpRequest(input, state.httpRequestInvocations);
                } catch {
                  state.internalErrors += 1;
                  emit({ kind: 'internal-error', at: nowIso(), code: 'http-request-callback' });
                }
                return undefined;
              });
            } catch {
              noteUnsupported(`session.hook(${name})`);
              return;
            }

            state.capabilities =
              name === 'context'
                ? { ...state.capabilities, sessionContextHook: true }
                : { ...state.capabilities, httpRequestHook: true };

            // A V2 registration resolves to `{ dispose }`. A registration that arrives after cleanup
            // is disposed immediately rather than leaked.
            const install = (value: unknown): void => {
              if (!isRecord(value) || typeof value['dispose'] !== 'function') {
                return;
              }
              const dispose = value['dispose'] as () => unknown;
              const run = (): void => {
                try {
                  void dispose();
                } catch {
                  state.internalErrors += 1;
                }
              };
              if (cleanedUp) {
                run();
                return;
              }
              disposers.push(run);
            };
            if (isRecord(registration) && typeof registration['then'] === 'function') {
              void (registration as unknown as Promise<unknown>).then(install).catch(() => {
                state.internalErrors += 1;
              });
            } else {
              install(registration);
            }
          };

          try {
            attach('context');
            attach('http.request');
          } catch {
            state.internalErrors += 1;
            emit({ kind: 'internal-error', at: nowIso(), code: 'registration' });
          }
        }

        emit({
          kind: 'probe-start',
          at: nowIso(),
          pluginId: MUTATION_PROBE_PLUGIN_ID,
          mode,
          mutationConfigured: mutation !== undefined,
          capabilities: state.capabilities,
        });

        return () => {
          cleanedUp = true;
          let disposed = 0;
          for (const dispose of disposers.splice(0)) {
            dispose();
            disposed += 1;
          }
          emit({ kind: 'cleanup', at: nowIso(), disposed });
        };
      } catch {
        state.internalErrors += 1;
        emit({ kind: 'internal-error', at: nowIso(), code: 'setup' });
        return () => {};
      }
    },
  };

  const evidence: MutationProbeEvidence = {
    records,
    get contextInvocations(): number {
      return state.contextInvocations;
    },
    get httpRequestInvocations(): number {
      return state.httpRequestInvocations;
    },
    get mutationsApplied(): number {
      return state.mutationsApplied;
    },
    get mutationsAttempted(): number {
      return state.mutationsAttempted;
    },
    get internalErrors(): number {
      return state.internalErrors;
    },
    unsupported,
    get capped(): boolean {
      return state.capped;
    },
    get mode(): MutationProbeMode {
      return mode;
    },
    get capabilities(): MutationProbeCapabilities {
      return state.capabilities;
    },
  };

  return { plugin, evidence };
}

/**
 * Ready-to-load probe with default options.
 *
 * **Not exported from the package entry point**, and with no `mutation` configuration it can only
 * observe. It exists so a caller can compare against a bare registration.
 */
export default createMutationProbe().plugin;
