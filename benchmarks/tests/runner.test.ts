import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { OptimizerEngine } from '@dr-token/core';
import type { OptimizationRequest, OptimizationResult, OptimizerPass } from '@dr-token/core';
import {
  DR_TOKEN_BENCHMARKS_VERSION,
  DR_TOKEN_CORE_VERSION,
  SYNTHETIC_HARNESS_ID,
  TOKENS_UNAVAILABLE_NOTE,
  hashContext,
  isAvailable,
  loadFixtures,
  runFixture,
} from '../src/index.js';
import type { BenchmarkFixture, ContextOptimizer } from '../src/index.js';
import { SAMPLE_CONTEXT } from './helpers.js';

const fixtures = await loadFixtures();

const comparisonFixture: BenchmarkFixture = {
  id: 'runner-fixture',
  description: 'Runner fixture used by tests.',
  category: 'ordinary-text',
  context: SAMPLE_CONTEXT,
  expectExactPreservation: true,
  requiredContent: [{ label: 'sample-line', text: 'alpha' }],
};

function engineWith(pass: OptimizerPass): OptimizerEngine {
  return new OptimizerEngine({ passes: [pass] });
}

const throwingOptimizer: ContextOptimizer = {
  optimize: async (): Promise<OptimizationResult> => {
    throw new Error('SECRET-ENGINE-PAYLOAD must never be recorded');
  },
};

const contradictoryOptimizer: ContextOptimizer = {
  optimize: async (request: OptimizationRequest): Promise<OptimizationResult> => ({
    context: `${request.context}extra`,
    contextUnchanged: true,
    mode: request.mode,
    bypassed: false,
    decisions: [],
  }),
};

