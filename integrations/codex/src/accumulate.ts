import { isDigestLike } from './identity.js';
import {
  CODEX_CLI_VERIFIED_VERSION,
  CODEX_HOST_PRODUCT,
  CODEX_OBSERVER_ADAPTER_NAME,
  CODEX_USAGE_UNAVAILABLE_NOTE,
  DEFAULT_OBSERVATION_LIMITS,
  OBSERVATION_NOTES,
  OBSERVATION_SCHEMA_VERSION,
  READ_IDENTITY_SCHEME,
  UNATTRIBUTED_SESSION_KEY,
  UNKNOWN_SESSION_ID,
} from './types.js';
import type {
  CodexSessionCounts,
  CodexSessionMeasurements,
  CodexSessionObservationSummary,
  ObservationLimits,
  ObservationMeasurement,
  ObservationRecord,
  ObservationRecordKind,
  ObserverDiagnosticCode,
  ReadObservationSummary,
  ToolFrequencyEntry,
} from './types.js';

/**
 * The observation accumulator.
 *
 * Codex runs each command hook as its own process, so the adapter cannot hold
 * session state in memory the way the OpenCode adapter does. Instead every event
 * is appended to a small per-session journal as one content-free record, and this
 * module folds those records into counters. The same fold is reachable from a
 * compacted snapshot, so state stays bounded across hundreds of hook invocations
 * without a database, a daemon or a global lock.
 *
 * The fold is pure: it takes records and an accumulator and returns counters plus
 * content-free diagnostics. All file access lives in `storage.ts`.
 */

/** Per-tool counters. */
export interface ToolCounts {
  started: number;
  completed: number;
}

/** Mutable counters folded from journal records. */
export interface Accumulator {
  records: number;
  compactions: number;
  sessionId: string | undefined;
  sessionReported: boolean;
  cwdHash: string | undefined;
  firstAt: number | null;
  lastAt: number | null;
  counts: MutableCounts;
  /** Read-like requests that produced a usable identity, by read key. */
  reads: Map<string, number>;
  /** Read-like requests whose arguments carried no usable path. */
  unidentifiedReads: number;
  /** Identified reads whose offset or limit was present but unusable. */
  malformedReads: number;
  /** Identified reads dropped because the read-target bound was reached. */
  readTargetsDropped: number;
  sessionStartSources: Record<string, number>;
  compactionTriggers: Record<string, number>;
  tools: Map<string, ToolCounts>;
  /** Tool calls seen to start but not yet seen to complete, by call id. */
  pending: Map<string, string>;
  /** Call ids already seen to complete, so a duplicate completion is recognized. */
  completed: Map<string, true>;
  journalAtCapacity: boolean;
}

type MutableCounts = {
  -readonly [K in keyof CodexSessionCounts]: CodexSessionCounts[K];
};

/** JSON-serializable form of the accumulator, written between compactions. */
export interface PersistedAccumulator {
  readonly v: 1;
  readonly records: number;
  readonly compactions: number;
  readonly sessionId?: string | undefined;
  readonly sessionReported: boolean;
  readonly cwdHash?: string | undefined;
  readonly firstAt: number | null;
  readonly lastAt: number | null;
  readonly counts: CodexSessionCounts;
  readonly reads: Readonly<Record<string, number>>;
  readonly unidentifiedReads: number;
  readonly malformedReads: number;
  readonly readTargetsDropped: number;
  readonly sessionStartSources: Readonly<Record<string, number>>;
  readonly compactionTriggers: Readonly<Record<string, number>>;
  readonly tools: Readonly<Record<string, ToolCounts>>;
  readonly pending: Readonly<Record<string, string>>;
  readonly completed: readonly string[];
  readonly journalAtCapacity: boolean;
}

const RECORD_KINDS: readonly ObservationRecordKind[] = [
  'session-start',
  'session-end',
  'prompt',
  'tool-start',
  'tool-end',
  'permission-request',
  'compaction',
  'subagent-start',
  'subagent-stop',
  'stop',
  'interrupt',
  'ignored',
  'unusable',
];

function emptyCounts(): MutableCounts {
  return {
    hookEventsObserved: 0,
    hookEventsIgnored: 0,
    unusablePayloads: 0,
    sessionStarts: 0,
    sessionEnds: 0,
    promptsSubmitted: 0,
    toolStartsObserved: 0,
    toolCompletionsObserved: 0,
    correlatedCompletions: 0,
    uncorrelatedCompletions: 0,
    duplicateStartsIgnored: 0,
    duplicateCompletionsIgnored: 0,
    pendingCalls: 0,
    pendingCallsDropped: 0,
    permissionRequests: 0,
    compactionEvents: 0,
    subagentStarts: 0,
    subagentStops: 0,
    stopEvents: 0,
    interruptEvents: 0,
  };
}

