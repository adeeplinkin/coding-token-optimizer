/**
 * Public contracts for the Dr. Token OpenCode observer adapter (Stage 1D).
 *
 * This adapter is **observation only**. It records what OpenCode did; it never
 * changes model context, tool arguments, tool results, or agent behavior.
 *
 * =====================================================================
 * VERIFIED OPENCODE PLUGIN API (V1)
 * =====================================================================
 *
 * Target package: `@opencode-ai/plugin`, verified version **1.18.35** (npm `latest`).
 * Verification method (2026-10-10): download the published tarballs and read the
 * shipped declarations directly, then record their digests.
 *
 *   npm pack @opencode-ai/plugin@1.18.35
 *   sha256(dist/index.d.ts)          = f3ec1a150d1354be3c9d93928fa130edc118c63fb468533ebb01eb3d6ed77f92
 *   npm pack @opencode-ai/sdk@1.18.35
 *   sha256(dist/gen/types.gen.d.ts)  = 1fdbed5b58ed5882b411cc9b1b03fdfe2fb131b0be39a0fd2622d12ab6f50f0f
 *
 * Verbatim excerpts from `@opencode-ai/plugin@1.18.35/dist/index.d.ts`:
 *
 *   export type PluginInput = {
 *     client: ReturnType<typeof createOpencodeClient>;
 *     project: Project;
 *     directory: string;
 *     worktree: string;
 *     experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void };
 *     serverUrl: URL;
 *     $: BunShell;
 *   };
 *   export type PluginOptions = Record<string, unknown>;
 *   export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
 *
 *   export interface Hooks {
 *     dispose?: () => Promise<void>;
 *     event?: (input: { event: Event }) => Promise<void>;
 *     "tool.execute.before"?: (
 *       input: { tool: string; sessionID: string; callID: string },
 *       output: { args: any },
 *     ) => Promise<void>;
 *     "tool.execute.after"?: (
 *       input: { tool: string; sessionID: string; callID: string; args: any },
 *       output: { title: string; output: string; metadata: any },
 *     ) => Promise<void>;
 *     // ... further hooks that Dr. Token deliberately does not implement
 *   }
 *
 * Verbatim excerpts from `@opencode-ai/sdk@1.18.35/dist/gen/types.gen.d.ts`:
 *
 *   export type AssistantMessage = {
 *     id: string;
 *     sessionID: string;
 *     role: "assistant";
 *     // ...
 *     cost: number;
 *     tokens: {
 *       input: number; output: number; reasoning: number;
 *       cache: { read: number; write: number };
 *     };
 *   };
 *   export type EventMessageUpdated = { type: "message.updated"; properties: { info: Message } };
 *   export type EventSessionIdle    = { type: "session.idle";    properties: { sessionID: string } };
 *   export type EventSessionCreated = { type: "session.created"; properties: { info: Session } };
 *
 * The `types.ts`, `read.ts`, `usage.ts`, `observer.ts` and `plugin.ts` modules implement only the
 * documented V1 hooks above. No `experimental.*` hook is used, and no hook that can mutate model
 * context is implemented. A vendored copy of the exact published signatures is kept in
 * `tests/fixtures/opencode-plugin-v1.contract.ts` so `npm run typecheck` fails if this adapter
 * drifts from the contract it claims to implement.
 */

/** Version of the observation summary schema. */
export const OBSERVATION_SCHEMA_VERSION = 1;

/** Package name recorded in every summary. */
export const OBSERVER_ADAPTER_NAME = '@dr-token/opencode-observer';

/**
 * Revision of this adapter, kept in sync with `package.json` by a test so a
 * recorded observation can never silently claim the wrong adapter revision.
 */
export const OBSERVER_ADAPTER_REVISION = '0.0.0';

/** OpenCode plugin API package this adapter targets. */
export const OPENCODE_PLUGIN_PACKAGE = '@opencode-ai/plugin';

