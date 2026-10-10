import { defaultHash } from './hash.js';
import { READ_IDENTITY_SCHEME, READ_TOOL_ID, identifyReadRequest } from './read.js';
import { createSummaryFileSink, isUsableSummaryPath, resolveEnvironmentSink } from './sink.js';
import {
  compareSessionUsage,
  extractAssistantUsage,
  extractSessionUsage,
  mergeUsageSnapshots,
  sessionUsageFields,
} from './usage.js';
import type { MessageUsageSnapshot, SessionUsageSnapshot } from './usage.js';
import {
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_OBSERVATION_LIMITS,
  DEFAULT_OBSERVER_PLUGIN_API,
  OBSERVATION_NOTES,
  OPENCODE_V2_EXECUTION_SUCCEEDED_EVENT_TYPE,
  OPENCODE_V2_USAGE_EVENT_TYPE,
  OBSERVATION_SCHEMA_VERSION,
  OBSERVER_ADAPTER_NAME,
  OBSERVER_ADAPTER_REVISION,
  OBSERVER_DIAGNOSTIC_LEVELS,
  OBSERVER_DIAGNOSTIC_MESSAGES,
  OBSERVER_DISABLE_ENV_VAR,
  USAGE_FIELDS,
} from './types.js';
import type {
  ObservationLimits,
  ObservationMeasurement,
  ObservationSink,
  ObserverAdapterIdentity,
  ObserverDiagnostic,
  ObserverDiagnosticCode,
  ObserverOptions,
  ObserverPluginApiIdentity,
  ObserverSnapshot,
  OpenCodeEventHookInput,
  OpenCodeToolExecuteAfterInput,
  OpenCodeToolExecuteAfterOutput,
  OpenCodeToolExecuteBeforeInput,
  OpenCodeToolExecuteBeforeOutput,
  ReadObservationSummary,
  SessionLifecycleSummary,
  SourceReportedUsageSummary,
  SessionObservationCounts,
  SessionObservationMeasurements,
  SessionObservationSummary,
  ToolFrequencyEntry,
  UsageField,
  UsageObservationSummary,
} from './types.js';

/*
 * Static, content-free notes. Every one of these must stay free of paths,
 * prompts, identifiers and tool content, because they ship inside summaries.
 */
/**
 * Used when the runtime reported V2 usage snapshots that are not aggregated.
 *
 * The numbers are preserved in `usage.sourceReported`; this explains why no
 * session aggregate is derived from them, and states the one thing that was
 * measured about the series so a reader is not left guessing.
 */
const NOTE_SOURCE_REPORTED_NOT_AGGREGATED =
  'The runtime reported session usage snapshots. No session aggregate is derived from them: whether a snapshot is an increment, a running total or a per-request value is not a published contract. In the one session measured so far the series behaved like a running session total, and its last snapshot equalled the totals the runtime itself stored for that session. The numbers are preserved as reported under usage.sourceReported.';

const NOTE_NO_TOOL_ACTIVITY =
  'No tool execution was observed for this session; counts exclude any work that happened before the plugin was loaded.';
const NOTE_NO_READS = 'No read request was observed for this session.';
const NOTE_NO_USAGE_FIELD =
  'No assistant message in this session reported this field; OpenCode publishes no session-level total and Dr. Token does not infer one.';
const NOTE_COST_NOT_REPORTED =
  'No assistant message in this session reported a cost; Dr. Token never estimates cost.';
const NOTE_TOTAL_TOKENS_NOT_DERIVED =
  'Total tokens are deliberately not derived: OpenCode publishes no session total and the input, output, reasoning and cache fields overlap, so summing them could double count.';

/** Values of the disable switch that turn observation off. */
const DISABLE_VALUES: readonly string[] = ['off', 'false', '0', 'no', 'disabled'];

/**
 * Read the documented disable switch from an environment record.
 *
 * Exported because it is part of the documented bypass contract: the switch must
 * work for deployments that can only edit `opencode.json`.
 */
export function isDisabledByEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = env[OBSERVER_DISABLE_ENV_VAR];
  return typeof value === 'string' && DISABLE_VALUES.includes(value.trim().toLowerCase());
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  if (typeof process === 'undefined' || process.env === null || process.env === undefined) {
    return {};
  }
  return process.env;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a non-empty identifier, trimming surrounding whitespace. */
function readIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Remember a key in a bounded set, dropping the oldest entry when full. */
function rememberBounded(set: Set<string>, key: string, limit: number): void {
  if (set.has(key)) {
    return;
  }
  set.add(key);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) {
      return;
    }
    set.delete(oldest);
  }
}

function toPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveLimits(overrides: Partial<ObservationLimits> | undefined): ObservationLimits {
  const provided = overrides ?? {};
  return {
    maxSessions: toPositiveInteger(provided.maxSessions, DEFAULT_OBSERVATION_LIMITS.maxSessions),
    maxPendingCalls: toPositiveInteger(
      provided.maxPendingCalls,
      DEFAULT_OBSERVATION_LIMITS.maxPendingCalls,
    ),
    maxReadTargets: toPositiveInteger(
      provided.maxReadTargets,
      DEFAULT_OBSERVATION_LIMITS.maxReadTargets,
    ),
    maxTrackedMessages: toPositiveInteger(
      provided.maxTrackedMessages,
      DEFAULT_OBSERVATION_LIMITS.maxTrackedMessages,
    ),
    maxDiagnostics: toPositiveInteger(
      provided.maxDiagnostics,
      DEFAULT_OBSERVATION_LIMITS.maxDiagnostics,
    ),
  };
}