/** A fresh accumulator. */
export function createAccumulator(): Accumulator {
  return {
    records: 0,
    compactions: 0,
    sessionId: undefined,
    sessionReported: false,
    cwdHash: undefined,
    firstAt: null,
    lastAt: null,
    counts: emptyCounts(),
    reads: new Map(),
    unidentifiedReads: 0,
    malformedReads: 0,
    readTargetsDropped: 0,
    sessionStartSources: {},
    compactionTriggers: {},
    tools: new Map(),
    pending: new Map(),
    completed: new Map(),
    journalAtCapacity: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounded-set insert that evicts the oldest entry when the bound is reached. */
function rememberBounded<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

/** Drop the oldest entry when a bound is reached. Returns true when something was dropped. */
function evictOldest<T>(map: Map<string, T>, limit: number): boolean {
  if (map.size < limit) {
    return false;
  }
  const oldest = map.keys().next();
  if (oldest.done) {
    return false;
  }
  map.delete(oldest.value);
  return true;
}

/** Parse one persisted journal line, rejecting anything that is not a valid record. */
export function parseRecord(value: unknown): ObservationRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1) {
    return undefined;
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || !RECORD_KINDS.includes(kind as ObservationRecordKind)) {
    return undefined;
  }
  const at = value['at'];
  return {
    v: 1,
    at: typeof at === 'number' && Number.isFinite(at) ? at : null,
    kind: kind as ObservationRecordKind,
    sessionId: typeof value['sessionId'] === 'string' ? value['sessionId'] : undefined,
    cwdHash: typeof value['cwdHash'] === 'string' ? value['cwdHash'] : undefined,
    source:
      typeof value['source'] === 'string'
        ? (value['source'] as ObservationRecord['source'])
        : undefined,
    trigger:
      typeof value['trigger'] === 'string'
        ? (value['trigger'] as ObservationRecord['trigger'])
        : undefined,
    tool: typeof value['tool'] === 'string' ? value['tool'] : undefined,
    call: typeof value['call'] === 'string' ? value['call'] : undefined,
    read: typeof value['read'] === 'string' ? value['read'] : undefined,
    readBasis:
      typeof value['readBasis'] === 'string'
        ? (value['readBasis'] as ObservationRecord['readBasis'])
        : undefined,
    readReason:
      typeof value['readReason'] === 'string'
        ? (value['readReason'] as ObservationRecord['readReason'])
        : undefined,
    malformedRange: typeof value['malformedRange'] === 'boolean' ? value['malformedRange'] : undefined,
    responseKind: typeof value['responseKind'] === 'string' ? value['responseKind'] : undefined,
    agentType: typeof value['agentType'] === 'string' ? value['agentType'] : undefined,
    permissionTool:
      typeof value['permissionTool'] === 'string' ? value['permissionTool'] : undefined,
    stopHookActive: typeof value['stopHookActive'] === 'boolean' ? value['stopHookActive'] : undefined,
  };
}

function bump(record: Record<string, number>, key: string | undefined): void {
  const resolved = key ?? 'unknown';
  record[resolved] = (record[resolved] ?? 0) + 1;
}

function measureTimestamps(accumulator: Accumulator, at: number | null): void {
  if (at === null) {
    return;
  }
  accumulator.firstAt = accumulator.firstAt === null ? at : Math.min(accumulator.firstAt, at);
  accumulator.lastAt = accumulator.lastAt === null ? at : Math.max(accumulator.lastAt, at);
}

/**
 * Fold one record into the accumulator.
 *
 * Returns the diagnostic codes the record justified, so the caller can report a
 * dropped pending call, a duplicate completion or a refused read without this
 * module needing a logger.
 */
