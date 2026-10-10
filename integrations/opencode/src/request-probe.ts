/**
 * OpenCode V2 **request-assembly observation probe** (Stage 1P).
 *
 * This is a **validation aid, not part of the product install**. It exists to answer one question
 * with runtime evidence: does the installed OpenCode 2.0.24 runtime hand a project plugin the
 * *assembled model request*, and if so, what structure does that request have?
 *
 * It is deliberately separate from the shipped adapter (`plugin-v2.ts`), which registers only tool
 * hooks and the event stream. Nothing here is exported from the package entry point, so no product
 * behaviour changes when this module is unused.
 *
 * Guarantees, in the order they matter:
 *
 * 1. **Observation only.** No property of any callback argument is ever assigned, deleted or
 *    redefined. The V2 hook contract has no return-value channel (callbacks return
 *    `Promise<void> | void`), so with no assignment there is no way to influence the request. Tests
 *    assert this by delivering a deep-frozen object graph.
 * 2. **Content-free.** Records carry counts, key *names*, booleans and one-way digests — never
 *    prompt text, tool-result content, file paths, URLs, header values, request bodies or
 *    credentials.
 * 3. **Bounded.** Every scan is capped, the record set is capped, and nothing is retained across
 *    requests. No timers, no `ctx.storage`, no state outside the configured sink.
 * 4. **Fail-open.** Every hook body and the whole of `setup` are wrapped; a failure is counted as a
 *    content-free diagnostic and never thrown into the host.
 * 5. **Bypassable.** `enabled: false` (plugin option or environment) registers nothing.
 *
 * The probe reads **no environment of its own**: the caller passes the environment in
 * (`options.env`), which keeps this module a pure function of its options and preserves the source
 * guard's rule that only the observer module reads `process.env`. The validation harness supplies it.
 */
import { createHash } from 'node:crypto';

/** Default caps. Large enough to observe any real request, small enough to bound one. */
export const DEFAULT_REQUEST_PROBE_LIMITS = {
  /** Messages examined per request. */
  maxMessages: 4_000,
  /** Content parts examined per message. */
  maxPartsPerMessage: 500,
  /** Tool-result payloads digested per request. */
  maxToolResultsDigested: 500,
  /** Total characters digested per request, across all payloads. */
  maxDigestChars: 4_000_000,
  /** Characters digested from a single payload before it is treated as truncated. */
  maxCharsPerPayload: 1_000_000,
  /** Records the probe will emit for one process. */
  maxRecords: 2_000,
} as const;

export interface RequestProbeLimits {
  readonly maxMessages: number;
  readonly maxPartsPerMessage: number;
  readonly maxToolResultsDigested: number;
  readonly maxDigestChars: number;
  readonly maxCharsPerPayload: number;
  readonly maxRecords: number;
}

/**
 * Environment switch that disables the probe entirely (value `off`).
 *
 * Honoured only when the caller passes an environment to {@link createRequestProbe}. The validation
 * harness reads the process environment and forwards it.
 */
export const REQUEST_PROBE_DISABLED_ENV = 'DR_TOKEN_REQUEST_PROBE';
/**
 * Environment switch naming where content-free evidence records are appended.
 *
 * Used by the validation harness, not by this module (the module takes an injected `sink`).
 */
export const REQUEST_PROBE_EVIDENCE_ENV = 'DR_TOKEN_REQUEST_PROBE_EVIDENCE';

/** Stable id used in the `Plugin`-shaped registration. */
export const REQUEST_PROBE_PLUGIN_ID = 'dr-token-request-probe';

/** Capabilities the probe records, and whether the host exposed them. */
export interface RequestProbeCapabilities {
  readonly sessionHook: boolean;
  readonly sessionContextHook: boolean;
  readonly httpRequestHook: boolean;
  /** `true` when an unknown hook name was accepted, `false` when it threw, `null` when not probed. */
  readonly unknownHookAccepted: boolean | null;
}