describe('recorded versions', () => {
  it('keeps the recorded version constants in sync with the packages', async () => {
    const corePackage = JSON.parse(
      await readFile(new URL('../../packages/core/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const benchmarksPackage = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(DR_TOKEN_CORE_VERSION).toBe(corePackage.version);
    expect(DR_TOKEN_BENCHMARKS_VERSION).toBe(benchmarksPackage.version);
  });
});

describe('runFixture pass-through recording', () => {
  it('records role, fixture identity and provenance', async () => {
    const run = await runFixture(comparisonFixture, { role: 'baseline', mode: 'safe' });

    expect(run.runId).toBe('runner-fixture:baseline');
    expect(run.role).toBe('baseline');
    expect(run.fixtureId).toBe('runner-fixture');
    expect(run.fixtureCategory).toBe('ordinary-text');
    expect(run.provenance.harness).toBe(SYNTHETIC_HARNESS_ID);
    expect(run.provenance.mode).toBe('safe');
    expect(run.provenance.optimizerConfiguration).toBe('pass-through');
    expect(run.provenance.optimizerRevision).toBe('0.0.0');
    expect(run.provenance.configurationId).toContain('pass-through');
    expect(run.provenance.model.evidence).toBe('unavailable');
    expect(run.provenance.repositoryRevision.evidence).toBe('unavailable');
  });

  it('records candidate runs', async () => {
    const run = await runFixture(comparisonFixture, { role: 'candidate', mode: 'safe' });

    expect(run.role).toBe('candidate');
    expect(run.runId).toBe('runner-fixture:candidate');
  });

  it('preserves every default fixture exactly', async () => {
    for (const fixture of fixtures) {
      const run = await runFixture(fixture, { role: 'baseline', mode: 'safe' });
      expect(run.contextPreservedExactly).toBe(true);
      expect(run.correctness.passed).toBe(true);
      expect(run.inputHash).toBe(run.outputHash);
      expect(run.outputLength).toBe(run.inputLength);
      expect(run.outputHash).toBe(hashContext(fixture.context));
    }
  });

  it('records token metrics as unavailable instead of estimating them', async () => {
    const run = await runFixture(comparisonFixture, { role: 'baseline', mode: 'safe' });

    expect(run.metrics.inputTokens).toEqual({ evidence: 'unavailable', note: TOKENS_UNAVAILABLE_NOTE });
    expect(run.metrics.outputTokens.evidence).toBe('unavailable');
    expect(run.metrics.totalTokens.evidence).toBe('unavailable');
    expect(run.metrics.toolCalls.evidence).toBe('unavailable');
    expect(run.metrics.repeatedFileReads.evidence).toBe('unavailable');
    expect(run.provenance.measurementEvidence.totalTokens).toBe('unavailable');
  });

  it('measures duration and error counts with a real clock', async () => {
    const run = await runFixture(comparisonFixture, { role: 'baseline', mode: 'safe' });

    expect(isAvailable(run.metrics.durationMs)).toBe(true);
    if (isAvailable(run.metrics.durationMs)) {
      expect(Number.isFinite(run.metrics.durationMs.value)).toBe(true);
      expect(run.metrics.durationMs.value).toBeGreaterThanOrEqual(0);
    }
    expect(run.metrics.optimizerErrors).toEqual({ evidence: 'measured', value: 0 });
    expect(run.metrics.recoveryAttempts).toEqual({ evidence: 'measured', value: 0 });
    expect(run.provenance.measurementEvidence.optimizerErrors).toBe('measured');
    expect(run.provenance.measurementEvidence.durationMs).toBe('measured');
  });

  it('records a pass-through decision and claims no measured savings', async () => {
    const run = await runFixture(comparisonFixture, { role: 'baseline', mode: 'safe' });

    expect(run.optimizerDecisions).toEqual([
      { passId: 'engine', action: 'pass-through', evidence: 'none' },
    ]);
    expect(run.correctness.checks.map((check) => check.name)).toContain('context-preserved-exactly');
  });

  it.each(['safe', 'aggressive', 'balanced'] as const)(
    'records the %s mode identifier in provenance',
    async (mode) => {
      const run = await runFixture(comparisonFixture, { role: 'baseline', mode });

      expect(run.provenance.mode).toBe(mode);
    },
  );

  it('never stores fixture content in the record', async () => {
    const run = await runFixture(comparisonFixture, { role: 'baseline', mode: 'safe' });

    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain('alpha');
    expect(serialized).not.toContain('beta with a tab');
    expect(run.inputHash).toHaveLength(64);
  });
});

describe('runFixture correctness and fallback', () => {
  it('fails correctness when the optimizer changes the context', async () => {
    const truncatingPass: OptimizerPass = {
      id: 'truncating-pass',
      description: 'Test fixture that returns a shortened context.',
      run: () => ({
        context: 'beta with a tab\n',
        changed: true,
        reason: 'test fixture truncated the context',
        evidence: 'none',
      }),
    };

    const run = await runFixture(comparisonFixture, {
      role: 'candidate',
      mode: 'safe',
      optimizer: engineWith(truncatingPass),
    });

    expect(run.contextPreservedExactly).toBe(false);
    expect(run.correctness.passed).toBe(false);
    const failed = run.correctness.checks.filter((check) => !check.passed).map((check) => check.name);
    expect(failed).toContain('context-preserved-exactly');
    expect(failed).toContain('required-content:sample-line');
    expect(run.metrics.optimizerErrors).toEqual({ evidence: 'measured', value: 0 });
  });

  it('falls back to the original context and counts the error when a pass fails', async () => {
    const failingPass: OptimizerPass = {
      id: 'failing-pass',
      description: 'Test fixture that always throws.',
      run: () => {
        throw new Error('SECRET-PASS-PAYLOAD must never be recorded');
      },
    };

    const run = await runFixture(comparisonFixture, {
      role: 'candidate',
      mode: 'safe',
      optimizer: engineWith(failingPass),
    });

    // Fail-open: the damaged/partial path is discarded and the original survives.
    expect(run.contextPreservedExactly).toBe(true);
    expect(run.correctness.passed).toBe(true);
    expect(run.metrics.optimizerErrors).toEqual({ evidence: 'measured', value: 1 });
    expect(run.metrics.recoveryAttempts).toEqual({ evidence: 'measured', value: 1 });
    expect(run.optimizerDecisions).toEqual([
      { passId: 'failing-pass', action: 'failed', evidence: 'none' },
    ]);
    expect(JSON.stringify(run)).not.toContain('SECRET-PASS-PAYLOAD');
  });

  it('fails correctness and preserves the context when the optimizer itself throws', async () => {
    const run = await runFixture(comparisonFixture, {
      role: 'candidate',
      mode: 'safe',
      optimizer: throwingOptimizer,
    });

    expect(run.contextPreservedExactly).toBe(true);
    expect(run.correctness.passed).toBe(false);
    const failed = run.correctness.checks.filter((check) => !check.passed).map((check) => check.name);
    expect(failed).toContain('engine-completed');
    const engineCheck = run.correctness.checks.find((check) => check.name === 'engine-completed');
    expect(engineCheck?.detail).toContain('Error');
    expect(JSON.stringify(run)).not.toContain('SECRET-ENGINE-PAYLOAD');
    expect(run.metrics.optimizerErrors).toEqual({ evidence: 'measured', value: 1 });
  });

  it('fails correctness when the unchanged flag contradicts the output', async () => {
    const run = await runFixture(comparisonFixture, {
      role: 'candidate',
      mode: 'safe',
      optimizer: contradictoryOptimizer,
    });

    const failed = run.correctness.checks.filter((check) => !check.passed).map((check) => check.name);
    expect(failed).toContain('unchanged-flag-consistent');
    expect(run.correctness.passed).toBe(false);
  });
});
