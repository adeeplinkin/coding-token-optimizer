import { buildSummary, sessionKeyFor } from './accumulate.js';
import {
  CODEX_OBSERVER_ADAPTER_REVISION,
  DEFAULT_OBSERVATION_LIMITS,
  OBSERVER_DIAGNOSTIC_LEVELS,
  OBSERVER_DIAGNOSTIC_MESSAGES,
  type CodexHookEventName,
  type HandleOptions,
  type HandleResult,
  type ObservationRecord,
  type ObservationRecordKind,
  type ObserverDiagnostic,
  type ObserverDiagnosticCode,
  type ParsedHookEvent,
} from './types.js';
import { isDebugEnvironment, isDisabledByEnvironment, stateDirFromEnvironment } from './env.js';
import { normalizePath, defaultHash } from './identity.js';
import { parseHookPayload } from './hook-input.js';
import { classifyReadAttempt } from './reads.js';
import { resolveEnvironmentSink } from './sink.js';
import { appendRecord, compactSession, loadSession, releaseSession, resolveStateRoot, sweepStaleSessions } from './storage.js';

/**
 * Observe one Codex hook payload.
 *
 * The whole point of this adapter is what it does **not** do: it returns no
 * `decision`, `permissionDecision`, `updatedInput`, `additionalContext` or
 * `continue` field, writes nothing to stdout, and never throws. Everything it
 * records goes to Dr. Token's own state directory and, only if the user opted in,
 * to Dr. Token's own summary file.
 */

/** The observation kinds each recognized event maps to. */
const EVENT_RECORD_KIND: Readonly<Record<CodexHookEventName, ObservationRecordKind>> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool-start',
  PermissionRequest: 'permission-request',
  PostToolUse: 'tool-end',
  PreCompact: 'compaction',
  PostCompact: 'compaction',
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  Stop: 'stop',
  Interrupt: 'interrupt',
  SessionEnd: 'session-end',
};

/** Build the content-free journal record for one parsed event. */
export function buildObservationRecord(
  parsed: ParsedHookEvent,
  at: number,
  hash: (value: string) => string,
): ObservationRecord {
  const timestamp = Number.isFinite(at) ? at : null;
  if (!parsed.usable) {
    return { v: 1, at: timestamp, kind: 'unusable', sessionId: parsed.sessionId };
  }
  if (!parsed.recognized) {
    // A well-formed payload for an event this adapter does not implement: counted
    // as ignored rather than recorded as if it were understood.
    return { v: 1, at: timestamp, kind: 'ignored', sessionId: parsed.sessionId };
  }

  const record: ObservationRecord = {
    v: 1,
    at: timestamp,
    kind: EVENT_RECORD_KIND[parsed.eventName as CodexHookEventName],
    sessionId: parsed.sessionId,
  };

  switch (parsed.eventName) {
    case 'SessionStart':
      return {
        ...record,
        source: parsed.sessionStartSource,
        cwdHash: parsed.cwd === undefined ? undefined : hash(normalizePath(parsed.cwd)),
      };
    case 'PreToolUse': {
      const attempt = classifyReadAttempt(parsed.toolName ?? '', parsed.toolInput, hash);
      const withTool: ObservationRecord = {
        ...record,
        tool: parsed.toolName,
        call: parsed.toolUseId,
      };
      if (!attempt.attempt) {
        return withTool;
      }
      if (attempt.result.identified) {
        return {
          ...withTool,
          read: attempt.result.key,
          readBasis: attempt.result.basis,
          malformedRange: attempt.result.malformed,
        };
      }
      return { ...withTool, readReason: attempt.result.reason };
    }
    case 'PostToolUse':
      return {
        ...record,
        tool: parsed.toolName,
        call: parsed.toolUseId,
        responseKind: parsed.toolResponseKind,
      };
    case 'PermissionRequest':
      return { ...record, permissionTool: parsed.toolName };
    case 'PreCompact':
    case 'PostCompact':
      return { ...record, trigger: parsed.compactionTrigger };
    case 'SubagentStart':
    case 'SubagentStop':
      return { ...record, agentType: parsed.agentType };
    case 'Stop':
      return { ...record, stopHookActive: parsed.stopHookActive };
    default:
      return record;
  }
}

function isoOrUnknown(at: number): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}

