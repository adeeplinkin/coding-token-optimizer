/**
 * From an arm observation to a framework run record.
 *
 * The point of this module is that Level 2 produces records the **existing**
 * framework can judge, instead of a parallel scoring path. Each arm run becomes a
 * `BenchmarkRunRecord` with its declared-variant provenance, so `compareRuns`
 * re-verifies comparability, applies correctness precedence, and refuses anything
 * it cannot compare — exactly as it does for synthetic fixtures.
 *
 * Three rules are load-bearing:
 *
 * 1. `inputHash` is identical across the arms of a pair and covers the instruction,
 *    the repository revision, the model and the declaration — so prompt drift,
 *    a different starting state or a swapped arm invalidates the pair instead of
 *    quietly producing a number.
 * 2. `totalTokens` is **always** unavailable. The host publishes no session total
 *    and the fields it does publish overlap; a derived total would be a fabricated
 *    measurement. The per-field values are reported separately.
 * 3. Correctness is the task's own acceptance test. The mechanism classification is
 *    deliberately *not* a correctness check: a run where the pass did not fire is
 *    excluded from the comparison as `no-opportunity`, not turned into a failure.
 */
import { createHash } from 'node:crypto';
import { summarizeMetricEvidence, measured, unavailable } from '../measurement.js';
import { createProvenance } from '../provenance.js';
import { variantProvenanceFor } from '../variant.js';
import type {
  BenchmarkProvenance,
  BenchmarkRunRecord,
  CorrectnessCheck,
  DeclaredVariant,
  OptimizationDecisionSummary,
  RunMetrics,
} from '../types.js';
import type { Level2ArmObservation } from './types.js';
import { configurationFor, roleFor, safeModeSettingFor } from './variants.js';

/** Reason recorded for the token total, which is never derived. */
export const LEVEL2_TOTAL_TOKENS_NOTE =
  'The harness publishes no session token total, and the fields it does publish (input, output, reasoning, cache read/write) overlap. A total would be a derived number rather than a measurement, so it stays unavailable and the per-field values are reported separately.';

/** Reason recorded when a host-reported field was absent for a run. */
export const LEVEL2_FIELD_UNAVAILABLE_NOTE =
  'The host did not report this field for this run; no estimate is substituted.';

/** Reason recorded for a behavioural count the observer did not produce. */
export const LEVEL2_BEHAVIOUR_UNAVAILABLE_NOTE =
  'The observer did not report this count for this run; no estimate is substituted.';

/** Stable harness identifier for these runs. */
export const LEVEL2_HARNESS_ID = 'opencode-coding-task';

/**
 * Identity of what the pair shared.
 *
 * Computed from the task, the instruction hash, the repository revision, the
 * harness, the model and the declaration — and deliberately *not* from the arm's
 * optimizer configuration, which is the one axis the declaration permits to differ.
 * A pair produced from a different instruction or a different starting state
 * therefore fails the comparison instead of being reported.
 */