export function applyRecord(
  accumulator: Accumulator,
  record: ObservationRecord,
  limits: ObservationLimits = DEFAULT_OBSERVATION_LIMITS,
): readonly ObserverDiagnosticCode[] {
  const diagnostics: ObserverDiagnosticCode[] = [];
  accumulator.records += 1;
  measureTimestamps(accumulator, record.at);

  if (typeof record.sessionId === 'string' && accumulator.sessionId === undefined) {
    accumulator.sessionId = record.sessionId;
    accumulator.sessionReported = true;
  }
  if (typeof record.cwdHash === 'string' && accumulator.cwdHash === undefined) {
    accumulator.cwdHash = record.cwdHash;
  }

  const counts = accumulator.counts;

  switch (record.kind) {
    case 'session-start': {
      counts.sessionStarts += 1;
      bump(accumulator.sessionStartSources, record.source);
      return diagnostics;
    }
    case 'session-end': {
      counts.sessionEnds += 1;
      return diagnostics;
    }
    case 'prompt': {
      counts.promptsSubmitted += 1;
      return diagnostics;
    }
    case 'tool-start': {
      counts.toolStartsObserved += 1;
      const tool = record.tool ?? 'unknown';
      const toolCounts = accumulator.tools.get(tool);
      if (toolCounts === undefined) {
        evictOldest(accumulator.tools, limits.maxTools);
        accumulator.tools.set(tool, { started: 1, completed: 0 });
      } else {
        toolCounts.started += 1;
      }

      const callId = record.call;
      if (callId !== undefined) {
        if (accumulator.pending.has(callId)) {
          counts.duplicateStartsIgnored += 1;
          diagnostics.push('duplicate-tool-start');
        } else {
          if (evictOldest(accumulator.pending, limits.maxPendingCalls)) {
            counts.pendingCallsDropped += 1;
            diagnostics.push('pending-call-limit-reached');
          }
          accumulator.pending.set(callId, tool);
        }
      }

      if (record.read !== undefined) {
        if (!accumulator.reads.has(record.read) && evictOldest(accumulator.reads, limits.maxReadTargets)) {
          accumulator.readTargetsDropped += 1;
          diagnostics.push('read-target-limit-reached');
        }
        accumulator.reads.set(record.read, (accumulator.reads.get(record.read) ?? 0) + 1);
        if (record.malformedRange === true) {
          accumulator.malformedReads += 1;
          diagnostics.push('malformed-read-arguments');
        }
      } else if (record.readReason !== undefined) {
        accumulator.unidentifiedReads += 1;
        diagnostics.push('unidentified-read-request');
      }
      return diagnostics;
    }
    case 'tool-end': {
      counts.toolCompletionsObserved += 1;
      const tool = record.tool ?? 'unknown';
      const toolCounts = accumulator.tools.get(tool);
      if (toolCounts === undefined) {
        evictOldest(accumulator.tools, limits.maxTools);
        accumulator.tools.set(tool, { started: 0, completed: 1 });
      } else {
        toolCounts.completed += 1;
      }

      const callId = record.call;
      if (callId === undefined) {
        counts.uncorrelatedCompletions += 1;
        return diagnostics;
      }
      if (accumulator.pending.has(callId)) {
        accumulator.pending.delete(callId);
        counts.correlatedCompletions += 1;
        rememberBounded(accumulator.completed, callId, true, limits.maxPendingCalls);
      } else if (accumulator.completed.has(callId)) {
        counts.duplicateCompletionsIgnored += 1;
        diagnostics.push('duplicate-tool-completion');
      } else {
        counts.uncorrelatedCompletions += 1;
      }
      return diagnostics;
    }
    case 'permission-request': {
      counts.permissionRequests += 1;
      return diagnostics;
    }
    case 'compaction': {
      counts.compactionEvents += 1;
      bump(accumulator.compactionTriggers, record.trigger);
      return diagnostics;
    }
    case 'subagent-start': {
      counts.subagentStarts += 1;
      return diagnostics;
    }
    case 'subagent-stop': {
      counts.subagentStops += 1;
      return diagnostics;
    }
    case 'stop': {
      counts.stopEvents += 1;
      return diagnostics;
    }
    case 'interrupt': {
      counts.interruptEvents += 1;
      return diagnostics;
    }
    case 'ignored': {
      counts.hookEventsIgnored += 1;
      diagnostics.push('unknown-event-ignored');
      return diagnostics;
    }
    case 'unusable': {
      counts.unusablePayloads += 1;
      diagnostics.push('hook-input-unusable');
      return diagnostics;
    }
    default: {
      return diagnostics;
    }
  }
}

/** Fold many records in order. */
export function applyRecords(
  accumulator: Accumulator,
  records: readonly ObservationRecord[],
  limits: ObservationLimits = DEFAULT_OBSERVATION_LIMITS,
): readonly ObserverDiagnosticCode[] {
  const diagnostics: ObserverDiagnosticCode[] = [];
  for (const record of records) {
    diagnostics.push(...applyRecord(accumulator, record, limits));
  }
  return diagnostics;
}

