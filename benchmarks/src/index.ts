/**
 * Public API of the Dr. Token benchmark foundation (Stage 1B).
 *
 * The framework records deterministic pass-through runs over synthetic
 * fixtures, checks context preservation, and compares baseline with candidate
 * runs. Token usage is reported as unavailable because no real coding harness
 * has been executed yet.
 */
export { runBenchmarkSuite } from './benchmark.js';
export type { BenchmarkSuiteOptions, BenchmarkSuiteResult } from './benchmark.js';
export { compareRuns } from './comparison.js';
export { DEFAULT_FIXTURES_DIR, FixtureValidationError, loadFixtures, validateFixture } from './fixtures.js';
export {
  ALL_METRICS,
  HARNESS_METRIC_UNAVAILABLE_NOTE,
  INTEGER_METRICS,
  TOKENS_UNAVAILABLE_NOTE,
  benchmarkVerified,
  estimated,
  findInvalidMetricValues,
  isAvailable,
  measured,
  summarizeMetricEvidence,
  unavailable,
} from './measurement.js';
export {
  DR_TOKEN_BENCHMARKS_VERSION,
  DR_TOKEN_CORE_VERSION,
  SYNTHETIC_HARNESS_ID,
  createConfigurationId,
  createProvenance,
} from './provenance.js';
export {
  BENCHMARK_DISCLAIMER,
  DEFAULT_REPORT_PATH,
  buildReport,
  writeReport,
} from './report.js';
export {
  DEFAULT_OPTIMIZER_CONFIGURATION,
  hashContext,
  runFixture,
} from './runner.js';
export type { BenchmarkRunOptions, ContextOptimizer } from './runner.js';
export { BENCHMARK_SCHEMA_VERSION } from './types.js';
export type {
  AvailableMeasurement,
  BenchmarkFixture,
  BenchmarkProvenance,
  BenchmarkReport,
  BenchmarkRunRecord,
  BenchmarkRunRole,
  BenchmarkSummary,
  ComparisonResult,
  ComparisonVerdict,
  CorrectnessCheck,
  CorrectnessOutcome,
  FixtureCategory,
  Measurement,
  MeasurementEvidenceClass,
  MetricName,
  OptimizationDecisionSummary,
  RequiredContent,
  RunMetrics,
  UnavailableMeasurement,
} from './types.js';
