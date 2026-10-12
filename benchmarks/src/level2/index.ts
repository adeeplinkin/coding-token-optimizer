/**
 * Level 2 — the paired control/treatment coding experiment (design §6.3).
 *
 * Exported as a unit so the module can be tested and driven without going through
 * the command line, and so the contract with the arm driver (`integrations/opencode/
 * scripts/level2-arm.mjs`) is visible in one place.
 */
export { buildPlan, runIdFor, taskPackFingerprint, validatePlan } from './plan.js';
export type { Level2Plan, Level2PlannedRun } from './plan.js';
export {
  MIN_ARM_RUNS,
  MIN_PAIRS_PER_TASK,
  MIN_PAIRS_TOTAL,
  MIN_TASKS,
  PAIR_ORDER_CONTROL_FIRST,
  PAIR_ORDER_TREATMENT_FIRST,
} from './plan.js';
export { LEVEL2_TASKS, MECHANISM_TASK_ID, findTask, mechanismReadPath } from './tasks.js';
export {
  LEVEL2_CONTROL_CONFIGURATION,
  LEVEL2_DECLARATION_ID,
  LEVEL2_DECLARED_VARIANT,
  LEVEL2_TREATMENT_CONFIGURATION,
  configurationFor,
  fingerprintDeclaration,
  resolveLevel2Declaration,
  roleFor,
  safeModeSettingFor,
} from './variants.js';
export {
  applyFiles,
  digest,
  materializeRepo,
  provisionTaskRepo,
  removeRepo,
  repoRevision,
  restoreGradedFiles,
  snapshotRepo,
  snapshotRevision,
  weakenGradedFiles,
} from './repos.js';
export { DEFAULT_GRADING_TIMEOUT_MS, gradeTask } from './grade.js';
export type { GradeOptions } from './grade.js';
export {
  LEVEL2_BEHAVIOUR_UNAVAILABLE_NOTE,
  LEVEL2_FIELD_UNAVAILABLE_NOTE,
  LEVEL2_HARNESS_ID,
  LEVEL2_TOTAL_TOKENS_NOTE,
  armCorrectnessChecks,
  armMetrics,
  armOptimizerDecisions,
  armProvenance,
  buildArmRunRecord,
  pairInputHash,
} from './records.js';
export { LEVEL2_MECHANISM_NOTES, classifyMechanism, describeMechanism, markerCount } from './mechanism.js';
export {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_COST_USD_PER_RUN,
  DEFAULT_MAX_UNITS,
  DEFAULT_MAX_UNITS_PER_RUN,
  conservativeTokenUnits,
  createBudgetTracker,
  hasNoReportedUsage,
  reportedCostUsd,
} from './budget.js';
export type { BudgetDecision, BudgetSettings, BudgetState, BudgetStopReason } from './budget.js';
export { readArmArtifact } from './observation.js';
export type { Level2ArtifactRead } from './observation.js';
export {
  checkArmArtifactProvenance,
  checkFreeOnlyPolicy,
  checkModelGuard,
  checkSessionCompletion,
  intakeArmEvidence,
} from './intake.js';
export type {
  ArmEvidenceIntake,
  ArmEvidenceOutcome,
  ArmInvalidReason,
  ArmProvenanceInput,
  ArmProvenanceVerdict,
  FreeOnlyPolicyVerdict,
  SessionCompletionVerdict,
} from './intake.js';
export { checkLiveEngagement } from './engagement.js';
export type { LiveEngagementVerdict } from './engagement.js';
export { parseWorkingTree, readWorkingTree } from './guards.js';
export type { GitRunner, WorkingTreeEntry, WorkingTreeState } from './guards.js';
export { runArmSequence } from './sequence.js';
export type {
  ArmSequenceBudget,
  ArmSequenceOptions,
  ArmSequenceResult,
  ArmSequenceStop,
  ArmStopCode,
} from './sequence.js';
export {
  LEVEL2_REPORT_DIR,
  LEVEL2_REPORT_NOTES,
  buildExperiment,
  describeDistribution,
  hasCorrectnessRegression,
  pairObservations,
  renderLevel2Json,
  renderLevel2Markdown,
} from './report.js';
export {
  ARM_DRIVER_PATH,
  DEFAULT_CLI_PATH,
  armWorkspace,
  isolationVerdict,
  probeArmEnvironment,
  probeCanRunModel,
  runArm,
} from './runner.js';
export type {
  ArmEnvironmentProbe,
  ArmEnvironmentProbeOutcome,
  ArmFreeOnlyProbe,
  ArmModelPrice,
  ArmObservedPaths,
  ArmRunOptions,
  ArmRunOutcome,
  ArmRuntimeMode,
  ModelAvailabilityReason,
  ModelAvailabilityVerdict,
} from './runner.js';
export { describeLiveBounds, liveRunRefusals } from './guards.js';
export type { LiveGuardInput } from './guards.js';
export { containmentProbeMatrix, runContainmentProbe } from './containment-probe.js';
export type {
  ContainmentProbeMatrix,
  ContainmentProbeOptions,
  ContainmentProbeRun,
  ContainmentProbeStep,
  ContainmentProbeStepResult,
} from './containment-probe.js';
export {
  MODEL_GUARD_PROBE_PLUGIN,
  PROBE_UNAPPROVED_MODEL,
  PROBE_UNKNOWN_MODEL,
  modelGuardProbeAvailable,
  modelGuardProbeCases,
  probePolicyDigest,
  removeModelGuardProbeCase,
  runModelGuardProbe,
  runModelGuardProbeCase,
} from './model-guard-probe.js';
export type {
  ModelGuardProbeCase,
  ModelGuardProbeCaseResult,
  ModelGuardProbeOptions,
  ModelGuardProbeOutcome,
  ModelGuardProbeRun,
} from './model-guard-probe.js';
export { SCRIPTED_PROVIDER, startScriptedProvider } from './scripted-provider.js';
export type { ScriptedProvider, ScriptedProviderOptions } from './scripted-provider.js';
export {
  freeOnlyPolicyEvidence,
  modelGuardEvidence,
  requireTask,
  runOfflineVerification,
  syntheticObservation,
  taskCategories,
  taskIds,
} from './verify.js';
export {
  AUXILIARY_REQUEST_KINDS,
  FREE_ONLY_APPROVED_MODELS,
  FREE_ONLY_AUXILIARY_MODEL,
  FREE_ONLY_PRICE_FIELDS,
  FREE_ONLY_PRIMARY_MODEL,
  FREE_ONLY_PROVIDER,
  MODEL_REQUEST_HOOK,
  PRIMARY_REQUEST_KIND,
  REQUEST_KINDS,
  approvedModelRefusals,
  auxiliaryRequestKinds,
  describePriceFacts,
  describeResolvedPolicy,
  endpointModelIds,
  freeOnlyModelConfig,
  freeOnlyModelConfigDigest,
  freeOnlyModelConfigText,
  freeOnlyPriceRefusals,
  freeOnlyRefusals,
  isApprovedEndpointModel,
  isFreeOnlyModelConfig,
  isZeroPriceRow,
  modelRefToId,
  readResolvedModelPolicy,
  resolvedPolicyRefusals,
} from './free-model-policy.js';
export type {
  CataloguePriceFacts,
  FreeOnlyModelConfig,
  FreeOnlyPriceField,
  ModelPriceRow,
  ResolvedModelPolicyFacts,
} from './free-model-policy.js';
export type { OfflineVerificationResult, VerificationCheck } from './verify.js';
export type {
  Level2ApplyEvidence,
  Level2Arm,
  Level2ArmObservation,
  Level2BehaviourObservation,
  Level2ContainmentEvidence,
  Level2Declaration,
  Level2Distribution,
  Level2EndpointKindCounts,
  Level2ExperimentResult,
  Level2GradeCheck,
  Level2Grading,
  Level2InSessionGovernorEvidence,
  Level2MechanismVerdict,
  Level2ModelPolicyEvidence,
  Level2NativePermissionsEvidence,
  Level2RequestKindEvidence,
  Level2PublishedPair,
  Level2RunDisposition,
  Level2RunDispositionClass,
  Level2RunIdentity,
  Level2Task,
  Level2TaskCategory,
  Level2TaskExpectation,
  Level2TaskFieldComparison,
  Level2TaskResult,
  Level2UsageObservation,
  Level2WireEvidence,
  Level2WireRequest,
} from './types.js';
