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
export { LEVEL2_TASKS, findTask } from './tasks.js';
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
export { checkArmArtifactProvenance, intakeArmEvidence } from './intake.js';
export type {
  ArmEvidenceIntake,
  ArmEvidenceOutcome,
  ArmInvalidReason,
  ArmProvenanceInput,
  ArmProvenanceVerdict,
} from './intake.js';
export { checkLiveEngagement } from './engagement.js';
export type { LiveEngagementVerdict } from './engagement.js';
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
export {
  requireTask,
  runOfflineVerification,
  syntheticObservation,
  taskCategories,
  taskIds,
} from './verify.js';
export type { OfflineVerificationResult, VerificationCheck } from './verify.js';
export type {
  Level2ApplyEvidence,
  Level2Arm,
  Level2ArmObservation,
  Level2BehaviourObservation,
  Level2ContainmentEvidence,
  Level2Declaration,
  Level2Distribution,
  Level2ExperimentResult,
  Level2GradeCheck,
  Level2Grading,
  Level2InSessionGovernorEvidence,
  Level2MechanismVerdict,
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
