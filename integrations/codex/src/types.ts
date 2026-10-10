/**
 * Public contracts for the Dr. Token Codex observer adapter (Stage 1L).
 *
 * This adapter is **observation only**. It records what Codex did; it never
 * changes prompts, tool inputs, tool results, transcript content, or any agent
 * behavior. It has no way to influence Codex: its hook entry point writes
 * **nothing** to stdout and always exits 0.
 *
 * =====================================================================
 * VERIFIED CODEX HOOK CONTRACT
 * =====================================================================
 *
 * Runtime verified against the Codex build installed on the research machine
 * (Stage 1K): `codex-cli 0.162.0-alpha.17.2`, bundled by the Codex desktop app,
 * with the `hooks` feature flag reported `stable` and enabled by
 * `codex features list`, and hook definitions enumerated by `hooks/list` over the
 * app-server protocol (each definition carrying `eventName`, `handlerType`,
 * `currentHash` and `trustStatus`).
 *
 * Contract-confirmed quotes from the official hooks documentation
 * (<https://developers.openai.com/codex/hooks>):
 *
 *   "Hooks are an extensibility framework for Codex. They let you run scripts or
 *    MCP tools during the agentic loop"
 *   "Non-managed hooks must be reviewed and trusted before they run."
 *   "Every command hook receives one JSON object on stdin."
 *   "commandWindows is an optional Windows-only command override. In TOML, use
 *    command_windows or commandWindows."
 *
 * The documented event names, which this adapter registers against:
 *
 *   SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
 *   PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt,
 *   SessionEnd
 *
 * The documented common input fields (JSON on stdin):
 *
 *   session_id, transcript_path, cwd, hook_event_name, model,
 *   turn_id (turn-scoped), permission_mode (where documented)
 *
 * and the documented per-event additions this adapter reads:
 *
 *   PreToolUse          tool_name, tool_use_id, tool_input
 *   PostToolUse         tool_name, tool_use_id, tool_input, tool_response
 *   PermissionRequest   tool_name, tool_input
 *   UserPromptSubmit    prompt
 *   SessionStart        source   (startup | resume | clear | compact)
 *   SessionEnd          reason   (documented as always `other` today)
 *   PreCompact/PostCompact trigger (manual | auto)
 *   SubagentStart/Stop  agent_id, agent_type
 *   Stop/SubagentStop   stop_hook_active, last_assistant_message
 *
 * **Hooks do not carry token usage.** No documented hook payload field reports
 * input, output, cache or cost values. This adapter therefore reports every usage
 * measurement as `unavailable` and never derives tokens from text length or any
 * other unrelated value. See `CODEX_USAGE_UNAVAILABLE_NOTE`.
 *
 * A vendored copy of the exact documented shapes lives in
 * `tests/fixtures/codex-hooks.contract.ts`, so `npm run typecheck` fails if this
 * adapter drifts from the contract it claims to implement.
 */

/** Version of the observation summary schema. */
export const OBSERVATION_SCHEMA_VERSION = 1;

/** Package name recorded in every summary. */
export const CODEX_OBSERVER_ADAPTER_NAME = '@dr-token/codex-observer';

/**
 * Revision of this adapter, kept in sync with `package.json` by a test so a
 * recorded observation can never silently claim the wrong adapter revision.
 */
export const CODEX_OBSERVER_ADAPTER_REVISION = '0.0.0';

/** Product this adapter observes. */
export const CODEX_HOST_PRODUCT = 'codex';

/** Codex CLI version this adapter's contract was verified against (Stage 1K). */
export const CODEX_CLI_VERIFIED_VERSION = '0.162.0-alpha.17.2';

/**
 * The hook events this adapter registers and understands.
 *
 * Every one of them is an **observation** event. The adapter never returns a
 * `decision`, `permissionDecision`, `updatedInput`, `additionalContext` or
 * `continue` field, so registering these hooks cannot alter Codex behavior.
 */
export const IMPLEMENTED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
  'SessionEnd',
] as const;

export type CodexHookEventName = (typeof IMPLEMENTED_HOOK_EVENTS)[number];

/**
 * Environment switch that disables the observer.
 *
 * Any of `off`, `false`, `0`, `no` or `disabled` (case-insensitive) disables
 * observation. Disabled means the adapter records nothing; it cannot change what
 * Codex does either way.
 */
