import type {
  BenchmarkProvenance,
  BenchmarkRunRecord,
  ComparisonResult,
  ComparisonVerdict,
  Measurement,
  MeasurementEvidenceClass,
  MetricName,
  VariantProvenance,
} from './types.js';
import {
  ALL_METRICS,
  findInvalidMetricValues,
  isAvailable,
  measured,
  unavailable,
} from './measurement.js';
import { createConfigurationId } from './provenance.js';

/**
 * Compare a baseline run with a candidate run.
 *
 * Precedence: identity and provenance problems make a comparison invalid, then
 * invalid measurements, then correctness. A candidate can only be reported as
 * a verified improvement when it passes every correctness check *and* the
 * token measurements are real.
 */
export function compareRuns(
  baseline: BenchmarkRunRecord,
  candidate: BenchmarkRunRecord,
): ComparisonResult {
  const delta = tokenDelta(baseline, candidate);
  const percent = tokenDeltaPercent(baseline, candidate);

  if (baseline.fixtureId !== candidate.fixtureId) {
    return comparison(
      candidate.fixtureId,
      'invalid',
      `The runs describe different fixtures ("${baseline.fixtureId}" and "${candidate.fixtureId}").`,
      { tokenDelta: delta, tokenDeltaPercent: percent },
    );
  }

  if (baseline.role !== 'baseline' || candidate.role !== 'candidate') {
    return comparison(
      candidate.fixtureId,
      'invalid',
      'A comparison requires exactly one baseline run and one candidate run.',
      { tokenDelta: delta, tokenDeltaPercent: percent },
    );
  }

  if (
    baseline.provenance.fixtureId !== baseline.fixtureId ||
    candidate.provenance.fixtureId !== candidate.fixtureId
  ) {
    return comparison(
      candidate.fixtureId,
      'invalid',
      'Provenance does not match the recorded fixture identity.',
      { tokenDelta: delta, tokenDeltaPercent: percent },
    );
  }

  const provenanceProblem = firstProvenanceMismatch(baseline, candidate);
  if (provenanceProblem !== undefined) {
    return comparison(candidate.fixtureId, 'invalid', provenanceProblem, {
      tokenDelta: delta,
      tokenDeltaPercent: percent,
    });
  }

  const metricProblems = [
    ...findInvalidMetricValues(baseline.metrics).map((problem) => `baseline ${problem}`),
    ...findInvalidMetricValues(candidate.metrics).map((problem) => `candidate ${problem}`),
  ];
  if (metricProblems.length > 0) {
    return comparison(candidate.fixtureId, 'invalid', `Invalid measurements: ${metricProblems.join(' ')}`, {
      tokenDelta: delta,
      tokenDeltaPercent: percent,
    });
  }

  if (!baseline.correctness.passed) {
    return comparison(
      candidate.fixtureId,
      'invalid',
      'The baseline run failed its correctness checks, so the comparison is not meaningful.',
      { tokenDelta: delta, tokenDeltaPercent: percent },
    );
  }

  if (!candidate.correctness.passed) {
    const failedChecks = candidate.correctness.checks
      .filter((check) => !check.passed)
      .map((check) => check.name);
    return comparison(
      candidate.fixtureId,
      'regression',
      `The candidate failed required correctness checks (${failedChecks.join(', ')}); changed context is never reported as a successful optimization.`,
      { correctnessRegression: true, tokenDelta: delta, tokenDeltaPercent: percent },
    );
  }

  const baselineTotal = baseline.metrics.totalTokens;
  const candidateTotal = candidate.metrics.totalTokens;

  if (!isAvailable(baselineTotal) || !isAvailable(candidateTotal)) {
    return comparison(
      candidate.fixtureId,
      'unavailable',
      'Total token usage is unavailable for at least one run, so no token comparison can be made.',
      { tokenDelta: delta, tokenDeltaPercent: percent },
    );
  }

  if (baselineTotal.evidence === 'estimated' || candidateTotal.evidence === 'estimated') {
    return comparison(
      candidate.fixtureId,
      'unavailable',
      'At least one run reports estimated token counts; estimates cannot support a benchmark-verified comparison.',
      { tokenDelta: delta, tokenDeltaPercent: percent },
    );
  }

  const difference = candidateTotal.value - baselineTotal.value;

  if (baselineTotal.value === 0) {
    return comparison(
      candidate.fixtureId,
      'unavailable',
      'The baseline total token count is zero, so a percentage change cannot be computed.',
      {
        tokenDelta: measured(difference),
        tokenDeltaPercent: unavailable(
          'A percentage change cannot be computed from a zero baseline.',
        ),
      },
    );
  }

  const changePercent = (difference / baselineTotal.value) * 100;

  if (difference < 0) {
    return comparison(
      candidate.fixtureId,
      'benchmark-verified',
      `The candidate used ${Math.abs(difference)} fewer total tokens (${Math.abs(changePercent).toFixed(2)}% less) and passed every correctness check.`,
      { tokenDelta: measured(difference), tokenDeltaPercent: measured(changePercent) },
    );
  }

  if (difference > 0) {
    return comparison(
      candidate.fixtureId,
      'regression',
      `The candidate used ${difference} more total tokens (${changePercent.toFixed(2)}% more).`,
      { tokenDelta: measured(difference), tokenDeltaPercent: measured(changePercent) },
    );
  }

  return comparison(candidate.fixtureId, 'no-change', 'Both runs report the same total token count.', {
    tokenDelta: measured(0),
    tokenDeltaPercent: measured(0),
  });
}