/** OpenCode plugin API version this adapter was verified against. */
export const OPENCODE_PLUGIN_VERIFIED_VERSION = '1.18.35';

/**
 * The hook names this adapter implements.
 *
 * Kept as a runtime list so tests can assert the adapter never registers a hook
 * that is capable of modifying agent behavior.
 */
export const IMPLEMENTED_HOOKS = [
  'tool.execute.before',
  'tool.execute.after',
  'event',
  'dispose',
] as const;

export type ImplementedHook = (typeof IMPLEMENTED_HOOKS)[number];

/**
 * V2 event carrying a session usage snapshot (observed in OpenCode 2.0.24).
 *
 * The payload is under `event.data`; V1 delivers usage under `event.properties`.
 */
export const OPENCODE_V2_USAGE_EVENT_TYPE = 'session.usage.updated';

/**
 * V2 event indicating a session execution finished (observed in OpenCode 2.0.24).
 *
 * Used only as a **flush trigger** so a summary reaches the sink promptly. It is
 * deliberately not counted or classified: it is not known to be equivalent to
 * V1's `session.idle`, and a write is not a claim about behaviour.
 */
export const OPENCODE_V2_EXECUTION_SUCCEEDED_EVENT_TYPE = 'session.execution.succeeded';

/**
 * Default interval between checkpoint writes when a sink is configured.
 *
 * A one-shot `run` session can be terminated before any unload path runs, so the
 * observer also persists changed sessions periodically instead of relying on
 * cleanup. `0` disables checkpointing and restores flush-on-lifecycle only.
 */
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 1000;

/**
 * Environment switch that disables the observer.
 *
 * Any of `off`, `false`, `0`, `no` or `disabled` (case-insensitive) disables
 * observation. This is the switch usable from `opencode.json` deployments that
 * cannot pass a function option.
 */
export const OBSERVER_DISABLE_ENV_VAR = 'DR_TOKEN_OPENCODE_OBSERVER';

/** Environment switch pointing at an opt-in JSON Lines summary file. */
export const OBSERVER_SUMMARY_FILE_ENV_VAR = 'DR_TOKEN_OBSERVER_SUMMARY_FILE';

/* -------------------------------------------------------------------------- */
/* OpenCode V1 hook contracts (structural subset, see the header above)        */
/* -------------------------------------------------------------------------- */

/** `input.tool` is a tool id: `read`, `edit`, `write`, `bash`, `grep`, ... */
export interface OpenCodeToolExecuteBeforeInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
}

/**
 * `output.args` is the tool's own argument object.
 *
 * The observer only ever *reads* it. OpenCode passes the same object by
 * reference to every plugin, so mutating it would change agent behavior.
 */
export interface OpenCodeToolExecuteBeforeOutput {
  readonly args: unknown;
}

export interface OpenCodeToolExecuteAfterInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly args: unknown;
}

/**
 * The tool result wrapper. `output.output` is the text the model will receive
 * and `output.metadata` tool-specific data. Both are read-only for the
 * observer and are never stored.
 */
export interface OpenCodeToolExecuteAfterOutput {
  readonly title: string;
  readonly output: string;
  readonly metadata: unknown;
}

/**
 * Structural view of the OpenCode `Event` union member.
 *
 * Every member of the published union carries a literal `type` and a
 * `properties` object. The observer keeps both fields optional so it can inspect
 * an event defensively without trusting the runtime shape.
 */
export interface OpenCodeRuntimeEvent {
  readonly type?: string;
  readonly properties?: unknown;
  /**
   * V2 event payload envelope, runtime-confirmed in Stage 1G.
   *
   * V1 delivers payloads under `properties`; V2 delivers them under `data`. Only
   * one of the two is present on any given event.
   */
  readonly data?: unknown;
}

/** The `event` hook receives a single wrapper object. */
export interface OpenCodeEventHookInput {
  readonly event: OpenCodeRuntimeEvent;
}

