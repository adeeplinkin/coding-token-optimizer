/**
 * Public API of the Dr. Token OpenCode observer (Stage 1D).
 *
 * This adapter is **observation only**: it records what OpenCode did — tool
 * executions, potentially repeated read requests, and the token and cost fields
 * OpenCode actually reports — and never modifies model context, tool arguments,
 * tool results, titles, metadata, or any execution outcome.
 *
 * It is not an optimizer. No token saving is implemented, produced or claimed.
 *
 * Verified against `@opencode-ai/plugin` 1.18.35 (V1 `Hooks` contract); see
 * `docs/OPENCODE_OBSERVER.md` for the compatibility classification and the
 * runtime-validation status.
 */
export {
  CALCULATED_NOT_REPRESENTABLE_NOTE,
  HARNESS_OWNED_METRIC_NOTE,
  OPENCODE_HARNESS_ID,
  toHarnessEvidence,
  toHarnessMeasurement,
  toObservedRunMetrics,
} from './benchmark-adapter.js';
export type {
  HarnessAvailableMeasurement,
  HarnessMeasurement,
  HarnessMeasurementEvidenceClass,
  HarnessUnavailableMeasurement,
  ObservedRunMetrics,
} from './benchmark-adapter.js';
export { READ_TARGET_ID_LENGTH, defaultHash, isHexDigestLike } from './hash.js';
export { OpenCodeObserver, isDisabledByEnvironment } from './observer.js';
export {
  DrTokenOpenCodeObserver,
  createOpenCodeObserver,
  createOpenCodeObserverHooks,
  createOpenCodeObserverPlugin,
} from './plugin.js';
export type { CreatedOpenCodeObserver } from './plugin.js';
export {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_OFFSET,
  READ_IDENTITY_SCHEME,
  READ_TOOL_ID,
  identifyReadRequest,
  normalizeReadPath,
} from './read.js';
export {
  createSummaryFileSink,
  isUsableSummaryPath,
  resolveEnvironmentSink,
} from './sink.js';
export {
  DEFAULT_OBSERVATION_LIMITS,
  IMPLEMENTED_HOOKS,
  OBSERVATION_NOTES,
  OBSERVATION_SCHEMA_VERSION,
  OBSERVER_ADAPTER_NAME,
  OBSERVER_ADAPTER_REVISION,
  OBSERVER_DIAGNOSTIC_LEVELS,
  OBSERVER_DIAGNOSTIC_MESSAGES,
  OBSERVER_DISABLE_ENV_VAR,
  OBSERVER_SUMMARY_FILE_ENV_VAR,
  OPENCODE_PLUGIN_PACKAGE,
  OPENCODE_PLUGIN_VERIFIED_VERSION,
  USAGE_FIELDS,
} from './types.js';
export type {
  IdentifiedReadRequest,
  ReadRequestIdentification,
  UnidentifiedReadRequest,
} from './read.js';
export type { MessageUsageSnapshot, UsageExtraction, UsageIgnoredReason, UsageMerge } from './usage.js';
export {
  extractAssistantUsage,
  mergeUsageSnapshots,
  readUsageNumber,
  reportedUsageFieldCount,
} from './usage.js';
export type {
  ImplementedHook,
  ObservationCountMetric,
  ObservationEvidence,
  ObservationLimits,
  ObservationMeasurement,
  ObservationMissing,
  ObservationSink,
  ObservationValue,
  ObserverAdapterIdentity,
  ObserverDiagnostic,
  ObserverDiagnosticCode,
  ObserverOptions,
  ObserverSnapshot,
  OpenCodeEventHookInput,
  OpenCodeObserverHooks,
  OpenCodeObserverPlugin,
  OpenCodePluginInput,
  OpenCodePluginOptions,
  OpenCodeRuntimeEvent,
  OpenCodeToolExecuteAfterInput,
  OpenCodeToolExecuteAfterOutput,
  OpenCodeToolExecuteBeforeInput,
  OpenCodeToolExecuteBeforeOutput,
  ReadObservationSummary,
  SessionLifecycleSummary,
  SessionObservationCounts,
  SessionObservationMeasurements,
  SessionObservationSummary,
  ToolFrequencyEntry,
  UsageField,
  UsageObservationSummary,
} from './types.js';