/** Evidence kinds. All content-free by construction. */
export type RequestProbeRecord =
  | {
      readonly kind: 'probe-start';
      readonly at: string;
      readonly pluginId: string;
      readonly capabilities: RequestProbeCapabilities;
    }
  | {
      readonly kind: 'context';
      readonly at: string;
      readonly invocation: number;
      readonly sessionHash: string;
      readonly systemParts: number;
      readonly messages: number;
      readonly roles: Readonly<Record<string, number>>;
      readonly partTypes: Readonly<Record<string, number>>;
      readonly toolResults: number;
      readonly toolResultNames: readonly string[];
      readonly distinctToolResultDigests: number;
      readonly duplicateGroups: number;
      readonly duplicateLaterParts: number;
      readonly elidableChars: number;
      readonly readToolDuplicateGroups: number;
      readonly hasCompactionPart: boolean;
      readonly toolDefinitions: number;
      readonly optionKeys: number;
      readonly scanned: {
        readonly messages: number;
        readonly parts: number;
        readonly digestedChars: number;
        readonly truncated: boolean;
      };
    }
  | {
      readonly kind: 'http-request';
      readonly at: string;
      readonly invocation: number;
      readonly requestKind: string;
      readonly urlIsString: boolean;
      readonly headerCount: number;
      readonly bodyPresent: boolean;
    }
  | { readonly kind: 'unsupported'; readonly at: string; readonly capability: string }
  | { readonly kind: 'internal-error'; readonly at: string; readonly code: string }
  | { readonly kind: 'records-capped'; readonly at: string; readonly emitted: number }
  | { readonly kind: 'bypassed'; readonly at: string }
  | { readonly kind: 'cleanup'; readonly at: string; readonly disposed: number };

/** The structural part of a `context` record, as computed by {@link analyseRequest}. */
export type RequestAnalysis = Omit<
  Extract<RequestProbeRecord, { kind: 'context' }>,
  'kind' | 'at' | 'invocation'
>;

/** Observable counters, exposed for tests and for a caller that wants a live view. */
export interface RequestProbeEvidence {
  readonly records: readonly RequestProbeRecord[];
  readonly contextInvocations: number;
  readonly httpRequestInvocations: number;
  readonly internalErrors: number;
  readonly unsupported: readonly string[];
  readonly capped: boolean;
  readonly capabilities: RequestProbeCapabilities;
}

export interface RequestProbeOptions {
  /** `false` disables the probe: `setup` registers nothing. */
  readonly enabled?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where records go. Omitting it keeps everything in memory (tests, dry runs). */
  readonly sink?: (record: RequestProbeRecord) => void | Promise<void>;
  /** One-way hasher for session identifiers. Defaults to SHA-256 truncated to 16 hex characters. */
  readonly hash?: (value: string) => string;
  readonly now?: () => number;
  readonly limits?: Partial<RequestProbeLimits>;
  /** Probe an unknown hook name once, to observe whether the host fails safely. */
  readonly probeUnknownHook?: boolean;
}

export interface CreatedRequestProbe {
  /** A V2 `Plugin`-shaped object: `{ id, setup }`, where `setup` returns the cleanup function. */
  readonly plugin: { readonly id: string; readonly setup: (context: unknown) => () => void };
  readonly evidence: RequestProbeEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SHA-256 truncated to 16 hex characters — the identity shape the observer also uses. */
export function defaultProbeHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Extract the model-visible text of one tool-result payload, bounded and never returned raw.
 *
 * Handles the four documented `ToolResultValue` shapes: `text`, `json`, `error` and `content`.
 */
function toolResultText(part: Record<string, unknown>, limit: number): { text: string; truncated: boolean } {
  const result = isRecord(part['result']) ? part['result'] : undefined;
  if (result === undefined) {
    return { text: '', truncated: false };
  }

  const value = result['value'];
  let text: string;
  if (result['type'] === 'content') {
    const items = Array.isArray(value) ? value : [];
    const pieces: string[] = [];
    for (const item of items) {
      if (!isRecord(item)) {
        continue;
      }
      if (typeof item['text'] === 'string') {
        pieces.push(item['text']);
      } else if (typeof item['uri'] === 'string') {
        // A file part's URI is never stored: it is only ever mixed into a one-way digest.
        pieces.push(item['uri']);
      }
      if (pieces.length >= 64) {
        break;
      }
    }
    text = pieces.join('\n');
  } else if (typeof value === 'string') {
    text = value;
  } else if (value === undefined) {
    text = '';
  } else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = '';
    }
  }

  return text.length > limit
    ? { text: text.slice(0, limit), truncated: true }
    : { text, truncated: false };
}

/**
 * Analyse one assembled request structurally.
 *
 * Pure and read-only: it walks the object graph and builds counters. It never retains a payload, a
 * path or a message, and never assigns to its input. Returns `undefined` when the input is not a
 * request-shaped object, so a caller can record that honestly instead of inventing a reading.
 */