/** Change in total tokens, when both runs provide real token measurements. */
function tokenDelta(
  baseline: BenchmarkRunRecord,
  candidate: BenchmarkRunRecord,
): Measurement<number> {
  const baselineTotal = baseline.metrics.totalTokens;
  const candidateTotal = candidate.metrics.totalTokens;
  if (!isAvailable(baselineTotal) || !isAvailable(candidateTotal)) {
    return unavailable('Total token measurements are unavailable for at least one run.');
  }
  return measured(candidateTotal.value - baselineTotal.value);
}

/** Percentage change in total tokens, guarding against a zero baseline. */
function tokenDeltaPercent(
  baseline: BenchmarkRunRecord,
  candidate: BenchmarkRunRecord,
): Measurement<number> {
  const baselineTotal = baseline.metrics.totalTokens;
  const candidateTotal = candidate.metrics.totalTokens;
  if (!isAvailable(baselineTotal) || !isAvailable(candidateTotal)) {
    return unavailable('A percentage change cannot be computed without total token measurements.');
  }
  if (baselineTotal.value === 0) {
    return unavailable('The baseline total token count is zero, so a percentage change cannot be computed.');
  }
  return measured(((candidateTotal.value - baselineTotal.value) / baselineTotal.value) * 100);
}

/**
 * Reason the two runs are not comparable, or `undefined` when they are.
 *
 * Two dispatch paths exist: undeclared runs keep the original strict
 * `configurationId` guard, while runs that both carry a declared variant are
 * compared through the declared path, which permits exactly one difference and
 * re-verifies every other comparability fact.
 */
function firstProvenanceMismatch(
  baseline: BenchmarkRunRecord,
  candidate: BenchmarkRunRecord,
): string | undefined {
  const base = baseline.provenance.variant;
  const declared = candidate.provenance.variant;

  if (base === undefined && declared === undefined) {
    return firstUndeclaredProvenanceMismatch(baseline, candidate);
  }
  if (base === undefined || declared === undefined) {
    return 'Inconsistent variant metadata: exactly one run declares an optimization variant, so the pair is not a declared controlled comparison.';
  }
  return firstDeclaredVariantMismatch(baseline, candidate, base, declared);
}

/**
 * The original Stage 1B guard, unchanged: two undeclared runs are comparable
 * only when their harness, mode, configuration identity and optimizer revision
 * all match. Stage 1S never weakens this path.
 */
function firstUndeclaredProvenanceMismatch(
  baseline: BenchmarkRunRecord,
  candidate: BenchmarkRunRecord,
): string | undefined {
  const base = baseline.provenance;
  const candidateProvenance = candidate.provenance;

  if (base.harness !== candidateProvenance.harness) {
    return `The runs were recorded with different harnesses ("${base.harness}" and "${candidateProvenance.harness}").`;
  }
  if (base.mode !== candidateProvenance.mode) {
    return `The runs were recorded in different optimization modes ("${base.mode}" and "${candidateProvenance.mode}").`;
  }
  if (base.configurationId !== candidateProvenance.configurationId) {
    return 'The runs were recorded with different optimizer configurations.';
  }
  if (base.optimizerRevision !== candidateProvenance.optimizerRevision) {
    return `The runs used different optimizer revisions ("${base.optimizerRevision}" and "${candidateProvenance.optimizerRevision}").`;
  }
  return undefined;
}

/**
 * Comparability for a pair that both declare the same controlled experiment.
 *
 * The declaration permits exactly one difference — the optimizer configuration —
 * and only when both arms agree on the experiment, the axis and the arm
 * assignment. Every other fact that could invalidate a baseline/treatment
 * comparison is re-checked here: harness, mode, optimizer revision, model,
 * repository revision, input context, correctness criteria and measurement
 * definitions. The configuration identity is re-derived from its recorded
 * parts so a difference cannot be hidden outside the declared axis.
 */
