import type {
  AvailableMeasurement,
  Measurement,
  MeasurementEvidenceClass,
  MetricName,
  RunMetrics,
  UnavailableMeasurement,
} from './types.js';

/**
 * Reason reused for every token metric in Stage 1B.
 *
 * Token usage cannot be observed without a real coding harness, and Dr. Token
 * must not invent estimates to fill the gap.
 */
export const TOKENS_UNAVAILABLE_NOTE =
  'Token usage is not observable without a real coding harness; no estimate is reported.';

/** Reason reused for metrics that require a real harness run. */
export const HARNESS_METRIC_UNAVAILABLE_NOTE =
  'This metric requires a real coding-harness run; it is unavailable for synthetic fixtures.';

/** Create a measurement backed by a direct observation. */
export function measured<T>(value: T): AvailableMeasurement<T> {
  return { evidence: 'measured', value };
}

/** Create a measurement that is explicitly an estimate. */
export function estimated<T>(value: T): AvailableMeasurement<T> {
  return { evidence: 'estimated', value };
}

/** Create a measurement supported by a controlled benchmark comparison. */
export function benchmarkVerified<T>(value: T): AvailableMeasurement<T> {
  return { evidence: 'benchmark-verified', value };
}

/** Create an unavailable measurement with the reason it could not be obtained. */
export function unavailable(note: string): UnavailableMeasurement {
  return { evidence: 'unavailable', note };
}

/** Narrow a measurement to its available form. */
export function isAvailable<T>(measurement: Measurement<T>): measurement is AvailableMeasurement<T> {
  return measurement.evidence !== 'unavailable';
}

/** Metric names whose values must be whole, non-negative numbers. */
export const INTEGER_METRICS: readonly MetricName[] = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'toolCalls',
  'repeatedFileReads',
  'recoveryAttempts',
  'optimizerErrors',
];

/** Every recorded metric name. */
export const ALL_METRICS: readonly MetricName[] = [...INTEGER_METRICS, 'durationMs'];

/**
 * Validate available metric values.
 *
 * Returns human-readable problems (never fixture content). Comparisons refuse
 * to reason about runs whose measurements are invalid.
 */
export function findInvalidMetricValues(metrics: RunMetrics): readonly string[] {
  const problems: string[] = [];
  for (const name of ALL_METRICS) {
    const metric = metrics[name];
    if (!isAvailable(metric)) {
      continue;
    }
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value) || metric.value < 0) {
      problems.push(
        `${name} must be a finite, non-negative number but was ${String(metric.value)}.`,
      );
      continue;
    }
    if (INTEGER_METRICS.includes(name) && !Number.isInteger(metric.value)) {
      problems.push(`${name} must be a whole number but was ${metric.value}.`);
    }
  }
  return problems;
}

/** Summarize the evidence class of every metric in a run. */
export function summarizeMetricEvidence(
  metrics: RunMetrics,
): Readonly<Record<MetricName, MeasurementEvidenceClass>> {
  return {
    inputTokens: metrics.inputTokens.evidence,
    outputTokens: metrics.outputTokens.evidence,
    totalTokens: metrics.totalTokens.evidence,
    toolCalls: metrics.toolCalls.evidence,
    repeatedFileReads: metrics.repeatedFileReads.evidence,
    durationMs: metrics.durationMs.evidence,
    recoveryAttempts: metrics.recoveryAttempts.evidence,
    optimizerErrors: metrics.optimizerErrors.evidence,
  };
}