/** Handle one hook payload, fail-open and content-free. */
export async function handleHookPayload(
  raw: unknown,
  options: HandleOptions = {},
): Promise<HandleResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const hash = options.hash ?? defaultHash;
  const limits = { ...DEFAULT_OBSERVATION_LIMITS, ...(options.limits ?? {}) };
  const adapterRevision = options.adapterRevision ?? CODEX_OBSERVER_ADAPTER_REVISION;
  const diagnostics: ObserverDiagnostic[] = [];

  // Reading the clock is itself allowed to fail: a broken clock must never turn
  // into a thrown error out of the entry point.
  const safeNow = (): string => {
    try {
      return isoOrUnknown(now());
    } catch {
      return 'unknown';
    }
  };

  const emit = (code: ObserverDiagnosticCode): void => {
    const diagnostic: ObserverDiagnostic = {
      code,
      level: OBSERVER_DIAGNOSTIC_LEVELS[code],
      message: OBSERVER_DIAGNOSTIC_MESSAGES[code],
      at: safeNow(),
    };
    diagnostics.push(diagnostic);
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // A diagnostic consumer must never affect observation.
    }
  };

  const parsed = parseHookPayload(raw);
  const sessionKey = sessionKeyFor(parsed.sessionId);

  if (isDisabledByEnvironment(env)) {
    emit('observer-disabled');
    return {
      recorded: false,
      disabled: true,
      eventName: parsed.eventName,
      sessionKey,
      diagnostics,
      stdout: '',
    };
  }

  if (!parsed.usable) {
    // Reported immediately rather than only when the session is folded: an
    // unusable payload is an operational signal about the host contract, and with
    // `DR_TOKEN_CODEX_DEBUG` it is the only thing a user would see.
    emit('hook-input-unusable');
  }

  const stateRoot = resolveStateRoot(options.stateDir ?? stateDirFromEnvironment(env));
  const sink = options.sink ?? resolveEnvironmentSink(env);
  let recorded = false;

  try {
    const record = buildObservationRecord(parsed, now(), hash);
    const outcome = await appendRecord(stateRoot, sessionKey, record, limits);
    if (outcome === 'appended') {
      recorded = true;
    } else if (outcome === 'dropped') {
      emit('journal-capacity-reached');
    } else {
      emit('state-unavailable');
    }

    if (outcome === 'appended') {
      const compaction = await compactSession(
        stateRoot,
        sessionKey,
        limits,
        now(),
        options.compactionTriggerBytes,
      );
      if (compaction.skipped) {
        emit('compaction-skipped');
      }
    }

    if (parsed.usable && parsed.eventName === 'SessionEnd') {
      await flushSession(stateRoot, sessionKey, sink, limits, adapterRevision, emit);
    } else if (parsed.usable && parsed.eventName === 'SessionStart') {
      await sweepStaleSessions(stateRoot, now());
    }
  } catch {
    emit('internal-failure');
  }

  return {
    recorded,
    disabled: false,
    eventName: parsed.eventName,
    sessionKey,
    diagnostics,
    stdout: '',
  };
}

/**
 * Fold a session, write its summary to the configured sink, and release its state.
 *
 * Called on `SessionEnd`, which the documentation describes as running when a
 * session is archived, deleted, closed normally, or has been idle for 30 minutes.
 * A session that never ends leaves bounded state behind until a sweep removes it.
 */
async function flushSession(
  stateRoot: string,
  sessionKey: string,
  sink: HandleOptions['sink'],
  limits: typeof DEFAULT_OBSERVATION_LIMITS,
  adapterRevision: string,
  emit: (code: ObserverDiagnosticCode) => void,
): Promise<void> {
  const { accumulator } = await loadSession(stateRoot, sessionKey, limits);
  const summary = buildSummary(accumulator, {
    adapterRevision,
    unattributed: sessionKey === sessionKeyFor(undefined),
  });

  if (sink !== undefined) {
    try {
      await sink(summary);
    } catch {
      emit('sink-failed');
    }
  }

  await releaseSession(stateRoot, sessionKey);
  emit('session-end-flushed');
}

/** True when bounded diagnostics should be written to stderr. */
export function shouldWriteDiagnosticsToStderr(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return isDebugEnvironment(env);
}
