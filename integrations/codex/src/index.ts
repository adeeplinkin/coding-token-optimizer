/**
 * Public API of the Dr. Token Codex observer (Stage 1L).
 *
 * This adapter is **observation only**. It reads Codex lifecycle hook payloads,
 * records content-free observations about them in Dr. Token's own state, and
 * returns nothing to Codex. It cannot change prompts, tool arguments, tool
 * results, permissions, compaction or turn continuation: its entry point writes no
 * stdout and always exits 0.
 *
 * It is not an optimizer. No token saving is implemented, produced or claimed, and
 * token usage is reported as `unavailable` because no Codex hook payload carries
 * usage.
 *
 * Verified against the Codex build installed on the research machine
 * (`codex-cli 0.162.0-alpha.17.2`, `hooks` feature flag `stable`); see
 * `docs/CODEX_OBSERVER.md` for the compatibility classification and the
 * runtime-validation status.
 */
export {
  buildObservationRecord,
  handleHookPayload,
  shouldWriteDiagnosticsToStderr,
} from './handler.js';
export {
  MAX_STDIN_BYTES,
  isDirectEntry,
  parseStdinPayload,
  readStdinText,
  runEntry,
} from './entry.js';
export { classifyReadAttempt, isReadLikeToolName, isShellToolName } from './reads.js';
export type { ReadClassification } from './reads.js';
export { normalizeEventName, parseHookPayload } from './hook-input.js';
export { defaultHash, isDigestLike, normalizePath, IDENTITY_LENGTH } from './identity.js';
export {
  createSummaryFileSink,
  resolveEnvironmentSink,
} from './sink.js';
export {
  isDebugEnvironment,
  isDisabledByEnvironment,
  isUsablePath,
  stateDirFromEnvironment,
  summaryFilePathFromEnvironment,
} from './env.js';
export {
  appendRecord,
  compactSession,
  loadSession,
  parseJournalContents,
  releaseSession,
  resolveStateRoot,
  sessionPaths,
  sweepStaleSessions,
  COMPACTION_TRIGGER_BYTES,
  LOCK_STALE_MS,
  STATE_MAX_AGE_MS,
  STATE_ROOT_DIRNAME,
} from './storage.js';
export type { AppendOutcome, CompactionResult, LoadedSession, SessionPaths } from './storage.js';
export {
  applyRecord,
  applyRecords,
  buildSummary,
  createAccumulator,
  fromPersisted,
  parseRecord,
  readSummary,
  sessionKeyFor,
  toPersisted,
} from './accumulate.js';
export {
  CODEX_CLI_VERIFIED_VERSION,
  CODEX_HOST_PRODUCT,
  CODEX_OBSERVER_ADAPTER_NAME,
  CODEX_OBSERVER_ADAPTER_REVISION,
  CODEX_OBSERVER_DEBUG_ENV_VAR,
  CODEX_OBSERVER_DISABLE_ENV_VAR,
  CODEX_OBSERVER_STATE_DIR_ENV_VAR,
  CODEX_OBSERVER_SUMMARY_FILE_ENV_VAR,
  CODEX_USAGE_UNAVAILABLE_NOTE,
  DEFAULT_OBSERVATION_LIMITS,
  IMPLEMENTED_HOOK_EVENTS,
  OBSERVATION_NOTES,
  OBSERVATION_SCHEMA_VERSION,
  OBSERVER_DIAGNOSTIC_LEVELS,
  OBSERVER_DIAGNOSTIC_MESSAGES,
  READ_IDENTITY_SCHEME,
  UNATTRIBUTED_SESSION_KEY,
  UNKNOWN_SESSION_ID,
} from './types.js';
export type {
  CodexHookEventName,
  CodexJournalStatus,
  CodexObserverAdapterIdentity,
  CodexSessionCounts,
  CodexSessionMeasurements,
  CodexSessionObservationSummary,
  CompactionTrigger,
  HandleOptions,
  HandleResult,
  HookEnvelope,
  IdentifiedReadRequest,
  ObservationLimits,
  ObservationMeasurement,
  ObservationRecord,
  ObservationRecordKind,
  ObservationSink,
  ObserverDiagnostic,
  ObserverDiagnosticCode,
  ParsedHookEvent,
  ProjectAttributionBasis,
  ProjectScopeVerification,
  ReadIdentification,
  ReadIdentificationReason,
  ReadIdentityBasis,
  ReadObservationSummary,
  SessionProjectScope,
  SessionStartSource,
  ToolFrequencyEntry,
  UnidentifiedReadRequest,
} from './types.js';
export type { Accumulator, PersistedAccumulator, ToolCounts } from './accumulate.js';
