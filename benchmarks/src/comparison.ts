import type {
  BenchmarkRunRecord,
  ComparisonResult,
  ComparisonVerdict,
  Measurement,
} from './types.js';
import { findInvalidMetricValues, isAvailable, measured, unavailable } from './measurement.js';

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

/** Reason the two runs are not comparable, or `undefined` when they are. */
function firstProvenanceMismatch(
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