export function pairInputHash(observation: Level2ArmObservation, declaredVariant?: DeclaredVariant): string {
  const parts = [
    observation.taskId,
    observation.promptHash,
    observation.repositoryRevision,
    observation.harness,
    observation.model ?? 'model-unavailable',
    declaredVariant?.declarationId ?? 'undeclared',
  ];
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

/** The declared-variant provenance this arm records. */
export function armVariantProvenance(observation: Level2ArmObservation, declaration: DeclaredVariant) {
  return variantProvenanceFor(declaration, roleFor(observation.identity.arm));
}

/** Metrics for one arm run, each carrying the evidence class it earned. */
export function armMetrics(observation: Level2ArmObservation): RunMetrics {
  const { usage, behaviour } = observation;
  const field = (value: number | undefined) =>
    value === undefined ? unavailable(LEVEL2_FIELD_UNAVAILABLE_NOTE) : measured(value);
  const count = (value: number | undefined) =>
    value === undefined ? unavailable(LEVEL2_BEHAVIOUR_UNAVAILABLE_NOTE) : measured(value);

  return {
    inputTokens: field(usage.inputTokens),
    outputTokens: field(usage.outputTokens),
    // Never derived, for the reason in LEVEL2_TOTAL_TOKENS_NOTE.
    totalTokens: unavailable(LEVEL2_TOTAL_TOKENS_NOTE),
    toolCalls: count(behaviour.toolCalls),
    repeatedFileReads: count(behaviour.repeatedFileReads),
    durationMs: measured(observation.durationMs),
    recoveryAttempts: count(behaviour.recoveryAttempts),
    optimizerErrors: count(behaviour.optimizerErrors),
  };
}

/** The correctness checks every arm run records, in a fixed order. */
export function armCorrectnessChecks(
  observation: Level2ArmObservation,
  declaration: DeclaredVariant,
): readonly CorrectnessCheck[] {
  const checks: CorrectnessCheck[] = observation.grading.checks.map((check) => ({
    name: check.name,
    passed: check.passed,
    detail: check.detail,
  }));

  const arm = observation.identity.arm;
  const expected = configurationFor(arm);
  const declaredArm =
    roleFor(arm) === 'baseline' ? declaration.control : declaration.treatment;
  checks.push({
    name: 'arm-declaration-consistent',
    passed: declaredArm.optimizerConfiguration === expected,
    detail:
      declaredArm.optimizerConfiguration === expected
        ? `The ${arm} arm ran the configuration the declaration assigns to it.`
        : `The ${arm} arm recorded "${expected}" but the declaration assigns "${declaredArm.optimizerConfiguration}".`,
  });

  return checks;
}

/** Decisions recorded for a run. Level 2's pass reports through the apply counters, not here. */
export function armOptimizerDecisions(observation: Level2ArmObservation): readonly OptimizationDecisionSummary[] {
  const apply = observation.apply;
  if (observation.identity.arm !== 'treatment' || apply === undefined) {
    return [];
  }
  return [
    {
      passId: 'safe.exact-duplicate-tool-result-elision',
      action: apply.elidedOccurrences > 0 ? 'applied' : 'pass-through',
      evidence: 'measured',
    },
  ];
}

/** Provenance for one arm run. */
export function armProvenance(
  observation: Level2ArmObservation,
  declaration: DeclaredVariant,
  recordedAt: Date,
): BenchmarkProvenance {
  const metrics = armMetrics(observation);
  return createProvenance({
    fixtureId: observation.taskId,
    role: roleFor(observation.identity.arm),
    mode: 'safe',
    harness: observation.harness,
    ...(observation.model === undefined ? {} : { model: observation.model }),
    optimizerRevision: observation.optimizerRevision,
    optimizerConfiguration: configurationFor(observation.identity.arm),
    repositoryRevision: observation.repositoryRevision,
    variant: armVariantProvenance(observation, declaration),
    recordedAt,
    measurementEvidence: summarizeMetricEvidence(metrics),
  });
}

/**
 * Build the framework record for one arm run.
 *
 * `contextPreservedExactly` is the request-shape fact this record can honestly
 * state: true when nothing was elided in this run (so the assembled request is what
 * the host built), false when a marker was written or when the counters and the
 * wire disagreed.
 */
export function buildArmRunRecord(
  observation: Level2ArmObservation,
  declaration: DeclaredVariant,
  options: { readonly now?: () => Date } = {},
): BenchmarkRunRecord {
  const metrics = armMetrics(observation);
  const checks = armCorrectnessChecks(observation, declaration);
  const clock = options.now ?? ((): Date => new Date());
  const preserved =
    observation.mechanism === 'not-applicable' || observation.mechanism === 'no-opportunity';

  return {
    runId: observation.identity.runId,
    role: roleFor(observation.identity.arm),
    fixtureId: observation.taskId,
    fixtureCategory: 'source-code',
    inputHash: pairInputHash(observation, declaration),
    outputHash: observation.grading.outputDigest,
    inputLength: observation.grading.command.length,
    outputLength: observation.grading.outputExcerpt.length,
    contextPreservedExactly: preserved,
    correctness: {
      passed: checks.every((check) => check.passed),
      checks,
    },
    metrics,
    provenance: armProvenance(observation, declaration, clock()),
    optimizerDecisions: armOptimizerDecisions(observation),
  };
}

/** The Safe Mode setting the arm ran with, recorded beside the run for inspection. */
export function observedSafeModeSetting(observation: Level2ArmObservation): 'off' | 'apply' {
  return safeModeSettingFor(observation.identity.arm);
}
