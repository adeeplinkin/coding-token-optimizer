#!/usr/bin/env node
import process from 'node:process';
import type { OptimizationMode } from '@dr-token/core';
import { runBenchmarkSuite } from './benchmark.js';
import { isAvailable } from './measurement.js';
import { BENCHMARK_DISCLAIMER, DEFAULT_REPORT_PATH, writeReport } from './report.js';
import type { Measurement } from './types.js';

const MODES: readonly OptimizationMode[] = ['safe', 'aggressive', 'balanced'];

const USAGE = `Dr. Token benchmark runner

Usage: npm run benchmark -- [options]

Options:
  --fixtures <dir>   Fixture directory (default: benchmarks/fixtures)
  --out <file>       Report output file (default: benchmarks/reports/benchmark-report.json)
  --mode <mode>      Optimization mode identifier: safe | aggressive | balanced (default: safe)
  --help             Show this help

Exit codes: 0 = all correctness checks passed, 1 = at least one correctness check failed,
2 = the benchmark could not be executed.`;

interface RunArguments {
  readonly kind: 'run';
  readonly fixturesDir?: string;
  readonly outFile: string;
  readonly mode: OptimizationMode;
}

interface HelpArguments {
  readonly kind: 'help';
}

type ParsedArguments = RunArguments | HelpArguments;

function parseArguments(argv: readonly string[]): ParsedArguments {
  let fixturesDir: string | undefined;
  let outFile = DEFAULT_REPORT_PATH;
  let mode: OptimizationMode = 'safe';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      return { kind: 'help' };
    }
    if (argument === '--fixtures' || argument === '--out' || argument === '--mode') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option ${argument} requires a value.`);
      }
      index += 1;
      if (argument === '--fixtures') {
        fixturesDir = value;
      } else if (argument === '--out') {
        outFile = value;
      } else {
        if (!MODES.includes(value as OptimizationMode)) {
          throw new Error(`Unknown mode "${value}". Expected one of: ${MODES.join(', ')}.`);
        }
        mode = value as OptimizationMode;
      }
      continue;
    }
    throw new Error(`Unknown argument "${argument}".`);
  }

  return {
    kind: 'run',
    outFile,
    mode,
    ...(fixturesDir === undefined ? {} : { fixturesDir }),
  };
}

function numberOrUnavailable(measurement: Measurement<number>): string {
  return isAvailable(measurement) ? String(Math.round(measurement.value * 100) / 100) : 'unavailable';
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

async function main(): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`benchmark: ${errorMessage(error)}`);
    console.error('');
    console.error(USAGE);
    return 2;
  }

  if (parsed.kind === 'help') {
    console.log(USAGE);
    return 0;
  }

  const { report, correctnessFailed } = await runBenchmarkSuite({
    mode: parsed.mode,
    ...(parsed.fixturesDir === undefined ? {} : { fixturesDir: parsed.fixturesDir }),
  });

  console.log(`Dr. Token benchmarks — ${report.summary.fixtures} fixture(s), mode: ${parsed.mode}`);
  console.log('');

  for (const run of report.runs.filter((record) => record.role === 'baseline')) {
    const candidate = report.runs.find(
      (record) => record.role === 'candidate' && record.fixtureId === run.fixtureId,
    );
    const comparisonResult = report.comparisons.find((item) => item.fixtureId === run.fixtureId);
    const correctness = candidate === undefined
      ? run.correctness.passed
      : run.correctness.passed && candidate.correctness.passed;

    console.log(
      [
        correctness ? 'OK  ' : 'FAIL',
        run.fixtureId.padEnd(30),
        `[${run.fixtureCategory}]`,
        `preserved=${run.contextPreservedExactly}`,
        `tokens=${numberOrUnavailable(run.metrics.totalTokens)}`,
        `durationMs=${numberOrUnavailable(run.metrics.durationMs)}`,
        `optimizerErrors=${numberOrUnavailable(run.metrics.optimizerErrors)}`,
        `verdict=${comparisonResult?.verdict ?? 'none'}`,
      ].join(' '),
    );
  }

  console.log('');
  console.log(
    `Correctness: ${report.summary.correctnessPassed} passed, ${report.summary.correctnessFailed} failed`,
  );
  console.log(
    `Verdicts: ${Object.entries(report.summary.verdicts)
      .map(([verdict, count]) => `${verdict}=${count}`)
      .join(' ')}`,
  );
  console.log(
    `Unavailable metrics: ${report.summary.unavailableMetrics.join(', ') || 'none'}`,
  );
  console.log('');
  console.log(BENCHMARK_DISCLAIMER);

  const written = await writeReport(report, parsed.outFile);
  console.log(`Report written to ${written}`);

  return correctnessFailed ? 1 : 0;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(`benchmark: ${errorMessage(error)}`);
    process.exitCode = 2;
  });