function firstDeclaredVariantMismatch(
  baseline: BenchmarkRunRecord,
  candidate: BenchmarkRunRecord,
  base: VariantProvenance,
  declared: VariantProvenance,
): string | undefined {
  const baseProvenance: BenchmarkProvenance = baseline.provenance;
  const candidateProvenance: BenchmarkProvenance = candidate.provenance;

  if (baseProvenance.harness !== candidateProvenance.harness) {
    return `The runs were recorded with different harnesses ("${baseProvenance.harness}" and "${candidateProvenance.harness}").`;
  }
  if (baseProvenance.mode !== candidateProvenance.mode) {
    return `The runs were recorded in different optimization modes ("${baseProvenance.mode}" and "${candidateProvenance.mode}").`;
  }
  if (baseProvenance.optimizerRevision !== candidateProvenance.optimizerRevision) {
    return `The runs used different optimizer revisions ("${baseProvenance.optimizerRevision}" and "${candidateProvenance.optimizerRevision}").`;
  }

  if (base.declarationId !== declared.declarationId) {
    return 'The declared runs belong to different controlled experiments, so they are not one control/treatment pair.';
  }
  if (base.axis !== declared.axis) {
    return `The declared runs declare different optimization axes ("${base.axis}" and "${declared.axis}").`;
  }
  // The run roles are already pinned to baseline/candidate by `compareRuns`, so
  // requiring the declared arms to match them is what makes a swapped
  // declaration fail instead of silently flipping the A/B direction.
  if (base.role !== 'baseline' || declared.role !== 'candidate') {
    return 'The declared variant arms are assigned the wrong roles: the control arm must be the baseline and the treatment arm the candidate.';
  }
  if (base.variantId === declared.variantId) {
    return `The declared runs record the same variant arm ("${base.variantId}"), so no control/treatment difference is declared.`;
  }

  if (baseProvenance.optimizerConfiguration === candidateProvenance.optimizerConfiguration) {
    return 'The declared runs record the same optimizer configuration, so the declared optimization difference is missing.';
  }

  const expectedBaselineConfiguration = createConfigurationId({
    harness: baseProvenance.harness,
    optimizerRevision: baseProvenance.optimizerRevision,
    mode: baseProvenance.mode,
    optimizerConfiguration: baseProvenance.optimizerConfiguration,
  });
  if (baseProvenance.configurationId !== expectedBaselineConfiguration) {
    return 'The baseline configuration identity is not consistent with its recorded harness, revision, mode and configuration.';
  }
  const expectedCandidateConfiguration = createConfigurationId({
    harness: candidateProvenance.harness,
    optimizerRevision: candidateProvenance.optimizerRevision,
    mode: candidateProvenance.mode,
    optimizerConfiguration: candidateProvenance.optimizerConfiguration,
  });
  if (candidateProvenance.configurationId !== expectedCandidateConfiguration) {
    return 'The candidate configuration identity is not consistent with its recorded harness, revision, mode and configuration.';
  }
  if (baseProvenance.configurationId === candidateProvenance.configurationId) {
    return 'The declared runs share one configuration identity despite declaring different arms.';
  }

  if (!sameMeasurementIdentity(baseProvenance.model, candidateProvenance.model)) {
    return 'The declared runs were recorded with different models; a token comparison across models is not meaningful.';
  }
  if (
    !sameMeasurementIdentity(
      baseProvenance.repositoryRevision,
      candidateProvenance.repositoryRevision,
    )
  ) {
    return 'The declared runs were recorded against different repository revisions, so the test environment differs.';
  }
  if (baseline.inputHash !== candidate.inputHash) {
    return 'The declared runs were recorded for different input contexts.';
  }

  const baseChecks = baseline.correctness.checks.map((check) => check.name).join('\n');
  const candidateChecks = candidate.correctness.checks.map((check) => check.name).join('\n');
  if (baseChecks !== candidateChecks) {
    return 'The declared runs use different correctness checks, so their correctness outcomes are not comparable.';
  }

  if (!sameMeasurementDefinitions(baseProvenance.measurementEvidence, candidateProvenance.measurementEvidence)) {
    return 'The declared runs use different measurement definitions.';
  }

  return undefined;
}

/**
 * Two provenance measurements describe the same thing only when both are
 * unavailable or both carry the same observed value. An available value is
 * never treated as equal to a missing one.
 */
function sameMeasurementIdentity(a: Measurement<string>, b: Measurement<string>): boolean {
  if (!isAvailable(a) || !isAvailable(b)) {
    return !isAvailable(a) && !isAvailable(b);
  }
  return a.value === b.value;
}

/** Per-metric evidence classifications must match for a comparable pair. */
function sameMeasurementDefinitions(
  a: Readonly<Record<MetricName, MeasurementEvidenceClass>>,
  b: Readonly<Record<MetricName, MeasurementEvidenceClass>>,
): boolean {
  return ALL_METRICS.every((name) => a[name] === b[name]);
}

function comparison(
  fixtureId: string,
  verdict: ComparisonVerdict,
  reason: string,
  options: {
    readonly correctnessRegression?: boolean;
    readonly tokenDelta?: Measurement<number>;
    readonly tokenDeltaPercent?: Measurement<number>;
    readonly notes?: readonly string[];
  } = {},
): ComparisonResult {
  return {
    fixtureId,
    verdict,
    reason,
    correctnessRegression: options.correctnessRegression ?? false,
    tokenDelta: options.tokenDelta ?? unavailable('No token delta is available for this comparison.'),
    tokenDeltaPercent:
      options.tokenDeltaPercent ?? unavailable('No token percentage change is available for this comparison.'),
    notes: options.notes ?? [],
  };
}
