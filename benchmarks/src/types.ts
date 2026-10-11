/**
 * Benchmark data model for Dr. Token.
 *
 * Stage 1B measures the benchmark infrastructure and context preservation.
 * Real coding-harness token usage is not observable yet, so token metrics are
 * reported as `unavailable` rather than estimated or invented.
 */
import type {
  EvidenceClass,
  OptimizationDecisionAction,
  OptimizationMode,
} from '@dr-token/core';

/** Version of the benchmark report schema. */
export const BENCHMARK_SCHEMA_VERSION = 1;

/** Category of a synthetic benchmark fixture. */
export type FixtureCategory =
  | 'empty-context'
  | 'ordinary-text'
  | 'source-code'
  | 'whitespace'
  | 'unicode'
  | 'repeated-information'
  | 'error-message'
  | 'instructions';

/** A piece of content that must survive optimization, identified by a safe label. */
export interface RequiredContent {
  /** Short label used in reports instead of the content itself. */
  readonly label: string;
  /** Exact text that must still be present in the optimized context. */
  readonly text: string;
}

/** A typed, deterministic benchmark fixture loaded from `benchmarks/fixtures`. */
export interface BenchmarkFixture {
  /** Stable identifier; must match the fixture file name without the extension. */
  readonly id: string;
  /** Short human-readable description of what the fixture covers. */
  readonly description: string;
  readonly category: FixtureCategory;
  /** The exact context handed to the optimizer. */
  readonly context: string;
  /** True when the output must be identical to the input. */
  readonly expectExactPreservation: boolean;
  readonly requiredContent: readonly RequiredContent[];
}

/** Whether a recorded run is the baseline or the candidate. */
export type BenchmarkRunRole = 'baseline' | 'candidate';

/**
 * The only axis a declared controlled comparison may move (Stage 1S).
 *
 * A control arm and a treatment arm necessarily record different optimizer
 * configurations; every other comparability fact must stay identical. No other
 * axis is permitted, so an undeclared difference is still rejected.
 */
export type OptimizationVariantAxis = 'optimizer-configuration';

/** One arm of a declared controlled comparison. */
export interface DeclaredVariantArm {
  /** Explicit optimization variant identifier, e.g. `control` or `safe-mode-v1`. */
  readonly variantId: string;
  /**
   * Role this arm must be recorded with. The control arm is always the
   * `baseline` and the treatment arm is always the `candidate`, so a swapped
   * declaration is a malformed declaration rather than a silent A/B flip.
   */
  readonly role: BenchmarkRunRole;
  /** Optimizer configuration string this arm must record in provenance. */
  readonly optimizerConfiguration: string;
}

/**
 * A declared controlled comparison: a named experiment with exactly one
 * permitted optimization difference between its two arms.
 *
 * Declaring the experiment is what makes a baseline/candidate pair comparable;
 * it never widens the comparison guard by itself, because the recorded
 * provenance of both arms is re-verified independently in `compareRuns`.
 */
export interface DeclaredVariant {
  /** Stable identifier of the whole declared experiment, shared by both arms. */
  readonly declarationId: string;
  /** The single axis permitted to differ between the two arms. */
  readonly axis: OptimizationVariantAxis;
  /** The control arm: the exact optimization setting without the treatment. */
  readonly control: DeclaredVariantArm;
  /** The treatment arm: the control setting plus the declared optimization. */
  readonly treatment: DeclaredVariantArm;
}

/**
 * Recorded identity of the declared arm a run belongs to.
 *
 * Present only when the run was produced by a declared controlled comparison;
 * its absence keeps a run in the original strict (undeclared) comparison path.
 */
export interface VariantProvenance {
  /** Declared experiment identifier, shared by both arms. */
  readonly declarationId: string;
  /** This arm's explicit optimization variant identifier. */
  readonly variantId: string;
  /** The axis declared to differ between the arms. */
  readonly axis: OptimizationVariantAxis;
  /** This arm's declared role. */
  readonly role: BenchmarkRunRole;
}

/** One arm as summarized in a report. */
export interface DeclaredVariantArmSummary {
  readonly variantId: string;
  readonly role: BenchmarkRunRole;
  readonly optimizerConfiguration: string;
}

/** A declared controlled comparison, restated in the report artifact. */
export interface ControlledVariantSummary {
  readonly declarationId: string;
  readonly axis: OptimizationVariantAxis;
  readonly arms: readonly DeclaredVariantArmSummary[];
}

/**
 * Evidence classification for a single measurement.
 *
 * These classes are not interchangeable: `benchmark-verified` requires a valid
 * controlled comparison, and `unavailable` means no reliable measurement
 * exists (values must never be invented to fill the gap).
 */
export type MeasurementEvidenceClass =
  | 'measured'
  | 'estimated'
  | 'benchmark-verified'
  | 'unavailable';

/** A measurement backed by an actual observation. */
export interface AvailableMeasurement<T> {
  readonly evidence: 'measured' | 'estimated' | 'benchmark-verified';
  readonly value: T;
}

/** A measurement that could not be obtained, together with the reason. */
export interface UnavailableMeasurement {
  readonly evidence: 'unavailable';
  readonly note: string;
}

/** A metric value that always carries its evidence classification. */
export type Measurement<T> = AvailableMeasurement<T> | UnavailableMeasurement;

/** Metric names recorded for every run. */
export type MetricName =
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'toolCalls'
  | 'repeatedFileReads'
  | 'durationMs'
  | 'recoveryAttempts'
  | 'optimizerErrors';

