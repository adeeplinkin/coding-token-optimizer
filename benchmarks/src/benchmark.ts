import { OptimizerEngine } from '@dr-token/core';
import type { OptimizationMode } from '@dr-token/core';
import { compareRuns } from './comparison.js';
import { loadFixtures } from './fixtures.js';
import { DR_TOKEN_BENCHMARKS_VERSION } from './provenance.js';
import { buildReport } from './report.js';
import {
  DEFAULT_OPTIMIZER_CONFIGURATION,
  runFixture,
  type BenchmarkRunOptions,
  type ContextOptimizer,
} from './runner.js';
import type {
  BenchmarkFixture,
  BenchmarkReport,
  BenchmarkRunRecord,
  BenchmarkRunRole,
  ComparisonResult,
} from './types.js';

/** Options for a full benchmark suite run. */
export interface BenchmarkSuiteOptions {
  readonly fixturesDir?: string;
  readonly mode?: OptimizationMode;
  /** Optimizer used for baseline runs. Defaults to a pass-through engine. */
  readonly baselineOptimizer?: ContextOptimizer;
  /** Optimizer used for candidate runs. Defaults to a pass-through engine. */
  readonly candidateOptimizer?: ContextOptimizer;
  readonly baselineConfiguration?: string;
  readonly candidateConfiguration?: string;
  readonly harness?: string;
  readonly model?: string;
  readonly optimizerRevision?: string;
  readonly repositoryRevision?: string;
  /** Injectable clock, used so reports can be reproduced deterministically in tests. */
  readonly now?: () => Date;
}

/** Outcome of a benchmark suite run. */
export interface BenchmarkSuiteResult {
  readonly report: BenchmarkReport;
  readonly fixtures: readonly BenchmarkFixture[];
  /** True when at least one recorded run failed a correctness check. */
  readonly correctnessFailed: boolean;
}

/**
 * Run every fixture twice: once as the baseline and once as the candidate, then
 * compare each pair.
 *
 * Stage 1B ships no optimization passes, so both runs use the same pass-through
 * configuration. The comparison therefore reports `unavailable` for token
 * savings, which is the honest result until real passes and real harness
 * measurements exist.
 */
export async function runBenchmarkSuite(
  options: BenchmarkSuiteOptions = {},
): Promise<BenchmarkSuiteResult> {
  const fixtures = await loadFixtures(options.fixturesDir);
  const mode = options.mode ?? 'safe';
  const clock = options.now ?? ((): Date => new Date());

  // The default optimizer is a pass-through engine with no registered passes.
  // Baselines are never weakened to make a future optimization look better.
  const defaultOptimizer = new OptimizerEngine();

  const runOptionsFor = (role: BenchmarkRunRole): BenchmarkRunOptions => {
    const optimizer =
      (role === 'baseline' ? options.baselineOptimizer : options.candidateOptimizer) ??
      defaultOptimizer;
    const optimizerConfiguration =
      (role === 'baseline' ? options.baselineConfiguration : options.candidateConfiguration) ??
      DEFAULT_OPTIMIZER_CONFIGURATION;

    return {
      role,
      mode,
      optimizer,
      optimizerConfiguration,
      now: clock,
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.optimizerRevision === undefined
        ? {}
        : { optimizerRevision: options.optimizerRevision }),
      ...(options.repositoryRevision === undefined
        ? {}
        : { repositoryRevision: options.repositoryRevision }),
    };
  };

  const runs: BenchmarkRunRecord[] = [];
  const comparisons: ComparisonResult[] = [];

  for (const fixture of fixtures) {
    const baseline = await runFixture(fixture, runOptionsFor('baseline'));
    const candidate = await runFixture(fixture, runOptionsFor('candidate'));
    runs.push(baseline, candidate);
    comparisons.push(compareRuns(baseline, candidate));
  }

  const report = buildReport({
    runs,
    comparisons,
    generatedAt: clock(),
    version: DR_TOKEN_BENCHMARKS_VERSION,
  });

  return {
    report,
    fixtures,
    correctnessFailed: runs.some((run) => !run.correctness.passed),
  };
}
