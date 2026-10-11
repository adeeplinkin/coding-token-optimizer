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
  type ControlledVariantSummary,
  type DeclaredVariantArmSummary,
  type OptimizationVariantAxis,
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

  const controlledVariants = summarizeControlledVariants(input.runs);

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    tool: { name: 'dr-token-benchmarks', version: input.version },
    disclaimer: BENCHMARK_DISCLAIMER,
    runs: input.runs,
    comparisons: input.comparisons,
    summary,
    // Omitted (rather than empty) when nothing was declared, so a report from
    // the undeclared path is unchanged from the Stage 1B schema.
    ...(controlledVariants.length === 0 ? {} : { controlledVariants }),
  };
}

/** A declared experiment as it is being collected from run provenance. */
interface ControlledVariantBuild {
  readonly axis: OptimizationVariantAxis;
  readonly arms: Map<string, DeclaredVariantArmSummary>;
}

/**
 * Restate every declared controlled comparison found in the recorded runs.
 *
 * The declaration is derived from run provenance rather than passed in, so the
 * report states the experiment it was actually produced with. Identical arms
 * repeated across fixtures collapse into one entry, and output is sorted, so
 * two reports for the same declaration are byte-identical.
 */
function summarizeControlledVariants(
  runs: readonly BenchmarkRunRecord[],
): readonly ControlledVariantSummary[] {
  const builds = new Map<string, ControlledVariantBuild>();

  for (const run of runs) {
    const variant = run.provenance.variant;
    if (variant === undefined) {
      continue;
    }
    const build = builds.get(variant.declarationId) ?? {
      axis: variant.axis,
      arms: new Map<string, DeclaredVariantArmSummary>(),
    };
    const arm: DeclaredVariantArmSummary = {
      variantId: variant.variantId,
      role: variant.role,
      optimizerConfiguration: run.provenance.optimizerConfiguration,
    };
    build.arms.set(`${arm.role}|${arm.variantId}|${arm.optimizerConfiguration}`, arm);
    builds.set(variant.declarationId, build);
  }

  return [...builds.entries()]
    .map(([declarationId, build]) => ({
      declarationId,
      axis: build.axis,
      arms: [...build.arms.values()].sort(compareArms),
    }))
    .sort((left, right) => compareStrings(left.declarationId, right.declarationId));
}

function compareArms(left: DeclaredVariantArmSummary, right: DeclaredVariantArmSummary): number {
  return (
    compareStrings(left.role, right.role) ||
    compareStrings(left.variantId, right.variantId) ||
    compareStrings(left.optimizerConfiguration, right.optimizerConfiguration)
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Write a report as pretty-printed JSON, creating parent directories. */
export async function writeReport(report: BenchmarkReport, filePath?: string): Promise<string> {
  const target = filePath ?? DEFAULT_REPORT_PATH;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return target;
}
