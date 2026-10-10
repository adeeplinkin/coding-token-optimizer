import type { OptimizationMode } from '@dr-token/core';
import { measured, unavailable } from './measurement.js';
import type {
  BenchmarkProvenance,
  BenchmarkRunRole,
  MeasurementEvidenceClass,
  MetricName,
} from './types.js';

/**
 * Version of `@dr-token/core` exercised by the benchmarks.
 *
 * A test asserts this stays in sync with `packages/core/package.json`, so the
 * recorded revision cannot silently drift from the code under test.
 */
export const DR_TOKEN_CORE_VERSION = '0.0.0';

/** Version of the benchmarks package itself, kept in sync by a test. */
export const DR_TOKEN_BENCHMARKS_VERSION = '0.0.0';

/**
 * Harness identifier used for synthetic fixtures.
 *
 * Synthetic runs must not claim to have run a real harness such as OpenCode.
 */
export const SYNTHETIC_HARNESS_ID = 'synthetic-fixture';

/** Inputs used to build provenance for one run. */
export interface ProvenanceInput {
  readonly fixtureId: string;
  readonly role: BenchmarkRunRole;
  readonly mode: OptimizationMode;
  readonly harness: string;
  readonly model?: string;
  readonly optimizerRevision: string;
  readonly optimizerConfiguration: string;
  readonly repositoryRevision?: string;
  readonly recordedAt: Date;
  readonly measurementEvidence: Readonly<Record<MetricName, MeasurementEvidenceClass>>;
}

/** Stable identifier for an execution configuration. */
export function createConfigurationId(input: {
  readonly harness: string;
  readonly optimizerRevision: string;
  readonly mode: OptimizationMode;
  readonly optimizerConfiguration: string;
}): string {
  return [input.harness, input.optimizerRevision, input.mode, input.optimizerConfiguration].join('|');
}

/**
 * Build provenance for a run.
 *
 * Values that were not supplied are recorded as `unavailable` rather than
 * guessed, so comparisons can detect missing or mismatched provenance.
 */
export function createProvenance(input: ProvenanceInput): BenchmarkProvenance {
  return {
    fixtureId: input.fixtureId,
    role: input.role,
    mode: input.mode,
    harness: input.harness,
    model:
      input.model === undefined
        ? unavailable('No model identifier was supplied; synthetic fixture runs do not use a model.')
        : measured(input.model),
    optimizerRevision: input.optimizerRevision,
    optimizerConfiguration: input.optimizerConfiguration,
    repositoryRevision:
      input.repositoryRevision === undefined
        ? unavailable('No repository revision was supplied to the benchmark runner.')
        : measured(input.repositoryRevision),
    configurationId: createConfigurationId({
      harness: input.harness,
      optimizerRevision: input.optimizerRevision,
      mode: input.mode,
      optimizerConfiguration: input.optimizerConfiguration,
    }),
    recordedAt: input.recordedAt.toISOString(),
    measurementEvidence: input.measurementEvidence,
  };
}