/**
 * Structural view of `PluginInput`.
 *
 * Only fields the observer could ever read are declared, and all are optional,
 * because the adapter must keep working on a release that changes the context.
 * The observer currently reads none of them.
 */
export interface OpenCodePluginInput {
  readonly directory?: string;
  readonly worktree?: string;
  readonly client?: unknown;
  readonly project?: unknown;
  readonly serverUrl?: unknown;
}

/** Structural view of `PluginOptions` (from `opencode.json`). */
export type OpenCodePluginOptions = Readonly<Record<string, unknown>>;

/**
 * The hooks object this adapter returns.
 *
 * Every member returns `Promise<void>` and is required here (the published
 * interface declares them optional), because the adapter always wants a chance
 * to observe — and because a `Promise<void>`-returning function is what the
 * published signatures accept.
 */
export interface OpenCodeObserverHooks {
  'tool.execute.before': (
    input: OpenCodeToolExecuteBeforeInput,
    output: OpenCodeToolExecuteBeforeOutput,
  ) => Promise<void>;
  'tool.execute.after': (
    input: OpenCodeToolExecuteAfterInput,
    output: OpenCodeToolExecuteAfterOutput,
  ) => Promise<void>;
  event: (input: OpenCodeEventHookInput) => Promise<void>;
  dispose: () => Promise<void>;
}

/** A V1 plugin function as OpenCode loads it. */
export type OpenCodeObserverPlugin = (
  input: OpenCodePluginInput,
  options?: OpenCodePluginOptions,
) => Promise<OpenCodeObserverHooks>;

/* -------------------------------------------------------------------------- */
/* Evidence vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Evidence classification used by the observer.
 *
 * - `measured` — a direct observation (a tool completion, an event field).
 * - `calculated` — an aggregate derived from recorded measurements, such as a
 *   count, a session token sum, or a repeated-read total. Never a direct
 *   reading and never a savings claim.
 * - `estimated` — indirectly inferred without an authoritative record. The
 *   observer does not currently produce estimates; the class exists so a future
 *   inference cannot be mistaken for a measurement.
 * - `unavailable` — no reliable value exists. Always carries a reason.
 *
 * Stage 1B uses `measured | estimated | benchmark-verified | unavailable`.
 * `calculated` is adapter-specific, because Stage 1B cannot express "aggregate
 * of measurements" without losing the distinction. The benchmark adapter maps it
 * explicitly; see `benchmark-adapter.ts`.
 */
export type ObservationEvidence = 'measured' | 'calculated' | 'estimated' | 'unavailable';

/** A measurement with a value, plus how the value was obtained. */
export interface ObservationValue<T> {
  readonly evidence: 'measured' | 'calculated' | 'estimated';
  readonly value: T;
}

/** A measurement that does not exist, with the reason why. */
export interface ObservationMissing {
  readonly evidence: 'unavailable';
  readonly note: string;
}

/** A metric that always carries its evidence classification. */
export type ObservationMeasurement<T> = ObservationValue<T> | ObservationMissing;

/** Whole-number metrics the observer records. */
export type ObservationCountMetric =
  | 'toolStartsObserved'
  | 'toolCompletionsObserved'
  | 'readRequestsObserved'
  | 'identifiedReadRequests'
  | 'unidentifiedReadRequests'
  | 'distinctReadTargets'
  | 'repeatedReadTargets'
  | 'repeatedFileReads';

/** The token and cost fields OpenCode publishes per assistant message. */
export type UsageField = 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite' | 'cost';

/** Every usage field, in a stable order. */
export const USAGE_FIELDS: readonly UsageField[] = [
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheWrite',
  'cost',
];

/* -------------------------------------------------------------------------- */
/* Observation summaries                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which OpenCode plugin API line produced an observation.
 *
 * A summary must never claim the wrong line: the V1 and V2 contracts are
 * different, and a reader needs to know which one was loaded.
 */
export type OpenCodePluginApiLine = 'v1' | 'v2';