/** Plain, JSON-serializable snapshot of an accumulator. */
export function toPersisted(accumulator: Accumulator): PersistedAccumulator {
  return {
    v: 1,
    records: accumulator.records,
    compactions: accumulator.compactions,
    sessionId: accumulator.sessionId,
    sessionReported: accumulator.sessionReported,
    cwdHash: accumulator.cwdHash,
    firstAt: accumulator.firstAt,
    lastAt: accumulator.lastAt,
    counts: { ...accumulator.counts },
    reads: Object.fromEntries(accumulator.reads),
    unidentifiedReads: accumulator.unidentifiedReads,
    malformedReads: accumulator.malformedReads,
    readTargetsDropped: accumulator.readTargetsDropped,
    sessionStartSources: { ...accumulator.sessionStartSources },
    compactionTriggers: { ...accumulator.compactionTriggers },
    tools: Object.fromEntries(accumulator.tools),
    pending: Object.fromEntries(accumulator.pending),
    completed: [...accumulator.completed.keys()],
    journalAtCapacity: accumulator.journalAtCapacity,
  };
}

function readCount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function readNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Rebuild an accumulator from a persisted snapshot.
 *
 * An unusable snapshot yields a fresh accumulator rather than an error: losing
 * counts is acceptable, inventing them is not.
 */
export function fromPersisted(value: unknown): Accumulator {
  const accumulator = createAccumulator();
  if (!isRecord(value) || value['v'] !== 1) {
    return accumulator;
  }

  const counts = isRecord(value['counts']) ? value['counts'] : {};
  for (const key of Object.keys(accumulator.counts) as (keyof CodexSessionCounts)[]) {
    const candidate = counts[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      accumulator.counts[key] = Math.floor(candidate);
    }
  }

  accumulator.records = readCount(value['records']);
  accumulator.compactions = readCount(value['compactions']);
  accumulator.sessionId = typeof value['sessionId'] === 'string' ? value['sessionId'] : undefined;
  accumulator.sessionReported = value['sessionReported'] === true;
  accumulator.cwdHash = typeof value['cwdHash'] === 'string' ? value['cwdHash'] : undefined;
  accumulator.firstAt = readNumberOrNull(value['firstAt']);
  accumulator.lastAt = readNumberOrNull(value['lastAt']);
  accumulator.journalAtCapacity = value['journalAtCapacity'] === true;
  accumulator.unidentifiedReads = readCount(value['unidentifiedReads']);
  accumulator.malformedReads = readCount(value['malformedReads']);
  accumulator.readTargetsDropped = readCount(value['readTargetsDropped']);

  for (const [key, count] of Object.entries(
    isRecord(value['sessionStartSources']) ? value['sessionStartSources'] : {},
  )) {
    if (typeof count === 'number') {
      accumulator.sessionStartSources[key] = count;
    }
  }
  for (const [key, count] of Object.entries(
    isRecord(value['compactionTriggers']) ? value['compactionTriggers'] : {},
  )) {
    if (typeof count === 'number') {
      accumulator.compactionTriggers[key] = count;
    }
  }
  for (const [tool, entry] of Object.entries(isRecord(value['tools']) ? value['tools'] : {})) {
    if (isRecord(entry)) {
      accumulator.tools.set(tool, {
        started: readCount(entry['started']),
        completed: readCount(entry['completed']),
      });
    }
  }
  for (const [key, count] of Object.entries(isRecord(value['reads']) ? value['reads'] : {})) {
    if (typeof count === 'number' && count > 0) {
      accumulator.reads.set(key, count);
    }
  }
  for (const [call, tool] of Object.entries(isRecord(value['pending']) ? value['pending'] : {})) {
    if (typeof tool === 'string') {
      accumulator.pending.set(call, tool);
    }
  }
  const completed = value['completed'];
  if (Array.isArray(completed)) {
    for (const call of completed) {
      if (typeof call === 'string') {
        accumulator.completed.set(call, true);
      }
    }
  }

  return accumulator;
}

function isoOrUnknown(at: number | null): string {
  if (at === null) {
    return 'unknown';
  }
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}

function measured(value: number): ObservationMeasurement<number> {
  return { evidence: 'measured', value };
}

function calculated(value: number): ObservationMeasurement<number> {
  return { evidence: 'calculated', value };
}

function usageUnavailable(): ObservationMeasurement<number> {
  return { evidence: 'unavailable', note: CODEX_USAGE_UNAVAILABLE_NOTE };
}