function measured(value: number): ObservationMeasurement<number> {
  return { evidence: 'measured', value };
}

function calculated(value: number): ObservationMeasurement<number> {
  return { evidence: 'calculated', value };
}

function unavailable(note: string): ObservationMeasurement<number> {
  return { evidence: 'unavailable', note };
}

function emptyUsageFieldCounts(): Record<UsageField, number> {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function emptyUsageFieldValues(): Record<UsageField, number | undefined> {
  return {
    input: undefined,
    output: undefined,
    reasoning: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    cost: undefined,
  };
}

/**
 * Build one token/cost measurement from per-message records and V2 snapshots.
 *
 * - per-message records exist -> the sum of them, classified `calculated`
 *   (an aggregate of measurements, never a direct reading);
 * - no records but V2 snapshots exist -> `unavailable`, explaining that the
 *   reported snapshots are preserved but not aggregated;
 * - nothing at all -> `unavailable` with the caller's note (or the shared one).
 */
function tokenMeasurement(
  reportedMessages: number,
  summed: number,
  sourceReported: SourceReportedUsageSummary | undefined,
  emptyNote: string = NOTE_NO_USAGE_FIELD,
): ObservationMeasurement<number> {
  if (reportedMessages > 0) {
    return calculated(summed);
  }
  if (sourceReported !== undefined && sourceReported.usableEvents > 0) {
    return unavailable(NOTE_SOURCE_REPORTED_NOT_AGGREGATED);
  }
  return unavailable(emptyNote);
}

/** A tool call that started but whose completion has not been observed yet. */
interface PendingCall {
  readonly tool: string;
}

/** Everything the observer retains for one OpenCode session. */
interface SessionState {
  readonly sessionId: string;
  firstObservedAt: number;
  lastObservedAt: number;
  readonly toolStarted: Map<string, number>;
  readonly toolCompleted: Map<string, number>;
  readonly pending: Map<string, PendingCall>;
  pendingCallsDropped: number;
  readonly readTargets: Map<string, number>;
  readTargetsDropped: number;
  readRequests: number;
  identifiedReadRequests: number;
  unidentifiedReadRequests: number;
  malformedReadArguments: number;
  readonly readCallIds: Set<string>;
  readonly completedCallIds: Set<string>;
  duplicateStartsIgnored: number;
  duplicateCompletionsIgnored: number;
  correlatedCompletions: number;
  uncorrelatedCompletions: number;
  readonly usage: Map<string, MessageUsageSnapshot>;
  usageRecordsDropped: number;
  usageUpdatesIgnored: number;
  usageRegressionsObserved: number;
  messagesWithoutUsage: number;
  stepFinishPartsObserved: number;
  /**
   * V2 source-reported usage, preserved as reported and never accumulated.
   *
   * Kept separate from `usage` (the per-message map) because a V2 snapshot has no
   * message identifier, so folding it into the message map would invent an
   * attribution the source did not provide.
   */
  readonly sourceUsage: SourceUsageState;
  createdEvents: number;
  idleEvents: number;
  compactedEvents: number;
}

/** Mutable tracking for the V2 source-reported usage series of one session. */
interface SourceUsageState {
  events: number;
  usableEvents: number;
  readonly reportedByField: Record<UsageField, number>;
  latest: SessionUsageSnapshot | undefined;
  latestAt: number;
  monotonicNonDecreasing: boolean;
  decreasesObserved: number;
}

function createSessionState(sessionId: string, at: number): SessionState {
  return {
    sessionId,
    firstObservedAt: at,
    lastObservedAt: at,
    toolStarted: new Map(),
    toolCompleted: new Map(),
    pending: new Map(),
    pendingCallsDropped: 0,
    readTargets: new Map(),
    readTargetsDropped: 0,
    readRequests: 0,
    identifiedReadRequests: 0,
    unidentifiedReadRequests: 0,
    malformedReadArguments: 0,
    readCallIds: new Set(),
    completedCallIds: new Set(),
    duplicateStartsIgnored: 0,
    duplicateCompletionsIgnored: 0,
    correlatedCompletions: 0,
    uncorrelatedCompletions: 0,
    usage: new Map(),
    usageRecordsDropped: 0,
    usageUpdatesIgnored: 0,
    usageRegressionsObserved: 0,
    messagesWithoutUsage: 0,
    stepFinishPartsObserved: 0,
    sourceUsage: {
      events: 0,
      usableEvents: 0,
      reportedByField: emptyUsageFieldCounts(),
      latest: undefined,
      latestAt: 0,
      monotonicNonDecreasing: true,
      decreasesObserved: 0,
    },
    createdEvents: 0,
    idleEvents: 0,
    compactedEvents: 0,
  };
}

/**
 * Observation-only OpenCode observer.
 *
 * Responsibilities: count tool executions, track tool frequency, identify
 * potentially repeated read requests per session, and collect the token and cost
 * fields OpenCode actually reports. It holds no reference to any hook input or
 * output after a call returns, writes nothing unless a sink is configured, and
 * never throws into OpenCode.
 *
 * State is in memory only and bounded by {@link ObservationLimits}.
 */
export class OpenCodeObserver {
  readonly #limits: ObservationLimits;
  readonly #now: () => number;
  readonly #hash: (value: string) => string;
  readonly #onDiagnostic: ((diagnostic: ObserverDiagnostic) => void) | undefined;
  readonly #adapterRevision: string;
  readonly #pluginApi: ObserverPluginApiIdentity;
  readonly #checkpointIntervalMs: number;
  readonly #sessions = new Map<string, SessionState>();
  readonly #recentDiagnostics: ObserverDiagnostic[] = [];
  /** Sessions changed since their last write, awaiting a checkpoint. */
  readonly #dirtySessions = new Set<string>();
  #checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes sink writes so append order matches schedule order. */
  #writeChain: Promise<void> = Promise.resolve();
  #sink: ObservationSink | undefined;
  #enabled: boolean;
  #disposed = false;
  #internalErrors = 0;
  #eventsObserved = 0;
  #eventsIgnored = 0;
  #sessionsCreated = 0;
  #sessionsEvicted = 0;
  #sessionsClosed = 0;

  constructor(options: ObserverOptions = {}) {
    this.#onDiagnostic = options.onDiagnostic;
    this.#limits = resolveLimits(options.limits);
    this.#now = options.now ?? Date.now;
    this.#hash = options.hash ?? defaultHash;
    this.#adapterRevision = options.adapterRevision ?? OBSERVER_ADAPTER_REVISION;
    this.#pluginApi = { ...(options.pluginApi ?? DEFAULT_OBSERVER_PLUGIN_API) };
    const interval = options.checkpointIntervalMs;
    this.#checkpointIntervalMs =
      typeof interval === 'number' && Number.isInteger(interval) && interval >= 0
        ? interval
        : DEFAULT_CHECKPOINT_INTERVAL_MS;

    const env = options.env ?? readProcessEnv();
    this.#sink = options.sink ?? resolveEnvironmentSink(env);
    this.#enabled = options.enabled ?? !isDisabledByEnvironment(env);
  }

  /** Whether observation is currently enabled. */
  isEnabled(): boolean {
    return this.#enabled;
  }

  /**
   * Global bypass.
   *
   * Disabling stops all recording; it does not change what OpenCode does, and it
   * does not discard summaries already produced.
   */
  setEnabled(value: boolean): void {
    const next = value === true;
    if (next === this.#enabled) {
      return;
    }
    this.#enabled = next;
    if (!next) {
      this.#diagnose('observer-disabled');
    }
  }

  /** Replace the summary sink. Passing `undefined` removes it (the default). */
  setSink(sink: ObservationSink | undefined): void {
    this.#sink = sink;
  }

  /**
   * Apply the options OpenCode passes to a plugin (`PluginOptions`).
   *
   * Recognised keys are `enabled` (boolean) and `summaryFile` (string path);
   * anything else is ignored with a content-free diagnostic. A sink configured
   * in code always wins over `summaryFile`, so an explicit `sink` cannot be
   * replaced by configuration.
   */
  applyPluginOptions(options: Readonly<Record<string, unknown>> | undefined): void {
    if (options === undefined || options === null) {
      return;
    }
    const enabled = options['enabled'];
    if (typeof enabled === 'boolean') {
      this.setEnabled(enabled);
    } else if (enabled !== undefined) {
      this.#diagnose('plugin-options-ignored');
    }

    const summaryFile = options['summaryFile'];
    if (summaryFile === undefined) {
      return;
    }
    if (!isUsableSummaryPath(summaryFile)) {
      this.#diagnose('plugin-options-ignored');
      return;
    }
    if (this.#sink !== undefined) {
      return;
    }
    this.#sink = createSummaryFileSink(summaryFile.trim());
  }

  /** The effective bounds, exposed so a summary can be interpreted. */
  getLimits(): ObservationLimits {
    return { ...this.#limits };
  }

  /** Sessions currently retained, sorted for deterministic output. */
  getSessionIds(): readonly string[] {
    return [...this.#sessions.keys()].sort();
  }

  /** Summaries for every retained session, sorted by session id. */
  getSummaries(): readonly SessionObservationSummary[] {
    const summaries: SessionObservationSummary[] = [];
    for (const sessionId of this.getSessionIds()) {
      const state = this.#sessions.get(sessionId);
      if (state !== undefined) {
        summaries.push(this.#summarizeState(state));
      }
    }
    return summaries;
  }

  /** Summary for one session, or `undefined` when nothing was observed. */
  getSummary(sessionId: string): SessionObservationSummary | undefined {
    const state = this.#sessions.get(sessionId);
    return state === undefined ? undefined : this.#summarizeState(state);
  }

  /** Pretty-printed JSON for one session, or `undefined` when unknown. */
  serializeSummary(sessionId: string): string | undefined {
    const summary = this.getSummary(sessionId);
    return summary === undefined ? undefined : JSON.stringify(summary, null, 2);
  }

  /** Content-free process-wide snapshot, for inspection and tests. */
  getSnapshot(): ObserverSnapshot {
    return {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      adapter: this.#adapterIdentity(),
      enabled: this.#enabled,
      disposed: this.#disposed,
      sessionCount: this.#sessions.size,
      sessions: this.getSummaries(),
      internalErrors: this.#internalErrors,
      eventsObserved: this.#eventsObserved,
      eventsIgnored: this.#eventsIgnored,
      sessionsCreated: this.#sessionsCreated,
      sessionsEvicted: this.#sessionsEvicted,
      sessionsClosed: this.#sessionsClosed,
      limits: this.getLimits(),
      recentDiagnostics: [...this.#recentDiagnostics],
    };
  }

  /** Forget all retained state without disposing the observer. */
  clear(): void {
    this.#sessions.clear();
    this.#dirtySessions.clear();
    this.#clearCheckpointTimer();
  }

  /**
   * Flush retained sessions to the sink and stop observing.
   *
   * Safe to call more than once. Never throws.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#clearCheckpointTimer();
    this.#disposed = true;
    const pending = [...this.#sessions.values()];
    try {
      for (const state of pending) {
        await this.#flush(state);
      }
      // Wait for every queued write, so a caller that awaits dispose() knows the
      // summaries have actually reached the sink.
      await this.#writeChain;
    } catch {
      this.noteInternalFailure();
    }
    this.#sessionsClosed += pending.length;
    this.#sessions.clear();
    this.#dirtySessions.clear();
    this.#diagnose('observer-disposed');
  }

  /**
   * Record that a hook body failed.
   *
   * Public so the plugin wrapper can report a failure without throwing.
   */
  noteInternalFailure(): void {
    this.#internalErrors += 1;
    this.#diagnose('internal-failure');
  }

  /**
   * Record that the runtime did not expose a capability the adapter needs.
   *
   * Public so an adapter (for example the V2 adapter, whose host may not provide
   * `ctx.tool` or `ctx.event`) can report the gap without inventing a value. The
   * affected observations stay `unavailable`.
   */
  noteUnsupportedCapability(): void {
    this.#diagnose('unsupported-plugin-capability');
  }

  /* ---------------------------------------------------------------------- */
  /* Hook entry points                                                      */
  /* ---------------------------------------------------------------------- */

  /** `tool.execute.before`. Observation only: arguments are never modified. */
  observeToolBefore(
    input: OpenCodeToolExecuteBeforeInput,
    output: OpenCodeToolExecuteBeforeOutput,
  ): void {
    try {
      if (!this.#canObserve()) {
        return;
      }
      this.#toolBefore(input, output);
    } catch {
      this.noteInternalFailure();
    }
  }

  /** `tool.execute.after`. Observation only: the result is never modified. */
  observeToolAfter(
    input: OpenCodeToolExecuteAfterInput,
    output: OpenCodeToolExecuteAfterOutput,
  ): void {
    try {
      if (!this.#canObserve()) {
        return;
      }
      this.#toolAfter(input, output);
    } catch {
      this.noteInternalFailure();
    }
  }

  /** `event`. Reads usage and lifecycle information; mutates nothing. */
  async observeEvent(input: OpenCodeEventHookInput): Promise<void> {
    try {
      if (!this.#canObserve()) {
        return;
      }
      await this.#handleEvent(input);
    } catch {
      this.noteInternalFailure();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  #canObserve(): boolean {
    return this.#enabled && !this.#disposed;
  }

  #adapterIdentity(): ObserverAdapterIdentity {
    return {
      name: OBSERVER_ADAPTER_NAME,
      revision: this.#adapterRevision,
      pluginApi: { ...this.#pluginApi },
    };
  }

  #timestamp(): number {
    try {
      const value = this.#now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  #isoNow(): string {
    try {
      return new Date(this.#timestamp()).toISOString();
    } catch {
      return 'unknown';
    }
  }

  #diagnose(code: ObserverDiagnosticCode): void {
    const diagnostic: ObserverDiagnostic = {
      code,
      level: OBSERVER_DIAGNOSTIC_LEVELS[code],
      message: OBSERVER_DIAGNOSTIC_MESSAGES[code],
      at: this.#isoNow(),
    };
    this.#recentDiagnostics.push(diagnostic);
    while (this.#recentDiagnostics.length > this.#limits.maxDiagnostics) {
      this.#recentDiagnostics.shift();
    }
    const callback = this.#onDiagnostic;
    if (callback === undefined) {
      return;
    }
    try {
      callback(diagnostic);
    } catch {
      // A broken diagnostic callback must never affect OpenCode.
    }
  }

  #session(sessionId: string): SessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.#sessions.size >= this.#limits.maxSessions) {
      this.#evictLeastRecentlyUsedSession();
    }
    const created = createSessionState(sessionId, this.#timestamp());
    this.#sessions.set(sessionId, created);
    this.#sessionsCreated += 1;
    return created;
  }

  #evictLeastRecentlyUsedSession(): void {
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, state] of this.#sessions) {
      if (state.lastObservedAt < oldestAt) {
        oldestAt = state.lastObservedAt;
        oldestId = id;
      }
    }
    if (oldestId === undefined) {
      return;
    }
    const evicted = this.#sessions.get(oldestId);
    this.#sessions.delete(oldestId);
    this.#sessionsEvicted += 1;
    this.#diagnose('session-limit-reached');
    if (evicted !== undefined) {
      void this.#flush(evicted);
    }
  }

  #touch(state: SessionState): void {
    state.lastObservedAt = this.#timestamp();
  }

  #toolBefore(input: unknown, output: unknown): void {
    const inputRecord = asRecord(input);
    const tool = readIdentifier(inputRecord?.['tool']);
    const sessionId = readIdentifier(inputRecord?.['sessionID']);
    const callId = readIdentifier(inputRecord?.['callID']);
    if (tool === undefined || sessionId === undefined || callId === undefined) {
      this.#diagnose('hook-input-unusable');
      return;
    }
    this.#eventsObserved += 1;

    const state = this.#session(sessionId);
    this.#touch(state);

    if (state.pending.has(callId)) {
      state.duplicateStartsIgnored += 1;
      this.#diagnose('duplicate-tool-start');
      return;
    }

    // The read request is accounted from the arguments, which are only
    // guaranteed to be present in this hook. Only the derived identity and the
    // range are kept; the path itself is discarded immediately. A failure here
    // is contained locally so it cannot also lose the tool-call count.
    if (tool === READ_TOOL_ID) {
      try {
        this.#accountReadRequest(state, callId, asRecord(output)?.['args']);
      } catch {
        this.noteInternalFailure();
      }
    }

    state.pending.set(callId, { tool });
    bump(state.toolStarted, tool);
    this.#trimPendingCalls(state);
    this.#markDirty(state);
  }

  #trimPendingCalls(state: SessionState): void {
    while (state.pending.size > this.#limits.maxPendingCalls) {
      const oldest = state.pending.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      state.pending.delete(oldest);
      state.pendingCallsDropped += 1;
      this.#diagnose('pending-call-limit-reached');
    }
  }

  #toolAfter(input: unknown, _output: unknown): void {
    const inputRecord = asRecord(input);
    const tool = readIdentifier(inputRecord?.['tool']);
    const sessionId = readIdentifier(inputRecord?.['sessionID']);
    const callId = readIdentifier(inputRecord?.['callID']);
    if (tool === undefined || sessionId === undefined || callId === undefined) {
      this.#diagnose('hook-input-unusable');
      return;
    }
    this.#eventsObserved += 1;

    const state = this.#session(sessionId);
    this.#touch(state);

    const pending = state.pending.get(callId);
    let completedTool = tool;
    if (pending !== undefined) {
      state.pending.delete(callId);
      state.correlatedCompletions += 1;
      // Use the tool recorded at start so a mismatched id cannot split a count.
      completedTool = pending.tool;
    } else {
      if (state.completedCallIds.has(callId)) {
        state.duplicateCompletionsIgnored += 1;
        this.#diagnose('duplicate-tool-completion');
        return;
      }
      state.uncorrelatedCompletions += 1;
    }

    rememberBounded(state.completedCallIds, callId, this.#limits.maxPendingCalls);
    bump(state.toolCompleted, completedTool);

    // A read completion with no recorded start is still a real read request, and
    // it is the only chance to observe one. The call id keeps it from being
    // counted twice when both hooks fired.
    if (completedTool === READ_TOOL_ID && pending === undefined) {
      this.#accountReadRequest(state, callId, asRecord(inputRecord?.['args']));
    }
    this.#markDirty(state);
  }

  #accountReadRequest(state: SessionState, callId: string, args: unknown): void {
    if (state.readCallIds.has(callId)) {
      return;
    }
    // Identify first: if hashing fails, no counter is left half-updated.
    const identification = identifyReadRequest(args, this.#hash);
    rememberBounded(state.readCallIds, callId, this.#limits.maxPendingCalls);

    state.readRequests += 1;
    if (!identification.identified) {
      state.unidentifiedReadRequests += 1;
      this.#diagnose('unidentified-read-request');
      return;
    }

    state.identifiedReadRequests += 1;
    if (identification.malformed) {
      state.malformedReadArguments += 1;
      this.#diagnose('malformed-read-arguments');
    }

    const previous = state.readTargets.get(identification.key);
    if (previous !== undefined) {
      state.readTargets.set(identification.key, previous + 1);
      return;
    }
    while (state.readTargets.size >= this.#limits.maxReadTargets) {
      const oldest = state.readTargets.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      state.readTargets.delete(oldest);
      state.readTargetsDropped += 1;
      this.#diagnose('read-target-limit-reached');
    }
    state.readTargets.set(identification.key, 1);
  }

  #recordUsage(state: SessionState, snapshot: MessageUsageSnapshot): void {
    const previous = state.usage.get(snapshot.messageId);
    if (previous === undefined) {
      while (state.usage.size >= this.#limits.maxTrackedMessages) {
        const oldest = state.usage.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        state.usage.delete(oldest);
        state.usageRecordsDropped += 1;
        this.#diagnose('message-usage-limit-reached');
      }
      state.usage.set(snapshot.messageId, snapshot);
      this.#markDirty(state);
      return;
    }
    const merged = mergeUsageSnapshots(previous, snapshot);
    state.usage.set(snapshot.messageId, merged.snapshot);
    if (merged.regressed) {
      state.usageRegressionsObserved += 1;
      this.#diagnose('usage-update-regression');
    }
    this.#markDirty(state);
  }

  async #handleEvent(input: unknown): Promise<void> {
    const event = asRecord(asRecord(input)?.['event']);
    const type = readIdentifier(event?.['type']);
    if (event === undefined || type === undefined) {
      this.#diagnose('hook-input-unusable');
      return;
    }
    this.#eventsObserved += 1;
    // V1 delivers event payloads under `properties`; V2 delivers them under `data`
    // (runtime-confirmed in Stage 1G). `properties` wins when both are present so
    // V1 behaviour is bit-for-bit unchanged.
    const properties = asRecord(event['properties']) ?? asRecord(event['data']);

    switch (type) {
      case 'message.updated': {
        const info = properties?.['info'];
        const extraction = extractAssistantUsage(info);
        if (extraction.kind === 'recorded') {
          const state = this.#session(extraction.snapshot.sessionId);
          this.#touch(state);
          this.#recordUsage(state, extraction.snapshot);
          return;
        }
        const sessionId = readIdentifier(asRecord(info)?.['sessionID']);
        if (extraction.reason === 'no-usage-fields' && sessionId !== undefined) {
          const state = this.#session(sessionId);
          this.#touch(state);
          state.messagesWithoutUsage += 1;
          state.usageUpdatesIgnored += 1;
          this.#diagnose('usage-update-ignored');
          return;
        }
        this.#eventsIgnored += 1;
        return;
      }
      case OPENCODE_V2_USAGE_EVENT_TYPE: {
        const extraction = extractSessionUsage(properties);
        if (extraction.kind === 'ignored') {
          const sessionId = readIdentifier(properties?.['sessionID']);
          const state = sessionId === undefined ? undefined : this.#session(sessionId);
          if (state !== undefined && extraction.reason === 'no-usage-fields') {
            this.#touch(state);
            state.sourceUsage.events += 1;
            state.usageUpdatesIgnored += 1;
            this.#diagnose('usage-update-ignored');
            this.#markDirty(state);
            return;
          }
          this.#eventsIgnored += 1;
          return;
        }
        const state = this.#session(extraction.snapshot.sessionId);
        this.#touch(state);
        this.#recordSourceUsage(state, extraction.snapshot);
        return;
      }
      case OPENCODE_V2_EXECUTION_SUCCEEDED_EVENT_TYPE: {
        // A flush trigger only: writing a summary makes no behavioural claim, and
        // this event is deliberately not counted as a V1 `session.idle`.
        const sessionId = readIdentifier(properties?.['sessionID']);
        const state = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
        if (state === undefined) {
          this.#eventsIgnored += 1;
          return;
        }
        this.#touch(state);
        await this.#flush(state);
        return;
      }
      case 'message.part.updated': {
        const part = asRecord(properties?.['part']);
        if (part?.['type'] !== 'step-finish') {
          this.#eventsIgnored += 1;
          return;
        }
        const sessionId = readIdentifier(part['sessionID']);
        if (sessionId === undefined) {
          this.#diagnose('hook-input-unusable');
          return;
        }
        const state = this.#session(sessionId);
        this.#touch(state);
        // Counted only. Step usage overlaps with the parent assistant message, so
        // it is never added to the session aggregates.
        state.stepFinishPartsObserved += 1;
        return;
      }
      case 'message.removed': {
        const sessionId = readIdentifier(properties?.['sessionID']);
        const messageId = readIdentifier(properties?.['messageID']);
        if (sessionId === undefined || messageId === undefined) {
          this.#diagnose('hook-input-unusable');
          return;
        }
        this.#sessions.get(sessionId)?.usage.delete(messageId);
        return;
      }
      case 'session.created': {
        const sessionId = readIdentifier(asRecord(properties?.['info'])?.['id']);
        if (sessionId === undefined) {
          this.#diagnose('hook-input-unusable');
          return;
        }
        const state = this.#session(sessionId);
        this.#touch(state);
        state.createdEvents += 1;
        return;
      }
      case 'session.updated': {
        const sessionId = readIdentifier(asRecord(properties?.['info'])?.['id']);
        const state = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
        if (state !== undefined) {
          this.#touch(state);
        }
        return;
      }
      case 'session.idle': {
        const sessionId = readIdentifier(properties?.['sessionID']);
        const state = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
        if (state === undefined) {
          this.#eventsIgnored += 1;
          return;
        }
        this.#touch(state);
        state.idleEvents += 1;
        await this.#flush(state);
        return;
      }
      case 'session.compacted': {
        const sessionId = readIdentifier(properties?.['sessionID']);
        const state = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
        if (state === undefined) {
          this.#eventsIgnored += 1;
          return;
        }
        this.#touch(state);
        state.compactedEvents += 1;
        this.#markDirty(state);
        return;
      }
      case 'session.deleted': {
        const sessionId = readIdentifier(asRecord(properties?.['info'])?.['id']);
        if (sessionId === undefined) {
          this.#eventsIgnored += 1;
          return;
        }
        const state = this.#sessions.get(sessionId);
        if (state === undefined) {
          this.#eventsIgnored += 1;
          return;
        }
        this.#sessions.delete(sessionId);
        this.#sessionsClosed += 1;
        await this.#flush(state);
        return;
      }
      default: {
        this.#eventsIgnored += 1;
        this.#diagnose('event-ignored');
        return;
      }
    }
  }

  /**
   * Write one session summary to the sink, serialized behind earlier writes.
   *
   * Serializing keeps append order equal to schedule order, so a consumer that
   * takes the last line per session can never see a stale summary win a race. A
   * failure is contained and reported as `sink-failed`.
   */
  async #flush(state: SessionState): Promise<void> {
    const sink = this.#sink;
    if (sink === undefined) {
      return;
    }
    this.#dirtySessions.delete(state.sessionId);
    const write = async (): Promise<void> => {
      try {
        await sink(this.#summarizeState(state));
      } catch {
        this.#diagnose('sink-failed');
      }
    };
    const chained = this.#writeChain.then(write, write);
    this.#writeChain = chained.catch(() => undefined);
    await chained;
  }

  /* ---------------------------------------------------------------------- */
  /* Checkpoint persistence                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Remember that a session changed since its last write.
   *
   * Does nothing when no sink is configured: with no sink the observer writes
   * nothing at all, which is the default and must stay true.
   */
  #markDirty(state: SessionState): void {
    if (this.#sink === undefined || this.#disposed) {
      return;
    }
    this.#dirtySessions.add(state.sessionId);
    this.#scheduleCheckpoint();
  }

  /**
   * Schedule the next checkpoint write.
   *
   * A one-shot OpenCode session can be terminated before any unload path runs, so
   * waiting for lifecycle events or `dispose()` would lose the summary entirely
   * (observed in Stage 1G). One timer per interval, only while a session is
   * dirty, keeps the write rate bounded regardless of how busy the session is.
   */
  #scheduleCheckpoint(): void {
    if (this.#checkpointTimer !== undefined || this.#checkpointIntervalMs === 0) {
      return;
    }
    try {
      const timer = setTimeout(() => {
        this.#checkpointTimer = undefined;
        void this.#checkpoint();
      }, this.#checkpointIntervalMs);
      // Never keep the host process alive just to checkpoint.
      (timer as { unref?: () => void }).unref?.();
      this.#checkpointTimer = timer;
    } catch {
      // A host without timers simply gets flush-on-lifecycle behaviour.
      this.#checkpointTimer = undefined;
    }
  }

  #clearCheckpointTimer(): void {
    const timer = this.#checkpointTimer;
    if (timer === undefined) {
      return;
    }
    this.#checkpointTimer = undefined;
    try {
      clearTimeout(timer);
    } catch {
      // Ignore: clearing a timer is best effort.
    }
  }

  /** Write every changed session, then stop. Never throws. */
  async #checkpoint(): Promise<void> {
    if (this.#sink === undefined) {
      return;
    }
    const ids = [...this.#dirtySessions];
    for (const sessionId of ids) {
      const state = this.#sessions.get(sessionId);
      if (state === undefined) {
        this.#dirtySessions.delete(sessionId);
        continue;
      }
      try {
        await this.#flush(state);
      } catch {
        this.noteInternalFailure();
      }
    }
    if (this.#dirtySessions.size > 0) {
      this.#scheduleCheckpoint();
    }
  }

  /** Record a V2 source-reported usage snapshot. Never accumulates. */
  #recordSourceUsage(state: SessionState, snapshot: SessionUsageSnapshot): void {
    const tracking = state.sourceUsage;
    tracking.events += 1;
    tracking.usableEvents += 1;
    for (const field of USAGE_FIELDS) {
      if (snapshot[field] !== undefined) {
        tracking.reportedByField[field] += 1;
      }
    }
    const previous = tracking.latest;
    if (previous !== undefined) {
      const comparison = compareSessionUsage(previous, snapshot);
      if (comparison.decreasedFields > 0) {
        tracking.decreasesObserved += comparison.decreasedFields;
        tracking.monotonicNonDecreasing = false;
        this.#diagnose('usage-update-regression');
      }
    }
    tracking.latest = snapshot;
    tracking.latestAt = this.#timestamp();
    this.#markDirty(state);
    // Usage arrives about once per model step — low frequency, and the most
    // valuable thing a summary carries. Waiting for the next checkpoint interval
    // loses it whenever the host is terminated first, which is exactly what a
    // one-shot `run` does (observed in Stage 1H). The write is queued and never
    // awaited into the event path, so the host pays no latency for it.
    if (this.#sink !== undefined && !this.#disposed) {
      void this.#flush(state);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Summary construction                                                   */
  /* ---------------------------------------------------------------------- */

  #summarizeState(state: SessionState): SessionObservationSummary {
    const toolIds = new Set<string>([...state.toolStarted.keys(), ...state.toolCompleted.keys()]);
    const toolFrequency: ToolFrequencyEntry[] = [...toolIds].sort().map((tool) => ({
      tool,
      started: state.toolStarted.get(tool) ?? 0,
      completed: state.toolCompleted.get(tool) ?? 0,
    }));

    let repeatedTargets = 0;
    let repeatedRequests = 0;
    for (const count of state.readTargets.values()) {
      if (count > 1) {
        repeatedTargets += 1;
        repeatedRequests += count - 1;
      }
    }

    const reads: ReadObservationSummary = {
      requests: state.readRequests,
      identifiedRequests: state.identifiedReadRequests,
      unidentifiedRequests: state.unidentifiedReadRequests,
      malformedArgumentRequests: state.malformedReadArguments,
      distinctTargets: state.readTargets.size,
      repeatedTargets,
      repeatedRequests,
      targetsDropped: state.readTargetsDropped,
      identityScheme: READ_IDENTITY_SCHEME,
    };

    const reportedByField = emptyUsageFieldCounts();
    const summedByField = emptyUsageFieldCounts();
    for (const snapshot of state.usage.values()) {
      for (const field of USAGE_FIELDS) {
        const value = snapshot[field];
        if (value !== undefined) {
          reportedByField[field] += 1;
          summedByField[field] += value;
        }
      }
    }

    const sourceUsage = state.sourceUsage;
    const sourceReported: SourceReportedUsageSummary | undefined =
      sourceUsage.events === 0
        ? undefined
        : {
            events: sourceUsage.events,
            usableEvents: sourceUsage.usableEvents,
            reportedByField: { ...sourceUsage.reportedByField },
            latest:
              sourceUsage.latest === undefined
                ? emptyUsageFieldValues()
                : sessionUsageFields(sourceUsage.latest),
            latestObservedAt: sourceUsage.latestAt === 0 ? 'never' : this.#isoAt(sourceUsage.latestAt),
            aggregation: 'unverified',
            monotonicNonDecreasing: sourceUsage.monotonicNonDecreasing,
            decreasesObserved: sourceUsage.decreasesObserved,
          };

    const usage: UsageObservationSummary = {
      messagesWithUsage: state.usage.size,
      messagesWithoutUsage: state.messagesWithoutUsage,
      usageRecordsDropped: state.usageRecordsDropped,
      usageUpdatesIgnored: state.usageUpdatesIgnored,
      usageRegressionsObserved: state.usageRegressionsObserved,
      stepFinishPartsObserved: state.stepFinishPartsObserved,
      reportedByField,
      sourceReported,
    };

    const counts: SessionObservationCounts = {
      toolStartsObserved: sumValues(state.toolStarted),
      toolCompletionsObserved: sumValues(state.toolCompleted),
      correlatedCompletions: state.correlatedCompletions,
      uncorrelatedCompletions: state.uncorrelatedCompletions,
      duplicateStartsIgnored: state.duplicateStartsIgnored,
      duplicateCompletionsIgnored: state.duplicateCompletionsIgnored,
      pendingCalls: state.pending.size,
      pendingCallsDropped: state.pendingCallsDropped,
    };

    const lifecycle: SessionLifecycleSummary = {
      createdEvents: state.createdEvents,
      idleEvents: state.idleEvents,
      compactedEvents: state.compactedEvents,
    };

    const measurements: SessionObservationMeasurements = {
      toolStartsObserved: measured(counts.toolStartsObserved),
      toolCompletionsObserved: measured(counts.toolCompletionsObserved),
      readRequestsObserved: measured(reads.requests),
      identifiedReadRequests: measured(reads.identifiedRequests),
      unidentifiedReadRequests: measured(reads.unidentifiedRequests),
      distinctReadTargets: calculated(reads.distinctTargets),
      repeatedReadTargets: calculated(reads.repeatedTargets),
      repeatedFileReads: calculated(reads.repeatedRequests),
      // A session aggregate is only ever the sum of *per-message* records. When
      // the runtime reported V2 session snapshots instead, no aggregate is
      // derived from them: the meaning of the series is unverified, so the
      // numbers stay available only as reported snapshots (usage.sourceReported)
      // and the metrics say so rather than being promoted.
      inputTokens: tokenMeasurement(
        reportedByField.input,
        summedByField.input,
        sourceReported,
      ),
      outputTokens: tokenMeasurement(
        reportedByField.output,
        summedByField.output,
        sourceReported,
      ),
      reasoningTokens: tokenMeasurement(
        reportedByField.reasoning,
        summedByField.reasoning,
        sourceReported,
      ),
      cacheReadTokens: tokenMeasurement(
        reportedByField.cacheRead,
        summedByField.cacheRead,
        sourceReported,
      ),
      cacheWriteTokens: tokenMeasurement(
        reportedByField.cacheWrite,
        summedByField.cacheWrite,
        sourceReported,
      ),
      cost: tokenMeasurement(reportedByField.cost, summedByField.cost, sourceReported, NOTE_COST_NOT_REPORTED),
      totalTokens: unavailable(NOTE_TOTAL_TOKENS_NOT_DERIVED),
    };

    return {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      adapter: this.#adapterIdentity(),
      sessionId: state.sessionId,
      observedFromAt: this.#isoAt(state.firstObservedAt),
      observedToAt: this.#isoAt(state.lastObservedAt),
      counts,
      toolFrequency,
      reads,
      usage,
      lifecycle,
      measurements,
      notes: [
        ...OBSERVATION_NOTES,
        ...(counts.toolStartsObserved === 0 ? [NOTE_NO_TOOL_ACTIVITY] : []),
        ...(reads.requests === 0 ? [NOTE_NO_READS] : []),
      ],
    };
  }

  #isoAt(at: number): string {
    try {
      return new Date(at).toISOString();
    } catch {
      return 'unknown';
    }
  }
}

function sumValues(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) {
    total += value;
  }
  return total;
}