/** The plugin API package and version an observer instance was built against. */
export interface ObserverPluginApiIdentity {
  readonly package: string;
  readonly verifiedVersion: string;
  readonly line: OpenCodePluginApiLine;
}

/** Default (V1) plugin API identity, used when no override is supplied. */
export const DEFAULT_OBSERVER_PLUGIN_API: ObserverPluginApiIdentity = {
  package: OPENCODE_PLUGIN_PACKAGE,
  verifiedVersion: OPENCODE_PLUGIN_VERIFIED_VERSION,
  line: 'v1',
};

/** Static identity of the adapter that produced a summary. */
export interface ObserverAdapterIdentity {
  readonly name: typeof OBSERVER_ADAPTER_NAME;
  readonly revision: string;
  readonly pluginApi: ObserverPluginApiIdentity;
}

/** One tool id and how often it started and completed. */
export interface ToolFrequencyEntry {
  readonly tool: string;
  readonly started: number;
  readonly completed: number;
}

/** Tool-execution counters for a session. */
export interface SessionObservationCounts {
  readonly toolStartsObserved: number;
  readonly toolCompletionsObserved: number;
  /** Completions that matched a recorded start through the call id. */
  readonly correlatedCompletions: number;
  /** Completions observed without a recorded start. */
  readonly uncorrelatedCompletions: number;
  /** Repeated `tool.execute.before` events for an already pending call id. */
  readonly duplicateStartsIgnored: number;
  /** Repeated `tool.execute.after` events for an already completed call id. */
  readonly duplicateCompletionsIgnored: number;
  /** Tool calls seen to start but not yet seen to complete. */
  readonly pendingCalls: number;
  /** Pending calls dropped because the pending-call bound was reached. */
  readonly pendingCallsDropped: number;
}

/** Repeated-read counters for a session. */
export interface ReadObservationSummary {
  /** Total read requests observed, identified or not. */
  readonly requests: number;
  /** Requests that produced a usable file identity. */
  readonly identifiedRequests: number;
  /** Requests whose arguments carried no usable path. */
  readonly unidentifiedRequests: number;
  /** Identified requests whose offset/limit were present but unusable. */
  readonly malformedArgumentRequests: number;
  /** Distinct (file identity, offset, limit) keys observed. */
  readonly distinctTargets: number;
  /** Distinct keys requested more than once. */
  readonly repeatedTargets: number;
  /** Sum over keys of `count - 1`: potentially redundant read requests. */
  readonly repeatedRequests: number;
  /** Distinct keys dropped because the read-target bound was reached. */
  readonly targetsDropped: number;
  /** Static description of how a read identity is computed. */
  readonly identityScheme: string;
}

/**
 * How a V2 source-reported usage series may be interpreted.
 *
 * `unverified` is the only value this adapter currently emits.
 */
export type UsageAggregationSemantics = 'unverified';

/**
 * V2 source-reported usage for one session, preserved exactly as the source
 * reported it.
 *
 * Stage 1G observed OpenCode 2.0.24 emitting `session.usage.updated` with
 * `{ sessionID, cost, tokens: { input, output, reasoning, cache: { read, write } } }`
 * under `event.data`. The payload carries no message identifier, so it cannot be
 * attributed to a message the way a V1 `message.updated` record can, and it is
 * not accumulated into any session aggregate: whether each event is an
 * increment, a cumulative total, or a per-request snapshot is **unverified**.
 *
 * `latest` therefore holds the most recent numbers exactly as reported — it is a
 * snapshot, not a total — and `aggregation` says so explicitly.
 */