export function analyseRequest(
  context: unknown,
  hash: (value: string) => string,
  limits: RequestProbeLimits,
): RequestAnalysis | undefined {
  if (!isRecord(context)) {
    return undefined;
  }

  const roles: Record<string, number> = {};
  const partTypes: Record<string, number> = {};
  const toolResultNames = new Set<string>();
  /** digest → how many times it appears, and how many characters the *later* copies hold */
  const groups = new Map<string, { count: number; laterChars: number; name: string }>();

  const system = Array.isArray(context['system']) ? context['system'] : [];
  const messages = Array.isArray(context['messages']) ? context['messages'] : [];
  const tools = isRecord(context['tools']) ? context['tools'] : {};
  const options = isRecord(context['options']) ? context['options'] : {};

  let parts = 0;
  let digestedChars = 0;
  let toolResults = 0;
  let truncated = false;
  let hasCompactionPart = false;

  const messageLimit = Math.min(messages.length, limits.maxMessages);
  if (messages.length > messageLimit) {
    truncated = true;
  }

  for (let messageIndex = 0; messageIndex < messageLimit; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message)) {
      continue;
    }
    const role = typeof message['role'] === 'string' ? message['role'] : 'unknown';
    roles[role] = (roles[role] ?? 0) + 1;

    const content = Array.isArray(message['content']) ? message['content'] : [];
    const partLimit = Math.min(content.length, limits.maxPartsPerMessage);
    if (content.length > partLimit) {
      truncated = true;
    }

    for (let partIndex = 0; partIndex < partLimit; partIndex += 1) {
      const part = content[partIndex];
      if (!isRecord(part)) {
        continue;
      }
      parts += 1;
      const type = typeof part['type'] === 'string' ? part['type'] : 'unknown';
      partTypes[type] = (partTypes[type] ?? 0) + 1;
      if (type === 'compaction') {
        hasCompactionPart = true;
      }
      if (type !== 'tool-result') {
        continue;
      }

      toolResults += 1;
      const name = typeof part['name'] === 'string' ? part['name'] : 'unknown';
      toolResultNames.add(name);

      if (groups.size >= limits.maxToolResultsDigested) {
        truncated = true;
        continue;
      }
      const extracted = toolResultText(part, limits.maxCharsPerPayload);
      if (extracted.truncated) {
        truncated = true;
      }
      if (digestedChars + extracted.text.length > limits.maxDigestChars) {
        truncated = true;
        continue;
      }
      digestedChars += extracted.text.length;

      // The tool name is part of the identity: identical text from a *different* tool is not the
      // same content and must never be treated as a duplicate.
      const digest = hash(`${name}\u0000${extracted.text}`);
      const existing = groups.get(digest);
      if (existing === undefined) {
        groups.set(digest, { count: 1, laterChars: 0, name });
      } else {
        existing.count += 1;
        existing.laterChars += extracted.text.length;
      }
    }
  }

  let duplicateGroups = 0;
  let duplicateLaterParts = 0;
  let elidableChars = 0;
  let readToolDuplicateGroups = 0;
  for (const group of groups.values()) {
    if (group.count <= 1) {
      continue;
    }
    duplicateGroups += 1;
    duplicateLaterParts += group.count - 1;
    elidableChars += group.laterChars;
    if (group.name === 'read') {
      readToolDuplicateGroups += 1;
    }
  }

  return {
    sessionHash: typeof context['sessionID'] === 'string' ? hash(context['sessionID']) : 'unknown',
    systemParts: system.length,
    messages: messages.length,
    roles,
    partTypes,
    toolResults,
    toolResultNames: [...toolResultNames].sort(),
    distinctToolResultDigests: groups.size,
    duplicateGroups,
    duplicateLaterParts,
    elidableChars,
    readToolDuplicateGroups,
    hasCompactionPart,
    toolDefinitions: Object.keys(tools).length,
    optionKeys: Object.keys(options).length,
    scanned: { messages: messageLimit, parts, digestedChars, truncated },
  };
}

/**
 * Whether a `Request`-like object has a body. Existence only — the body is never read, measured or
 * interpreted, and a throwing accessor is treated as "unknown, reported as absent".
 */
