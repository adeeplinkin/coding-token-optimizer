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
export {
  CONTAINMENT_COMMAND_ARGUMENT_KEYS,
  CONTAINMENT_DENIED_TOOLS,
  CONTAINMENT_GUARD_PLUGIN_ID,
  CONTAINMENT_PATH_ARGUMENT_KEYS,
  classifyContainedPath,
  classifyToolCall,
  createContainmentGuardPluginV2,
  summarizeContainmentEvidence,
} from './containment.js';
export type {
  ContainmentBlockReason,
  ContainmentClassification,
  ContainmentEvidenceLine,
  ContainmentEvidenceSummary,
  ContainmentGuardOptions,
  ContainmentPathVerdict,
} from './containment.js';
export {
  MAX_INTERRUPT_ATTEMPTS,
  decideCostGovernor,
  latestSessionCostUsd,
  missingGovernorHelpers,
  planGovernorArming,
  startCostGovernor,
} from './governor.js';
export type {
  CostGovernor,
  CostGovernorAction,
  CostGovernorInput,
  CostGovernorOptions,
  CostGovernorState,
  GovernorArmingInput,
  GovernorArmingPlan,
  GovernorHelperAvailability,
} from './governor.js';
export { READ_TARGET_ID_LENGTH, defaultHash, isHexDigestLike } from './hash.js';
export {
  SAFE_MODE_ELISION_MARKER,
  SAFE_MODE_ELISION_NOTES,
  SAFE_MODE_ELISION_PASS_ID,
  SAFE_MODE_ELISION_REFUSAL_REASONS,
  SAFE_MODE_ELISION_VERSION,
  SAFE_MODE_REQUEST_KIND_BASES,
  applySafeModeElision,
  emptyElisionRefusals,
  isAgentLoopContextPayload,
} from './safe-mode-elision.js';
export type {
  SafeModeElisionOptions,
  SafeModeElisionOutcome,
  SafeModeElisionRefusalReason,
  SafeModeRequestKindBasis,
} from './safe-mode-elision.js';
export {
  OpenCodeObserver,
  isDisabledByEnvironment,
  normalizeProjectDirectory,
  resolveSafeModeSetting,
} from './observer.js';
export {
  DEFAULT_OPPORTUNITY_LIMITS,
  OPPORTUNITY_OCCURRENCE_REFUSAL_REASONS,
  OPPORTUNITY_PART_EXCLUSION_REASONS,
  SAFE_MODE_MARKER_PREFIX,
  SAFE_MODE_TOOL_ALLOWLIST,
  analyseRequestOpportunities,
  emptyOccurrenceRefusalCounts,
  emptyPartExclusionCounts,
} from './opportunity.js';
export type {
  OpportunityLimits,
  OpportunityOccurrenceRefusalReason,
  OpportunityPartExclusionReason,
  RequestOpportunityAnalysis,
} from './opportunity.js';
export {
  DrTokenOpenCodeObserver,
  createOpenCodeObserver,
  createOpenCodeObserverHooks,
  createOpenCodeObserverPlugin,
} from './plugin.js';
export type { CreatedOpenCodeObserver } from './plugin.js';
export {
  DrTokenOpenCodeObserverV2,
  V2_REQUIRED_CAPABILITIES,
  asRuntimeEvent,
  createOpenCodeObserverPluginV2,
  createOpenCodeObserverV2,
  readExpectedProject,
  toV1ToolAfter,
  toV1ToolBefore,
} from './plugin-v2.js';
export type { CreatedOpenCodeObserverV2 } from './plugin-v2.js';
export {
  IMPLEMENTED_V2_TOOL_HOOKS,
  OBSERVER_V2_PLUGIN_ID,
  OPENCODE_V2_PLUGIN_PACKAGE,
  OPENCODE_V2_PLUGIN_VERIFIED_VERSION,
  OPENCODE_V2_SCHEMA_PACKAGE,
  OPENCODE_V2_SCHEMA_VERIFIED_VERSION,
  defineOpenCodeV2Plugin,
} from './types-v2.js';
export type {
  ImplementedV2ToolHook,
  OpenCodeV2Cleanup,
  OpenCodeV2Event,
  OpenCodeV2EventDomain,
  OpenCodeV2LocationInfo,
  OpenCodeV2LocationRef,
  OpenCodeV2Plugin,
  OpenCodeV2PluginContext,
  OpenCodeV2ProjectInfo,
  OpenCodeV2Registration,
  OpenCodeV2SessionContext,
  OpenCodeV2SessionCreatedData,
  OpenCodeV2SessionDeletedData,
  OpenCodeV2SessionDomain,
  OpenCodeV2SessionHookSpec,
  OpenCodeV2SessionMovedData,
  OpenCodeV2ToolDomain,
  OpenCodeV2ToolExecuteAfterEvent,
  OpenCodeV2ToolExecuteAfterFields,
  OpenCodeV2ToolExecuteBeforeEvent,
  OpenCodeV2ToolHookSpec,
} from './types-v2.js';
// The default export is the V2 plugin definition, because V2 discovery loads the
// default export of a project-local plugin file. V1 consumers keep importing the
// named `DrTokenOpenCodeObserver` plugin function instead.
export { DrTokenOpenCodeObserverV2 as default } from './plugin-v2.js';
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
export { compareSessionUsage, extractSessionUsage, sessionUsageFields } from './usage.js';
export type {
  SessionUsageComparison,
  SessionUsageExtraction,
  SessionUsageIgnoredReason,
  SessionUsageSnapshot,
} from './usage.js';
export {
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_OBSERVATION_LIMITS,
  DEFAULT_OBSERVER_PLUGIN_API,
  IMPLEMENTED_HOOKS,
  OPENCODE_V2_EXECUTION_SUCCEEDED_EVENT_TYPE,
  OPENCODE_V2_USAGE_EVENT_TYPE,
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
  SAFE_MODE_ENV_VAR,
  SAFE_MODE_OBSERVATION_NOTES,
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
  ObserverPluginApiIdentity,
  ObserverDiagnosticCode,
  ObserverExpectedProject,
  ObserverOptions,
  ObserverSnapshot,
  OpenCodeEventHookInput,
  OpenCodeObserverHooks,
  OpenCodeObserverPlugin,
  OpenCodePluginApiLine,
  OpenCodePluginInput,
  OpenCodePluginOptions,
  OpenCodeRuntimeEvent,
  OpenCodeToolExecuteAfterInput,
  OpenCodeToolExecuteAfterOutput,
  OpenCodeToolExecuteBeforeInput,
  OpenCodeToolExecuteBeforeOutput,
  ProjectAttributionBasis,
  ProjectScopeVerification,
  ReadObservationSummary,
  SafeModeApplySummary,
  SafeModeMode,
  SafeModeOpportunitySummary,
  SafeModeSetting,
  SessionLifecycleSummary,
  SessionObservationCounts,
  SessionObservationMeasurements,
  SessionObservationSummary,
  SessionProjectScope,
  SourceReportedUsageSummary,
  ToolFrequencyEntry,
  UsageAggregationSemantics,
  UsageField,
  UsageObservationSummary,
} from './types.js';
