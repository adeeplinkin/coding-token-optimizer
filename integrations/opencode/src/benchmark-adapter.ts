import type { ObservationMeasurement, SessionObservationSummary } from './types.js';

/**
 * Bridge between observation summaries and the Stage 1B benchmark measurement
 * model (`benchmarks/src/types.ts`).
 *
 * This module deliberately does **not** import `@dr-token/benchmarks`: that
 * package is Node-only (it reads the filesystem and uses `node:crypto`) and the
 * OpenCode plugin must never pull it in. Instead the shapes below mirror the
 * Stage 1B ones exactly, and `tests/benchmark-integration.test.ts` asserts the
 * mirror with a compile-time assignment to the real `RunMetrics` type, so drift
 * breaks `npm run typecheck`.
 *
 * Mapping rules (see `docs/OPENCODE_OBSERVER.md`):
 *
 * | Observation evidence | Stage 1B evidence | Why |
 * | --- | --- | --- |
 * | `measured`    | `measured`    | a direct reading; the classes agree |
 * | `calculated`  | `unavailable` | Stage 1B has no class for a derived value. Its `measured` means "obtained from an actual observation", which an aggregate is not, and its `estimated` means "calculated indirectly and explicitly labelled as an estimate", which an aggregate of real measurements is not either. Mislabelling it as `measured` would overstate provenance, so the adapter reports `unavailable` |
 * | `estimated`   | `estimated`   | representable as published |
 * | `unavailable` | `unavailable` | the classes agree |
 *
 * The observer never emits `benchmark-verified`: that class requires a valid
 * controlled baseline/candidate comparison, which this adapter does not run.
 *
 * Only `toolCalls` is a directly measured value in the mapping below. Every
 * aggregate the observer produces (`repeatedFileReads`, the per-field token sums)
 * is reported as `unavailable`, and its value stays available in the observation
 * summary, which keeps the original `calculated` classification.
 */

/** Harness identifier to record when a real OpenCode run is wired up later. */
export const OPENCODE_HARNESS_ID = 'opencode';

/** Reason used for metrics the observer does not own. */
export const HARNESS_OWNED_METRIC_NOTE =
  'This metric belongs to the coding-harness run (timing, recovery attempts and optimizer errors); the OpenCode observer does not produce it.';

/**
 * Reason used when a derived aggregate cannot be represented faithfully.
 *
 * The note carries no number on purpose: an `unavailable` measurement must never
 * smuggle a value, so the aggregate stays in the observation summary instead.
 */
export const CALCULATED_NOT_REPRESENTABLE_NOTE =
  'This observation is a calculated aggregate derived from measurements. The Stage 1B evidence classes cannot represent a derived value, so it is reported as unavailable rather than mislabelled as a direct measurement. The aggregate itself remains in the observation summary.';

export type HarnessMeasurementEvidenceClass =
  | 'measured'
  | 'estimated'
  | 'benchmark-verified'
  | 'unavailable';

export interface HarnessAvailableMeasurement<T> {
  readonly evidence: 'measured' | 'estimated' | 'benchmark-verified';
  readonly value: T;
}

export interface HarnessUnavailableMeasurement {
  readonly evidence: 'unavailable';
  readonly note: string;
}

/** Mirror of the Stage 1B `Measurement<T>` union. */
export type HarnessMeasurement<T> = HarnessAvailableMeasurement<T> | HarnessUnavailableMeasurement;

/**
 * Mirror of the Stage 1B `RunMetrics` shape, populated from one observation
 * summary.
 */
export interface ObservedRunMetrics {
  readonly inputTokens: HarnessMeasurement<number>;
  readonly outputTokens: HarnessMeasurement<number>;
  readonly totalTokens: HarnessMeasurement<number>;
  readonly toolCalls: HarnessMeasurement<number>;
  readonly repeatedFileReads: HarnessMeasurement<number>;
  readonly durationMs: HarnessMeasurement<number>;
  readonly recoveryAttempts: HarnessMeasurement<number>;
  readonly optimizerErrors: HarnessMeasurement<number>;
}

/**
 * The Stage 1B evidence class that faithfully represents an observation
 * measurement.
 *
 * Exported so the mapping rule is testable on its own, rather than only through
 * a fully built metrics object.
 */
export function toHarnessEvidence(
  evidence: ObservationMeasurement<number>['evidence'],
): HarnessMeasurementEvidenceClass {
  switch (evidence) {
    case 'measured':
      return 'measured';
    case 'estimated':
      return 'estimated';
    case 'calculated':
      // Not representable: a derived value must not be dressed up as a direct
      // measurement, and it is not an estimate either.
      return 'unavailable';
    case 'unavailable':
      return 'unavailable';
  }
}

/**
 * Convert one observation measurement into the Stage 1B evidence vocabulary.
 *
 * A derived aggregate becomes `unavailable` with an explanatory note; its value
 * is not carried across, because an `unavailable` measurement never holds one.
 */
export function toHarnessMeasurement(
  measurement: ObservationMeasurement<number>,
): HarnessMeasurement<number> {
  switch (measurement.evidence) {
    case 'unavailable':
      return { evidence: 'unavailable', note: measurement.note };
    case 'measured':
      return { evidence: 'measured', value: measurement.value };
    case 'estimated':
      return { evidence: 'estimated', value: measurement.value };
    case 'calculated':
      return { evidence: 'unavailable', note: CALCULATED_NOT_REPRESENTABLE_NOTE };
  }
}

/**
 * Build Stage 1B-compatible metrics from one observation summary.
 *
 * `toolCalls` uses observed **completions**, the one directly measured metric in
 * this mapping. `repeatedFileReads` and the token fields are derived aggregates
 * and are therefore reported as `unavailable`. None of these values is evidence
 * of an optimization result: they describe what the agent did.
 */
export function toObservedRunMetrics(summary: SessionObservationSummary): ObservedRunMetrics {
  return {
    inputTokens: toHarnessMeasurement(summary.measurements.inputTokens),
    outputTokens: toHarnessMeasurement(summary.measurements.outputTokens),
    totalTokens: toHarnessMeasurement(summary.measurements.totalTokens),
    toolCalls: toHarnessMeasurement(summary.measurements.toolCompletionsObserved),
    repeatedFileReads: toHarnessMeasurement(summary.measurements.repeatedFileReads),
    durationMs: { evidence: 'unavailable', note: HARNESS_OWNED_METRIC_NOTE },
    recoveryAttempts: { evidence: 'unavailable', note: HARNESS_OWNED_METRIC_NOTE },
    optimizerErrors: { evidence: 'unavailable', note: HARNESS_OWNED_METRIC_NOTE },
  };
}
