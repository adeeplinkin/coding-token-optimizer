import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BENCHMARK_DISCLAIMER,
  BENCHMARK_SCHEMA_VERSION,
  buildReport,
  runBenchmarkSuite,
  writeReport,
} from '../src/index.js';
import { createTempDir, removeDir } from './helpers.js';

const FIXED_NOW = new Date('2026-10-10T00:00:00.000Z');

const suite = await runBenchmarkSuite({ now: () => FIXED_NOW });

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await createTempDir();
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => removeDir(directory)));
});

describe('buildReport', () => {
  it('produces a versioned report with a disclaimer', () => {
    const { report } = suite;

    expect(report.schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
    expect(report.tool.name).toBe('dr-token-benchmarks');
    expect(report.tool.version).toBe('0.0.0');
    expect(report.generatedAt).toBe(FIXED_NOW.toISOString());
    expect(report.disclaimer).toBe(BENCHMARK_DISCLAIMER);
  });

  it('records one baseline and one candidate run per fixture', () => {
    const { report, fixtures } = suite;

    expect(report.runs).toHaveLength(fixtures.length * 2);
    expect(new Set(report.runs.map((run) => run.runId)).size).toBe(report.runs.length);
    expect(report.runs.filter((run) => run.role === 'baseline')).toHaveLength(fixtures.length);
    expect(report.runs.filter((run) => run.role === 'candidate')).toHaveLength(fixtures.length);
  });

  it('summarizes correctness outcomes', () => {
    const { report } = suite;

    expect(report.summary.fixtures).toBe(report.runs.length / 2);
    expect(report.summary.runsTotal).toBe(report.runs.length);
    expect(report.summary.correctnessFailed).toBe(0);
    expect(report.summary.correctnessPassed).toBe(report.runs.length);
  });

  it('counts comparison verdicts and claims no verified savings', () => {
    const { report } = suite;

    expect(report.comparisons).toHaveLength(report.summary.fixtures);
    expect(report.summary.verdicts.unavailable).toBe(report.comparisons.length);
    expect(report.summary.verdicts['benchmark-verified']).toBe(0);
    for (const comparison of report.comparisons) {
      expect(comparison.verdict).not.toBe('benchmark-verified');
    }
  });

  it('lists only the metrics that were unavailable in every run', () => {
    const { report } = suite;

    expect(report.summary.unavailableMetrics).toEqual(
      expect.arrayContaining(['inputTokens', 'outputTokens', 'totalTokens', 'toolCalls', 'repeatedFileReads']),
    );
    expect(report.summary.unavailableMetrics).not.toContain('durationMs');
    expect(report.summary.unavailableMetrics).not.toContain('optimizerErrors');
    expect(report.summary.unavailableMetrics).not.toContain('recoveryAttempts');
  });

  it('aggregates supplied runs and comparisons', () => {
    const rebuilt = buildReport({
      runs: suite.report.runs,
      comparisons: suite.report.comparisons,
      generatedAt: FIXED_NOW,
      version: '0.0.0',
    });

    expect(rebuilt.summary).toEqual(suite.report.summary);
  });
});

describe('writeReport', () => {
  it('writes valid JSON and creates missing directories', async () => {
    const directory = await makeTempDir();
    const target = path.join(directory, 'nested', 'reports', 'benchmark-report.json');

    const written = await writeReport(suite.report, target);
    const text = await readFile(written, 'utf8');
    const parsed = JSON.parse(text) as { schemaVersion: number; summary: { fixtures: number } };

    expect(written).toBe(target);
    expect(parsed.schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
    expect(parsed.summary.fixtures).toBe(suite.fixtures.length);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('never writes fixture content into the report', async () => {
    const directory = await makeTempDir();
    const target = path.join(directory, 'benchmark-report.json');

    await writeReport(suite.report, target);
    const text = await readFile(target, 'utf8');

    expect(text).not.toContain('AssertionError: expected 3 to be 4');
    expect(text).not.toContain('SYSTEM INSTRUCTIONS');
    expect(text).not.toContain('Never delete or weaken existing tests');
    expect(text).not.toContain('read_file src/config.ts');
    // Content is represented by hashes and lengths instead.
    expect(text).toContain('inputHash');
    expect(text).toContain('inputLength');
  });
});