/** Derived read counters for one session. */
export function readSummary(accumulator: Accumulator): ReadObservationSummary {
  let repeatedTargets = 0;
  let repeatedRequests = 0;
  let identifiedRequests = 0;
  for (const count of accumulator.reads.values()) {
    identifiedRequests += count;
    if (count > 1) {
      repeatedTargets += 1;
      repeatedRequests += count - 1;
    }
  }
  return {
    requests: identifiedRequests + accumulator.unidentifiedReads,
    identifiedRequests,
    unidentifiedRequests: accumulator.unidentifiedReads,
    malformedArgumentRequests: accumulator.malformedReads,
    distinctTargets: accumulator.reads.size,
    repeatedTargets,
    repeatedRequests,
    targetsDropped: accumulator.readTargetsDropped,
    identityScheme: READ_IDENTITY_SCHEME,
  };
}

/** Build the content-free summary for one session. */
export function buildSummary(
  accumulator: Accumulator,
  options: { readonly adapterRevision: string; readonly unattributed: boolean },
): CodexSessionObservationSummary {
  const counts: CodexSessionCounts = { ...accumulator.counts, pendingCalls: accumulator.pending.size };
  const reads = readSummary(accumulator);

  const toolFrequency: ToolFrequencyEntry[] = [...accumulator.tools.entries()]
    .map(([tool, entry]) => ({ tool, started: entry.started, completed: entry.completed }))
    .sort((left, right) => (left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0));

  const measurements: CodexSessionMeasurements = {
    toolStartsObserved: measured(counts.toolStartsObserved),
    toolCompletionsObserved: measured(counts.toolCompletionsObserved),
    readRequestsObserved: measured(reads.requests),
    identifiedReadRequests: measured(reads.identifiedRequests),
    unidentifiedReadRequests: measured(reads.unidentifiedRequests),
    distinctReadTargets: calculated(reads.distinctTargets),
    repeatedReadTargets: calculated(reads.repeatedTargets),
    repeatedFileReads: calculated(reads.repeatedRequests),
    inputTokens: usageUnavailable(),
    outputTokens: usageUnavailable(),
    reasoningTokens: usageUnavailable(),
    cacheReadTokens: usageUnavailable(),
    cacheWriteTokens: usageUnavailable(),
    cost: usageUnavailable(),
    totalTokens: usageUnavailable(),
  };

  const notes = [...OBSERVATION_NOTES];
  if (options.unattributed) {
    notes.push(
      'Some observed events carried no usable session identifier; they are reported under session `unknown` rather than attributed to a guessed session.',
    );
  } else if (!accumulator.sessionReported) {
    notes.push('The host did not report a session identifier for this session.');
  }
  if (counts.pendingCallsDropped > 0) {
    notes.push('The pending-call bound was reached; some tool starts were dropped and are not counted.');
  }
  if (accumulator.unidentifiedReads > 0) {
    notes.push(
      'Some read-like tool calls could not be identified and are counted as unidentified rather than guessed.',
    );
  }
  if (accumulator.journalAtCapacity) {
    notes.push('The journal capacity bound was reached; later events were dropped rather than grown.');
  }
  notes.push(
    'Read identities come from tool arguments or a strictly parsed single-file shell command; the working directory is recorded only as a hash and no project identity is claimed.',
  );

  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    adapter: {
      name: CODEX_OBSERVER_ADAPTER_NAME,
      revision: options.adapterRevision,
      host: { product: CODEX_HOST_PRODUCT, cliVersion: CODEX_CLI_VERIFIED_VERSION },
    },
    sessionId: accumulator.sessionId ?? UNKNOWN_SESSION_ID,
    sessionIdentity: accumulator.sessionReported ? 'reported' : 'unknown',
    observedFromAt: isoOrUnknown(accumulator.firstAt),
    observedToAt: isoOrUnknown(accumulator.lastAt),
    counts,
    toolFrequency,
    reads,
    project: {
      basis: accumulator.cwdHash === undefined ? 'unavailable' : 'runtime-declared',
      verification: 'unverifiable',
      directoryHash:
        accumulator.cwdHash !== undefined && isDigestLike(accumulator.cwdHash)
          ? accumulator.cwdHash
          : undefined,
    },
    measurements,
    journal: {
      records: accumulator.records,
      atCapacity: accumulator.journalAtCapacity,
      compactions: accumulator.compactions,
      compacted: accumulator.compactions > 0,
    },
    notes,
  };
}

/** Session key for a parsed event: the reported id, or the unattributed key. */
export function sessionKeyFor(sessionId: string | undefined): string {
  return sessionId ?? UNATTRIBUTED_SESSION_KEY;
}