export const CODEX_OBSERVER_DISABLE_ENV_VAR = 'DR_TOKEN_CODEX_OBSERVER';

/**
 * Environment switch pointing at an opt-in JSON Lines summary file.
 *
 * The same variable name the OpenCode adapter uses, deliberately: both adapters
 * then feed one uniform evidence stream. Nothing is written unless this is
 * configured.
 */
export const CODEX_OBSERVER_SUMMARY_FILE_ENV_VAR = 'DR_TOKEN_OBSERVER_SUMMARY_FILE';

/**
 * Environment switch overriding where cross-process observation state lives.
 *
 * Default: `<system temp>/dr-token-codex-observer`. The adapter never writes into
 * the user's Codex home and never writes into the repository.
 */
export const CODEX_OBSERVER_STATE_DIR_ENV_VAR = 'DR_TOKEN_CODEX_STATE_DIR';

/** Environment switch that emits bounded, content-free diagnostics on stderr. */
export const CODEX_OBSERVER_DEBUG_ENV_VAR = 'DR_TOKEN_CODEX_DEBUG';

/** Session key used for events that carried no usable session identifier. */
export const UNATTRIBUTED_SESSION_KEY = '__unattributed__';

/** Session id recorded when the host reported none. */
export const UNKNOWN_SESSION_ID = 'unknown';

/* -------------------------------------------------------------------------- */
/* Evidence vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Evidence classification used by the observer.
 *
 * - `measured` — a direct observation (an observed hook event, a field the host
 *   actually sent).
 * - `calculated` — an aggregate derived from recorded measurements, such as a
 *   count or a repeated-read total. Never a savings claim.
 * - `estimated` — indirectly inferred without an authoritative record. This
 *   adapter produces no estimates; the class exists so a future inference cannot
 *   be mistaken for a measurement.
 * - `unavailable` — no reliable value exists. Always carries a reason.
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

/* -------------------------------------------------------------------------- */
/* Hook input contract (structural view)                                       */
/* -------------------------------------------------------------------------- */

/**
 * How the host delivered a hook payload.
 *
 * `flat` is the documented shape: one JSON object on stdin whose
 * `hook_event_name` names the event. `wrapped` is a defensive tolerance for a
 * payload that nests that object under `data`, `input`, `payload`, `event` or
 * `hook`; only `flat` has been observed. `unusable` means no event name could be
 * read at all.
 */
export type HookEnvelope = 'flat' | 'wrapped' | 'unusable';

/**
 * A normalized hook event.
 *
 * Every field is `T | undefined` rather than optional, so a caller must decide
 * what an absent value means instead of relying on `undefined` being spelled
 * either way.
 *
 * **Content is deliberately not retained here.** `toolInput` is held in memory
 * only: it is inspected to derive a one-way read identity and then dropped. Tool
 * responses and prompts are never captured at all — only whether they were
 * present and, for a response, its JSON kind. Nothing in this object is written
 * to a summary.
 */
export interface ParsedHookEvent {
  readonly usable: boolean;
  /** Why the payload was unusable; a static, content-free code. */
  readonly unusableReason: 'not-an-object' | 'missing-event-name' | undefined;
  readonly envelope: HookEnvelope;
  /** Known event name, or `unknown` when the host named an event we do not implement. */
  readonly eventName: CodexHookEventName | 'unknown';
  /** Whether the host's event name matched a registered event. */
  readonly recognized: boolean;
  readonly sessionId: string | undefined;
  /** True when the host supplied a usable session id. */
  readonly sessionReported: boolean;
  /** Working directory, memory only — hashed before anything is persisted. */
  readonly cwd: string | undefined;
  readonly turnId: string | undefined;
  readonly model: string | undefined;
  readonly permissionMode: string | undefined;
  readonly toolName: string | undefined;
  readonly toolUseId: string | undefined;
  /** Tool arguments, memory only: read for a one-way identity, then discarded. */
  readonly toolInput: unknown;
  readonly toolResponsePresent: boolean;
  readonly toolResponseKind: 'string' | 'object' | 'array' | 'null' | 'other' | undefined;
  readonly promptPresent: boolean;
  readonly sessionStartSource: SessionStartSource | undefined;
  readonly compactionTrigger: CompactionTrigger | undefined;
  readonly agentType: string | undefined;
  readonly stopHookActive: boolean | undefined;
}