export interface SourceReportedUsageSummary {
  /** `session.usage.updated` events observed for this session. */
  readonly events: number;
  /** Of those, how many carried at least one usable field. */
  readonly usableEvents: number;
  /** Events reporting a usable value for each field. */
  readonly reportedByField: Readonly<Record<UsageField, number>>;
  /** The most recent reported value per field; `undefined` when absent. */
  readonly latest: Readonly<Record<UsageField, number | undefined>>;
  /** ISO timestamp of the most recent usable snapshot, or `never` if none. */
  readonly latestObservedAt: string;
  /** Static: the meaning of the series is not established. */
  readonly aggregation: UsageAggregationSemantics;
  /**
   * True while no field has ever reported a lower value than an earlier
   * snapshot. A decrease is evidence *against* cumulative semantics; the
   * absence of one does not prove cumulative semantics.
   */
  readonly monotonicNonDecreasing: boolean;
  /** How many field-level decreases were observed. */
  readonly decreasesObserved: number;
}

/** Usage counters for a session. */
export interface UsageObservationSummary {
  /** Distinct assistant message ids with a recorded usage record. */
  readonly messagesWithUsage: number;
  /** Assistant messages observed whose record carried no usable field. */
  readonly messagesWithoutUsage: number;
  /** Usage records discarded because the tracked-message bound was reached. */
  readonly usageRecordsDropped: number;
  /** Usage updates ignored because they carried no usable field. */
  readonly usageUpdatesIgnored: number;
  /** Usage updates that reported a lower value than already recorded. */
  readonly usageRegressionsObserved: number;
  /** `step-finish` parts observed (counted, deliberately not aggregated). */
  readonly stepFinishPartsObserved: number;
  /** Messages reporting a usable value for each field. */
  readonly reportedByField: Readonly<Record<UsageField, number>>;
  /** V2 source-reported usage, or `undefined` when the runtime reported none. */
  readonly sourceReported: SourceReportedUsageSummary | undefined;
}

/** Session lifecycle counters relevant to interpreting the other numbers. */
export interface SessionLifecycleSummary {
  readonly createdEvents: number;
  readonly idleEvents: number;
  readonly compactedEvents: number;
}

/**
 * Measurements derived for one session.
 *
 * `totalTokens` is deliberately always `unavailable`: OpenCode publishes no
 * session total, and input, output, reasoning and cache fields overlap, so
 * adding them would double count.
 */
export interface SessionObservationMeasurements {
  readonly toolStartsObserved: ObservationMeasurement<number>;
  readonly toolCompletionsObserved: ObservationMeasurement<number>;
  readonly readRequestsObserved: ObservationMeasurement<number>;
  readonly identifiedReadRequests: ObservationMeasurement<number>;
  readonly unidentifiedReadRequests: ObservationMeasurement<number>;
  readonly distinctReadTargets: ObservationMeasurement<number>;
  readonly repeatedReadTargets: ObservationMeasurement<number>;
  readonly repeatedFileReads: ObservationMeasurement<number>;
  readonly inputTokens: ObservationMeasurement<number>;
  readonly outputTokens: ObservationMeasurement<number>;
  readonly reasoningTokens: ObservationMeasurement<number>;
  readonly cacheReadTokens: ObservationMeasurement<number>;
  readonly cacheWriteTokens: ObservationMeasurement<number>;
  readonly cost: ObservationMeasurement<number>;
  readonly totalTokens: ObservationMeasurement<number>;
}

/**
 * A structured, content-free summary of one OpenCode session.
 *
 * It contains counts, hashed read identities, timestamps, and static notes. It
 * never contains prompts, source code, file paths, tool arguments, tool output,
 * credentials or API keys.
 */
export interface SessionObservationSummary {
  readonly schemaVersion: number;
  readonly adapter: ObserverAdapterIdentity;
  readonly sessionId: string;
  /** ISO timestamp of the first observation for this session. */
  readonly observedFromAt: string;
  /** ISO timestamp of the most recent observation for this session. */
  readonly observedToAt: string;
  readonly counts: SessionObservationCounts;
  /** Tool frequency, sorted by tool id, for deterministic output. */
  readonly toolFrequency: readonly ToolFrequencyEntry[];
  readonly reads: ReadObservationSummary;
  readonly usage: UsageObservationSummary;
  readonly lifecycle: SessionLifecycleSummary;
  readonly measurements: SessionObservationMeasurements;
  /** Static, content-free caveats that apply to this summary. */
  readonly notes: readonly string[];
}

