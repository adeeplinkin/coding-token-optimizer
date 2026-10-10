import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkReport,
  type BenchmarkRunRecord,
  type BenchmarkSummary,
  type ComparisonResult,
  type ComparisonVerdict,
} from './types.js';
import { ALL_METRICS, isAvailable } from './measurement.js';

/**
 * Plain-language statement attached to every report.
 *
 * Stage 1B runs synthetic fixtures through a pass-through engine, so a report
 * must never be read as evidence of real-world token savings.
 */
export const BENCHMARK_DISCLAIMER =
  'Synthetic fixtures exercise the benchmark infrastructure and context-preservation behavior only. ' +
  'No real coding harness was executed and no token usage was measured, so this report contains no ' +
  'evidence that Dr. Token reduces real-world token consumption.';

/** Default report location, resolved for both `src` and `dist` builds. */
export const DEFAULT_REPORT_PATH = fileURLToPath(
  new URL('../reports/benchmark-report.json', import.meta.url),
);

/** Inputs required to build a report. */
export interface ReportInput {
  readonly runs: readonly BenchmarkRunRecord[];
  readonly comparisons: readonly ComparisonResult[];
  readonly generatedAt: Date;
  readonly version: string;
}

/** Build a structured report from recorded runs and comparisons. */
export function buildReport(input: ReportInput): BenchmarkReport {
  const runsTotal = input.runs.length;
  const correctnessPassed = input.runs.filter((run) => run.correctness.passed).length;

  const verdicts: Record<ComparisonVerdict, number> = {
    'benchmark-verified': 0,
    'no-change': 0,
    regression: 0,
    invalid: 0,
    unavailable: 0,
  };
  for (const comparisonResult of input.comparisons) {
    verdicts[comparisonResult.verdict] += 1;
  }

  const unavailableMetrics = ALL_METRICS.filter((name) =>
    input.runs.every((run) => !isAvailable(run.metrics[name])),
  );

  const summary: BenchmarkSummary = {
    fixtures: new Set(input.runs.map((run) => run.fixtureId)).size,
    runsTotal,
    correctnessPassed,
    correctnessFailed: runsTotal - correctnessPassed,
    verdicts,
    unavailableMetrics,
  };

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    tool: { name: 'dr-token-benchmarks', version: input.version },
    disclaimer: BENCHMARK_DISCLAIMER,
    runs: input.runs,
    comparisons: input.comparisons,
    summary,
  };
}

/** Write a report as pretty-printed JSON, creating parent directories. */
export async function writeReport(report: BenchmarkReport, filePath?: string): Promise<string> {
  const target = filePath ?? DEFAULT_REPORT_PATH;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return target;
}