/** Documented `SessionStart.source` values. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact' | 'unknown';

/** Documented `PreCompact` / `PostCompact` `trigger` values. */
export type CompactionTrigger = 'manual' | 'auto' | 'unknown';

/* -------------------------------------------------------------------------- */
/* Read identification                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Why a tool call was not counted as an identified file read.
 *
 * Every reason is a *refusal* to guess: the adapter would rather report an
 * unidentified read than invent a file identity or a session identifier.
 */
export type ReadIdentificationReason =
  /** A read-like tool carried no usable path argument. */
  | 'missing-path'
  /** A read-like tool carried range or argument keys this adapter does not model. */
  | 'unusable-input'
  /** A shell command was not a single, literal, single-file read. */
  | 'ambiguous-shell-read';

/** How a read identity was derived, recorded in summaries. */
export type ReadIdentityBasis = 'tool-argument' | 'shell-command';

/** A tool call recognized as a file read. */
export interface IdentifiedReadRequest {
  readonly identified: true;
  /** One-way identifier of the file; the raw path is discarded. */
  readonly targetId: string;
  /** Effective offset (documented default applied when absent). */
  readonly offset: number;
  /** Effective limit (documented default applied when absent). */
  readonly limit: number;
  /** Identity of this exact request: target plus range. */
  readonly key: string;
  readonly basis: ReadIdentityBasis;
  /** True when offset or limit was present but not a usable non-negative integer. */
  readonly malformed: boolean;
}

/** A tool call that could not be identified as a read. */
export interface UnidentifiedReadRequest {
  readonly identified: false;
  readonly reason: ReadIdentificationReason;
}

export type ReadIdentification = IdentifiedReadRequest | UnidentifiedReadRequest;

/* -------------------------------------------------------------------------- */
/* Observation records (persisted, content-free)                               */
/* -------------------------------------------------------------------------- */

/** Event kinds recorded in the per-session journal. */
export type ObservationRecordKind =
  | 'session-start'
  | 'session-end'
  | 'prompt'
  | 'tool-start'
  | 'tool-end'
  | 'permission-request'
  | 'compaction'
  | 'subagent-start'
  | 'subagent-stop'
  | 'stop'
  | 'interrupt'
  | 'ignored'
  | 'unusable';

/**
 * One journal line.
 *
 * This is the only thing the adapter persists per event. It contains counts,
 * opaque identifiers, small enums and **one-way read identities** — never a
 * prompt, a tool argument, a tool response, a file path or a credential.
 */
export interface ObservationRecord {
  /** Record schema version. */
  readonly v: 1;
  /** Epoch milliseconds, or `null` when the clock was unusable. */
  readonly at: number | null;
  readonly kind: ObservationRecordKind;
  /** Recorded once per session so a summary can name the session it describes. */
  readonly sessionId?: string | undefined;
  /** One-way hash of the normalized working directory; never the directory. */
  readonly cwdHash?: string | undefined;
  /** Session-start source, for `session-start` records. */
  readonly source?: SessionStartSource | undefined;
  /** Compaction trigger, for `compaction` records. */
  readonly trigger?: CompactionTrigger | undefined;
  /** Tool name for tool events; a bounded, sanitized identifier. */
  readonly tool?: string | undefined;
  /** Opaque tool-call id used only to correlate start and completion. */
  readonly call?: string | undefined;
  /** `target:offset:limit` identity for an identified read. */
  readonly read?: string | undefined;
  /** How the read identity was derived. */
  readonly readBasis?: ReadIdentityBasis | undefined;
  /** Why a read could not be identified. */
  readonly readReason?: ReadIdentificationReason | undefined;
  /** True when an identified read carried an unusable offset or limit. */
  readonly malformedRange?: boolean | undefined;
  /** JSON kind of the tool response; never its content. */
  readonly responseKind?: string | undefined;
  /** Subagent type for subagent events. */
  readonly agentType?: string | undefined;
  /** Canonical tool name carried by a permission request. */
  readonly permissionTool?: string | undefined;
  /** `stop_hook_active`, when the host reported it. */
  readonly stopHookActive?: boolean | undefined;
}