function bodyPresent(request: Record<string, unknown> | undefined): boolean {
  if (request === undefined) {
    return false;
  }
  try {
    return request['body'] !== undefined && request['body'] !== null;
  } catch {
    return false;
  }
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
export function createRequestProbe(options: RequestProbeOptions = {}): CreatedRequestProbe {
  // Deliberately not `process.env`: the caller supplies the environment (see the module note), so
  // this module stays pure and the source guard's single-env-reader rule keeps holding.
  const env = options.env ?? {};
  const limits: RequestProbeLimits = { ...DEFAULT_REQUEST_PROBE_LIMITS, ...(options.limits ?? {}) };
  const hash = options.hash ?? defaultProbeHash;
  const nowIso = (): string => {
    try {
      const at = (options.now ?? Date.now)();
      const date = new Date(at);
      return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const records: RequestProbeRecord[] = [];
  const unsupported: string[] = [];
  const state = {
    contextInvocations: 0,
    httpRequestInvocations: 0,
    internalErrors: 0,
    capped: false,
    capabilities: {
      sessionHook: false,
      sessionContextHook: false,
      httpRequestHook: false,
      unknownHookAccepted: null,
    } as RequestProbeCapabilities,
  };

  const emit = (record: RequestProbeRecord): void => {
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

  const disabled =
    options.enabled === false ||
    String(env[REQUEST_PROBE_DISABLED_ENV] ?? '').trim().toLowerCase() === 'off';

  const plugin = {
    id: REQUEST_PROBE_PLUGIN_ID,
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
          emit({ kind: 'bypassed', at: nowIso() });
          return () => {};
        }

        const context = isRecord(rawContext) ? rawContext : {};
        const configured = isRecord(context['options']) ? context['options']['enabled'] : undefined;
        if (configured === false) {
          emit({ kind: 'bypassed', at: nowIso() });
          return () => {};
        }

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
           * Structural, content-free record of one assembled request.
           *
           * A payload that is not request-shaped — not an object, a `context` member that is not
           * an object, or an object carrying neither `messages` nor `system` — is reported as an
           * unsupported measurement. It is never analysed into an all-zero "reading", because a
           * fabricated empty request would be worse evidence than no evidence.
           */
          const observeContext = (input: unknown, invocation: number): void => {
            const outer = isRecord(input) ? input : undefined;
            if (outer === undefined) {
              noteUnsupported('context-payload');
              return;
            }
            const hasContextMember = Object.prototype.hasOwnProperty.call(outer, 'context');
            const candidate = hasContextMember ? outer['context'] : outer;
            if (
              !isRecord(candidate) ||
              (!Array.isArray(candidate['messages']) && !Array.isArray(candidate['system']))
            ) {
              noteUnsupported('context-payload');
              return;
            }
            const analysis = analyseRequest(candidate, hash, limits);
            if (analysis === undefined) {
              noteUnsupported('context-payload');
              return;
            }
            emit({ kind: 'context', at: nowIso(), invocation, ...analysis });
          };

          /** Record that a model call is about to happen, and how, without reading its content. */
          const observeHttpRequest = (input: unknown, invocation: number): void => {
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
              // Presence only: the body is never read, not even to measure it. A body accessor that
              // throws degrades to `false` instead of losing the whole record.
              bodyPresent: bodyPresent(request),
            });
          };

          const attach = (name: 'context' | 'http.request'): void => {
            let registration: unknown;
            try {
              registration = register(name, (input: unknown) => {
                if (name === 'context') {
                  state.contextInvocations += 1;
                  try {
                    observeContext(input, state.contextInvocations);
                  } catch {
                    state.internalErrors += 1;
                    emit({ kind: 'internal-error', at: nowIso(), code: 'context-callback' });
                  }
                  return;
                }
                state.httpRequestInvocations += 1;
                try {
                  observeHttpRequest(input, state.httpRequestInvocations);
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

            // A V2 registration resolves to `{ dispose }`. A promise is tolerated too: the probe
            // never awaits it on the host's path, and a rejection is counted rather than thrown.
            // A registration that arrives *after* cleanup is disposed immediately rather than
            // leaked — the host's own dispose ordering is not something the probe can assume.
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

          if (options.probeUnknownHook === true) {
            try {
              register('dr-token.unknown.hook', () => undefined);
              state.capabilities = { ...state.capabilities, unknownHookAccepted: true };
            } catch {
              state.capabilities = { ...state.capabilities, unknownHookAccepted: false };
            }
          }
        }

        emit({
          kind: 'probe-start',
          at: nowIso(),
          pluginId: REQUEST_PROBE_PLUGIN_ID,
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

  const evidence: RequestProbeEvidence = {
    records,
    get contextInvocations(): number {
      return state.contextInvocations;
    },
    get httpRequestInvocations(): number {
      return state.httpRequestInvocations;
    },
    get internalErrors(): number {
      return state.internalErrors;
    },
    unsupported,
    get capped(): boolean {
      return state.capped;
    },
    get capabilities(): RequestProbeCapabilities {
      return state.capabilities;
    },
  };

  return { plugin, evidence };
}

/** Ready-to-load probe with default options, for a project plugin file that re-exports it. */
export default createRequestProbe().plugin;