/** Metrics captured for a single run. */
export interface RunMetrics {
  readonly inputTokens: Measurement<number>;
  readonly outputTokens: Measurement<number>;
  readonly totalTokens: Measurement<number>;
  readonly toolCalls: Measurement<number>;
  readonly repeatedFileReads: Measurement<number>;
  readonly durationMs: Measurement<number>;
  readonly recoveryAttempts: Measurement<number>;
  readonly optimizerErrors: Measurement<number>;
}

/** Provenance metadata needed to decide whether two runs are comparable. */
export interface BenchmarkProvenance {
  readonly fixtureId: string;
  readonly role: BenchmarkRunRole;
  readonly mode: OptimizationMode;
  /** Harness identifier; synthetic fixtures report `synthetic-fixture`. */
  readonly harness: string;
  /** Model identifier, or `unavailable` when no model was involved. */
  readonly model: Measurement<string>;
  /** Optimizer version or revision exercised by the run. */
  readonly optimizerRevision: string;
  /** Description of the optimizer configuration (pass pipeline). */
  readonly optimizerConfiguration: string;
  /** Repository revision, or `unavailable` when it was not supplied. */
  readonly repositoryRevision: Measurement<string>;
  /** Stable identifier combining harness, revision, mode and configuration. */
  readonly configurationId: string;
  /**
   * Declared controlled-comparison arm, or absent for an undeclared run.
   *
   * When present on both arms, the pair is a *declared* comparison and the one
   * permitted optimization difference is validated against this declaration.
   * When absent, the original `configurationId` equality guard applies unchanged.
   */
  readonly variant?: VariantProvenance;
  /** ISO timestamp for when the run was recorded. */
  readonly recordedAt: string;
  /** Evidence class of every metric in this run. */
  readonly measurementEvidence: Readonly<Record<MetricName, MeasurementEvidenceClass>>;
}

/** One correctness check performed on a run. */
export interface CorrectnessCheck {
  readonly name: string;
  readonly passed: boolean;
  /** Explanation that never contains fixture content. */
  readonly detail: string;
}

/** Aggregate correctness outcome for a run. */
export interface CorrectnessOutcome {
  readonly passed: boolean;
  readonly checks: readonly CorrectnessCheck[];
}

/** A decision recorded by the optimizer, reduced to content-free fields. */
export interface OptimizationDecisionSummary {
  readonly passId: string;
  readonly action: OptimizationDecisionAction;
  readonly evidence: EvidenceClass;
}

/** A single recorded benchmark run. Fixture content is never stored here. */
export interface BenchmarkRunRecord {
  readonly runId: string;
  readonly role: BenchmarkRunRole;
  readonly fixtureId: string;
  readonly fixtureCategory: FixtureCategory;
  /** SHA-256 of the input context. */
  readonly inputHash: string;
  /** SHA-256 of the output context. */
  readonly outputHash: string;
  readonly inputLength: number;
  readonly outputLength: number;
  readonly contextPreservedExactly: boolean;
  readonly correctness: CorrectnessOutcome;
  readonly metrics: RunMetrics;
  readonly provenance: BenchmarkProvenance;
  readonly optimizerDecisions: readonly OptimizationDecisionSummary[];
}

/** Outcome of comparing a baseline run with a candidate run. */
export type ComparisonVerdict =
  /** Candidate used fewer tokens and passed all correctness checks. */
  | 'benchmark-verified'
  /** No measurable token difference. */
  | 'no-change'
  /** Candidate used more tokens, or failed a correctness check. */
  | 'regression'
  /** The runs cannot be compared (mismatched identity/provenance or invalid data). */
  | 'invalid'
  /** The comparison is valid but the required measurements do not exist. */
  | 'unavailable';

/** Result of comparing one baseline/candidate pair. */
export interface ComparisonResult {
  readonly fixtureId: string;
  readonly verdict: ComparisonVerdict;
  /** Explanation that never contains fixture content. */
  readonly reason: string;
  /** True when the candidate failed a correctness check the baseline passed. */
  readonly correctnessRegression: boolean;
  readonly tokenDelta: Measurement<number>;
  readonly tokenDeltaPercent: Measurement<number>;
  readonly notes: readonly string[];
}

/** Aggregate counts for a report. */
export interface BenchmarkSummary {
  readonly fixtures: number;
  readonly runsTotal: number;
  readonly correctnessPassed: number;
  readonly correctnessFailed: number;
  readonly verdicts: Readonly<Record<ComparisonVerdict, number>>;
  /** Metrics that were unavailable for every recorded run. */
  readonly unavailableMetrics: readonly MetricName[];
}

/** The structured JSON report produced by a benchmark run. */
export interface BenchmarkReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly tool: {
    readonly name: 'dr-token-benchmarks';
    readonly version: string;
  };
  /** States plainly what the report does and does not establish. */
  readonly disclaimer: string;
  readonly runs: readonly BenchmarkRunRecord[];
  readonly comparisons: readonly ComparisonResult[];
  readonly summary: BenchmarkSummary;
  /**
   * Declared controlled comparisons restated explicitly, derived from run
   * provenance. Omitted entirely when no run declares a variant, so a report
   * from the undeclared path stays byte-identical to the Stage 1B schema.
   */
  readonly controlledVariants?: readonly ControlledVariantSummary[];
}