/* -------------------------------------------------------------------------- */
/* Observation summaries                                                       */
/* -------------------------------------------------------------------------- */

/** Static identity of the adapter and the host it observed. */
export interface CodexObserverAdapterIdentity {
  readonly name: typeof CODEX_OBSERVER_ADAPTER_NAME;
  readonly revision: string;
  readonly host: {
    readonly product: typeof CODEX_HOST_PRODUCT;
    readonly cliVersion: string;
  };
}

/** One tool id and how often it started and completed. */
export interface ToolFrequencyEntry {
  readonly tool: string;
  readonly started: number;
  readonly completed: number;
}

/** Per-session event counters. */
export interface CodexSessionCounts {
  /**
   * Every hook event folded for this session — including events that were only
   * counted as ignored or unusable. It always equals the number of journal
   * records folded, so it can be checked against `journal.records`.
   */
  readonly hookEventsObserved: number;
  readonly hookEventsIgnored: number;
  readonly unusablePayloads: number;
  readonly sessionStarts: number;
  readonly sessionEnds: number;
  readonly promptsSubmitted: number;
  readonly toolStartsObserved: number;
  readonly toolCompletionsObserved: number;
  /** Completions that matched a recorded start through the tool-call id. */
  readonly correlatedCompletions: number;
  /** Completions observed without a recorded start. */
  readonly uncorrelatedCompletions: number;
  /** Repeated `PreToolUse` events for an already pending call id. */
  readonly duplicateStartsIgnored: number;
  /** Repeated `PostToolUse` events for an already completed call id. */
  readonly duplicateCompletionsIgnored: number;
  /** Tool calls seen to start but not yet seen to complete. */
  readonly pendingCalls: number;
  /** Pending calls dropped because the pending-call bound was reached. */
  readonly pendingCallsDropped: number;
  readonly permissionRequests: number;
  readonly compactionEvents: number;
  readonly subagentStarts: number;
  readonly subagentStops: number;
  readonly stopEvents: number;
  readonly interruptEvents: number;
}