/** Process-wide view of the observer, used for inspection and diagnostics. */
export interface ObserverSnapshot {
  readonly schemaVersion: number;
  readonly adapter: ObserverAdapterIdentity;
  readonly enabled: boolean;
  readonly disposed: boolean;
  readonly sessionCount: number;
  readonly sessions: readonly SessionObservationSummary[];
  readonly internalErrors: number;
  readonly eventsObserved: number;
  readonly eventsIgnored: number;
  readonly sessionsCreated: number;
  readonly sessionsEvicted: number;
  readonly sessionsClosed: number;
  readonly limits: ObservationLimits;
  readonly recentDiagnostics: readonly ObserverDiagnostic[];
}

/* -------------------------------------------------------------------------- */
/* Bounds, diagnostics, sinks and options                                      */
/* -------------------------------------------------------------------------- */

/**
 * Bounds on retained in-memory state.
 *
 * Observation state lives in memory only. These bounds keep a long-lived
 * OpenCode server process from growing without limit across many sessions.
 */
export interface ObservationLimits {
  readonly maxSessions: number;
  readonly maxPendingCalls: number;
  readonly maxReadTargets: number;
  readonly maxTrackedMessages: number;
  readonly maxDiagnostics: number;
}

/** Default bounds; chosen small enough to be harmless, large enough to be useful. */
export const DEFAULT_OBSERVATION_LIMITS: ObservationLimits = {
  maxSessions: 32,
  maxPendingCalls: 1024,
  maxReadTargets: 1024,
  maxTrackedMessages: 2048,
  maxDiagnostics: 64,
};

/** Stable diagnostic codes. Messages are static and content-free. */
export type ObserverDiagnosticCode =
  | 'observer-disabled'
  | 'observer-disposed'
  | 'hook-input-unusable'
  | 'duplicate-tool-start'
  | 'duplicate-tool-completion'
  | 'unidentified-read-request'
  | 'malformed-read-arguments'
  | 'read-target-limit-reached'
  | 'pending-call-limit-reached'
  | 'session-limit-reached'
  | 'message-usage-limit-reached'
  | 'usage-update-regression'
  | 'usage-update-ignored'
  | 'event-ignored'
  | 'plugin-options-ignored'
  | 'sink-failed'
  | 'unsupported-plugin-capability'
  | 'internal-failure';

/** Static, content-free text for every diagnostic code. */
export const OBSERVER_DIAGNOSTIC_MESSAGES: Readonly<Record<ObserverDiagnosticCode, string>> = {
  'observer-disabled': 'Observation is disabled; the event was not recorded.',
  'observer-disposed': 'The observer was disposed; the event was not recorded.',
  'hook-input-unusable': 'A hook delivered input without usable identifiers; it was not recorded.',
  'duplicate-tool-start': 'A tool start was already pending for this call id; it was not counted twice.',
  'duplicate-tool-completion': 'A tool completion was already recorded for this call id; it was not counted twice.',
  'unidentified-read-request': 'A read request carried no usable path and could not be identified.',
  'malformed-read-arguments': 'A read request carried an unusable offset or limit; documented defaults were applied.',
  'read-target-limit-reached': 'The read-target bound was reached; the oldest target was dropped.',
  'pending-call-limit-reached': 'The pending-call bound was reached; the oldest pending call was dropped.',
  'session-limit-reached': 'The session bound was reached; the least recently used session was evicted.',
  'message-usage-limit-reached': 'The tracked-message bound was reached; the oldest usage record was dropped.',
  'usage-update-regression': 'A usage update reported a lower value than already recorded; the higher value was kept.',
  'usage-update-ignored': 'A usage update carried no usable field and was ignored.',
  'event-ignored': 'The event type is not observed by this adapter.',
  'plugin-options-ignored': 'A plugin option was not usable and was ignored.',
  'sink-failed': 'The configured summary sink failed; the failure was contained.',
  'unsupported-plugin-capability':
    'The runtime did not expose a plugin capability this adapter needs; the affected observation is reported as unavailable rather than invented.',
  'internal-failure': 'An internal observer failure was contained; OpenCode behavior is unaffected.',
};