/** Repeated-read counters for a session. */
export interface ReadObservationSummary {
  /** Total read-like requests observed, identified or not. */
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

/** Where a session's project attribution came from. */
export type ProjectAttributionBasis = 'runtime-declared' | 'unavailable';

/**
 * Whether a session's project could be verified.
 *
 * Always `unverifiable` for Codex: hook payloads declare a working directory but
 * no project identity, and each hook invocation is a separate process with no
 * instance-level project to compare against. A directory hash is recorded so two
 * sessions can be told apart, but it is never presented as a verified project.
 */
export type ProjectScopeVerification = 'unverifiable';

/** Content-free project attribution for one session. */
export interface SessionProjectScope {
  readonly basis: ProjectAttributionBasis;
  readonly verification: ProjectScopeVerification;
  /** One-way hash of the normalized working directory, or `undefined`. */
  readonly directoryHash: string | undefined;
}

/** Measurements derived for one session. */
export interface CodexSessionMeasurements {
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

/** How complete the underlying record set is. */
export interface CodexJournalStatus {
  /** Journal records folded into this summary. */
  readonly records: number;
  /** True when the journal reached its capacity bound and later events were dropped. */
  readonly atCapacity: boolean;
  /** Compaction passes applied to this session's state. */
  readonly compactions: number;
  /** True when the summary came from a state snapshot plus journal. */
  readonly compacted: boolean;
}

/**
 * A structured, content-free summary of one Codex session.
 *
 * It contains counts, hashed read identities, hashed directory identities,
 * timestamps and static notes. It never contains prompts, source code, file
 * paths, tool arguments, tool output, credentials or API keys.
 */
export interface CodexSessionObservationSummary {
  readonly schemaVersion: number;
  readonly adapter: CodexObserverAdapterIdentity;
  /** Session id as the host reported it, or `unknown`. */
  readonly sessionId: string;
  /** Whether the host actually reported a session id. */
  readonly sessionIdentity: 'reported' | 'unknown';
  /** ISO timestamp of the first observation for this session. */
  readonly observedFromAt: string;
  /** ISO timestamp of the most recent observation for this session. */
  readonly observedToAt: string;
  readonly counts: CodexSessionCounts;
  /** Tool frequency, sorted by tool id, for deterministic output. */
  readonly toolFrequency: readonly ToolFrequencyEntry[];
  readonly reads: ReadObservationSummary;
  readonly project: SessionProjectScope;
  readonly measurements: CodexSessionMeasurements;
  readonly journal: CodexJournalStatus;
  /** Static, content-free caveats that apply to this summary. */
  readonly notes: readonly string[];
}

/** Receives a per-session summary. Must not throw; failures are contained. */
export type ObservationSink = (
  summary: CodexSessionObservationSummary,
) => void | Promise<void>;

/* -------------------------------------------------------------------------- */
/* Bounds, diagnostics and options                                             */
/* -------------------------------------------------------------------------- */

/**
 * Bounds on retained state.
 *
 * Codex runs each command hook as its own short-lived process, so state lives on
 * disk between invocations. These bounds keep that state small and make the
 * adapter drop observations rather than grow without limit.
 */
export interface ObservationLimits {
  /** Maximum journal lines before a compaction is attempted. */
  readonly maxJournalRecords: number;
  /** Hard cap on journal lines; beyond it, events are dropped and reported. */
  readonly maxJournalRecordsHard: number;
  /** Maximum distinct read targets retained per session. */
  readonly maxReadTargets: number;
  /** Maximum pending (started, not completed) tool calls retained per session. */
  readonly maxPendingCalls: number;
  /** Maximum distinct tools retained per session. */
  readonly maxTools: number;
  /** Maximum journal bytes read while folding, to bound hook latency. */
  readonly maxJournalBytes: number;
}

/** Default bounds; small enough to be harmless, large enough to be useful. */
export const DEFAULT_OBSERVATION_LIMITS: ObservationLimits = {
  maxJournalRecords: 512,
  maxJournalRecordsHard: 8_192,
  maxReadTargets: 512,
  maxPendingCalls: 512,
  maxTools: 128,
  maxJournalBytes: 4 * 1024 * 1024,
};

/** Stable diagnostic codes. Messages are static and content-free. */
export type ObserverDiagnosticCode =
  | 'observer-disabled'
  | 'hook-input-unusable'
  | 'unknown-event-ignored'
  | 'duplicate-tool-start'
  | 'duplicate-tool-completion'
  | 'unidentified-read-request'
  | 'malformed-read-arguments'
  | 'read-target-limit-reached'
  | 'pending-call-limit-reached'
  | 'journal-capacity-reached'
  | 'session-end-flushed'
  | 'state-unavailable'
  | 'compaction-skipped'
  | 'sink-failed'
  | 'stdin-unusable'
  | 'internal-failure';

/** Static, content-free text for every diagnostic code. */
export const OBSERVER_DIAGNOSTIC_MESSAGES: Readonly<Record<ObserverDiagnosticCode, string>> = {
  'observer-disabled': 'Observation is disabled; the event was not recorded.',
  'hook-input-unusable': 'A hook delivered a payload without a usable event name; it was not recorded.',
  'unknown-event-ignored': 'The event name is not one this adapter observes; it was counted and otherwise ignored.',
  'duplicate-tool-start': 'A tool start was already pending for this call id; it was not counted twice.',
  'duplicate-tool-completion': 'A tool completion was already recorded for this call id; it was not counted twice.',
  'unidentified-read-request': 'A read-like request carried no usable path and could not be identified.',
  'malformed-read-arguments': 'A read request carried an unusable offset or limit; documented defaults were applied.',
  'read-target-limit-reached': 'The read-target bound was reached; the oldest target was dropped.',
  'pending-call-limit-reached': 'The pending-call bound was reached; the oldest pending call was dropped.',
  'journal-capacity-reached': 'The journal capacity bound was reached; later events were dropped rather than grown.',
  'session-end-flushed': 'The session ended; its summary was written and its state was released.',
  'state-unavailable': 'Cross-process observation state could not be read or written; the observation was not recorded.',
  'compaction-skipped': 'A journal compaction could not be serialized and was skipped; the journal stays bounded.',
  'sink-failed': 'The configured summary sink failed; the failure was contained.',
  'stdin-unusable': 'The hook payload could not be read from stdin; nothing was recorded and nothing was changed.',
  'internal-failure': 'An internal observer failure was contained; Codex behavior is unaffected.',
};

/** Every diagnostic emitted for a code is at a fixed level. */
export const OBSERVER_DIAGNOSTIC_LEVELS: Readonly<Record<ObserverDiagnosticCode, 'debug' | 'info' | 'warn'>> =
  {
    'observer-disabled': 'debug',
    'hook-input-unusable': 'warn',
    'unknown-event-ignored': 'debug',
    'duplicate-tool-start': 'debug',
    'duplicate-tool-completion': 'debug',
    'unidentified-read-request': 'debug',
    'malformed-read-arguments': 'warn',
    'read-target-limit-reached': 'warn',
    'pending-call-limit-reached': 'warn',
    'journal-capacity-reached': 'warn',
    'session-end-flushed': 'info',
    'state-unavailable': 'warn',
    'compaction-skipped': 'warn',
    'sink-failed': 'warn',
    'stdin-unusable': 'warn',
    'internal-failure': 'warn',
  };

/** A content-free diagnostic record. */
export interface ObserverDiagnostic {
  readonly code: ObserverDiagnosticCode;
  readonly level: 'debug' | 'info' | 'warn';
  readonly message: string;
  /** ISO timestamp, or `unknown` when the clock was unusable. */
  readonly at: string;
}

/** Static caveats attached to every observation summary. */
export const OBSERVATION_NOTES: readonly string[] = [
  'Observation only: this summary describes recorded activity and does not prove that any token saving was achieved.',
  'Repeated reads are potentially redundant requests inferred from identical (file identity, offset, limit) keys, not measured savings.',
  'Codex hook payloads report no token or cost values, so every usage measurement is reported as unavailable rather than derived from text length.',
  'Tool responses and prompts are inspected for presence only; their content is never recorded.',
];

/** Note attached to every usage measurement, naming where usage could come from later. */
export const CODEX_USAGE_UNAVAILABLE_NOTE =
  'Codex lifecycle hooks do not carry token usage. Verified sources for a future measurement path are the app-server `thread/tokenUsage/updated` notification, rollout `token_count` records, `codex exec --json` turn usage, or the OpenTelemetry `codex.turn.token_usage` metric; none is implemented here.';

/** Static description of the read-identity scheme, surfaced in summaries. */
export const READ_IDENTITY_SCHEME =
  'sha256(normalized file path)[0:16] + read offset + read limit';

/** Options for a single hook-handling call. */
export interface HandleOptions {
  /** Injectable clock (epoch milliseconds). Default: `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Injectable read-identity hasher. Default: SHA-256 truncated to 16 hex characters. */
  readonly hash?: ((value: string) => string) | undefined;
  /** Receives content-free diagnostics. Exceptions thrown here are contained. */
  readonly onDiagnostic?: ((diagnostic: ObserverDiagnostic) => void) | undefined;
  /** Receives per-session summaries. Default: none — the adapter writes nothing. */
  readonly sink?: ObservationSink | undefined;
  /** Overrides for the retained-state bounds. */
  readonly limits?: Partial<ObservationLimits> | undefined;
  /** Environment source for the documented switches. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Recorded in summaries; defaults to the package revision. */
  readonly adapterRevision?: string | undefined;
  /** Cross-process state root; defaults to the environment override or the temp directory. */
  readonly stateDir?: string | undefined;
  /**
   * Journal size, in bytes, that triggers a compaction attempt.
   *
   * Exposed so a test can exercise compaction without writing megabytes; the
   * production default is {@link COMPACTION_TRIGGER_BYTES}.
   */
  readonly compactionTriggerBytes?: number | undefined;
}

/** Result of handling one hook payload. `stdout` is always empty by construction. */
export interface HandleResult {
  readonly recorded: boolean;
  readonly disabled: boolean;
  readonly eventName: CodexHookEventName | 'unknown';
  readonly sessionKey: string;
  readonly diagnostics: readonly ObserverDiagnostic[];
  /** The only thing the entry point may print. Always the empty string. */
  readonly stdout: '';
}