/** A content-free diagnostic record. */
export interface ObserverDiagnostic {
  readonly code: ObserverDiagnosticCode;
  readonly level: 'debug' | 'info' | 'warn';
  readonly message: string;
  /** ISO timestamp, or `unknown` when the clock was unusable. */
  readonly at: string;
}

/** Receives a per-session summary. Must not throw; failures are contained. */
export type ObservationSink = (summary: SessionObservationSummary) => void | Promise<void>;

/** Every diagnostic emitted for a code is at a fixed level. */
export const OBSERVER_DIAGNOSTIC_LEVELS: Readonly<Record<ObserverDiagnosticCode, ObserverDiagnostic['level']>> =
  {
    'observer-disabled': 'debug',
    'observer-disposed': 'debug',
    'hook-input-unusable': 'warn',
    'duplicate-tool-start': 'debug',
    'duplicate-tool-completion': 'debug',
    'unidentified-read-request': 'debug',
    'malformed-read-arguments': 'warn',
    'read-target-limit-reached': 'warn',
    'pending-call-limit-reached': 'warn',
    'session-limit-reached': 'warn',
    'message-usage-limit-reached': 'warn',
    'usage-update-regression': 'info',
    'usage-update-ignored': 'debug',
    'event-ignored': 'debug',
    'plugin-options-ignored': 'warn',
    'sink-failed': 'warn',
    'unsupported-plugin-capability': 'warn',
    'internal-failure': 'warn',
  };

/** Options accepted by the observer and by the plugin factory. */
export interface ObserverOptions {
  /** Explicit enable/disable. Default: enabled unless the environment disables it. */
  readonly enabled?: boolean;
  /**
   * Injectable clock (epoch milliseconds). Used so summaries and diagnostics are
   * deterministic in tests. Default: `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Injectable read-identity hasher. It must be one-way: the raw path is never
   * retained, so a reversible hasher would put file paths into summaries.
   * Default: SHA-256 truncated to 16 hexadecimal characters.
   */
  readonly hash?: (value: string) => string;
  /** Receives content-free diagnostics. Exceptions thrown here are contained. */
  readonly onDiagnostic?: (diagnostic: ObserverDiagnostic) => void;
  /** Receives per-session summaries. Default: none — the observer writes nothing. */
  readonly sink?: ObservationSink;
  /** Overrides for the retained-state bounds. */
  readonly limits?: Partial<ObservationLimits>;
  /** Environment source for the documented enable/disable and summary-file switches. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Recorded in summaries; defaults to the package revision. */
  readonly adapterRevision?: string;
  /**
   * Which OpenCode plugin API line this observer was attached to.
   * Defaults to V1, so an existing caller's summaries are unchanged.
   */
  readonly pluginApi?: ObserverPluginApiIdentity;
  /**
   * Milliseconds between checkpoint writes of changed sessions, when a sink is
   * configured. Defaults to {@link DEFAULT_CHECKPOINT_INTERVAL_MS}; `0` disables
   * checkpointing. Ignored entirely when no sink is configured, because the
   * observer then writes nothing at all.
   */
  readonly checkpointIntervalMs?: number;
}

/** Static caveats attached to every observation summary. */
export const OBSERVATION_NOTES: readonly string[] = [
  'Observation only: this summary describes recorded activity and does not prove that any token saving was achieved.',
  'Repeated reads are potentially redundant requests inferred from identical (file identity, offset, limit) keys, not measured savings.',
  'Token and cost values come from OpenCode usage records when the provider supplies them; a session total is never invented.',
];
