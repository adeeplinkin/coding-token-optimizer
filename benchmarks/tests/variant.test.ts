import { describe, expect, it } from 'vitest';
import {
  InvalidVariantDeclarationError,
  compareRuns,
  estimated,
  measured,
  runBenchmarkSuite,
  runFixture,
  validateVariantDeclaration,
  variantProvenanceFor,
} from '../src/index.js';
import type {
  BenchmarkFixture,
  BenchmarkProvenance,
  BenchmarkRunRecord,
  DeclaredVariant,
} from '../src/index.js';
import { SAMPLE_CONTEXT } from './helpers.js';

const FIXED_NOW = new Date('2026-10-10T00:00:00.000Z');

const fixture: BenchmarkFixture = {
  id: 'variant-fixture',
  description: 'Fixture used by declared-variant comparison tests.',
  category: 'ordinary-text',
  context: SAMPLE_CONTEXT,
  expectExactPreservation: true,
  requiredContent: [{ label: 'sample-line', text: 'alpha' }],
};

/**
 * A declared controlled comparison. The two arms differ only in the optimizer
 * configuration they record — the single permitted optimization axis.
 */
const declaration: DeclaredVariant = {
  declarationId: 'duplicate-elision-a',
  axis: 'optimizer-configuration',
  control: {
    variantId: 'control',
    role: 'baseline',
    optimizerConfiguration: 'pass-through',
  },
  treatment: {
    variantId: 'safe-mode-v1',
    role: 'candidate',
    optimizerConfiguration: 'pass-through+duplicate-elision',
  },
};

interface DeclaredRuns {
  readonly baseline: BenchmarkRunRecord;
  readonly candidate: BenchmarkRunRecord;
}

/** Record one arm as the suite does: configuration and declared identity together. */
async function makeDeclaredRuns(
  options: { readonly treatmentConfiguration?: string } = {},
): Promise<DeclaredRuns> {
  const baseline = await runFixture(fixture, {
    role: 'baseline',
    mode: 'safe',
    optimizerConfiguration: declaration.control.optimizerConfiguration,
    variant: variantProvenanceFor(declaration, 'baseline'),
  });
  const candidate = await runFixture(fixture, {
    role: 'candidate',
    mode: 'safe',
    optimizerConfiguration:
      options.treatmentConfiguration ?? declaration.treatment.optimizerConfiguration,
    variant: variantProvenanceFor(declaration, 'candidate'),
  });
  return { baseline, candidate };
}

/** Two undeclared runs, as produced before Stage 1S. */
async function makeUndeclaredRuns(configurations?: {
  readonly baseline?: string;
  readonly candidate?: string;
}): Promise<DeclaredRuns> {
  const baseline = await runFixture(fixture, {
    role: 'baseline',
    mode: 'safe',
    ...(configurations?.baseline === undefined
      ? {}
      : { optimizerConfiguration: configurations.baseline }),
  });
  const candidate = await runFixture(fixture, {
    role: 'candidate',
    mode: 'safe',
    ...(configurations?.candidate === undefined
      ? {}
      : { optimizerConfiguration: configurations.candidate }),
  });
  return { baseline, candidate };
}

function withTotalTokens(
  run: BenchmarkRunRecord,
  total: number,
  evidence: 'measured' | 'estimated' = 'measured',
): BenchmarkRunRecord {
  return {
    ...run,
    metrics: {
      ...run.metrics,
      totalTokens: evidence === 'estimated' ? estimated(total) : measured(total),
    },
  };
}

function withProvenance(
  run: BenchmarkRunRecord,
  patch: Partial<BenchmarkProvenance>,
): BenchmarkRunRecord {
  return { ...run, provenance: { ...run.provenance, ...patch } };
}

function withoutVariant(run: BenchmarkRunRecord): BenchmarkRunRecord {
  const { variant: _variant, ...provenance } = run.provenance;
  return { ...run, provenance };
}

/**
 * Fail every correctness check while keeping the check names intact, so the
 * pair still shares one set of correctness criteria and reaches the correctness
 * outcome rules rather than the criteria mismatch guard.
 */
function markCorrectnessFailed(run: BenchmarkRunRecord): BenchmarkRunRecord {
  return {
    ...run,
    correctness: {
      passed: false,
      checks: run.correctness.checks.map((check) => ({ ...check, passed: false })),
    },
  };
}

describe('declared control-versus-treatment comparison', () => {
  it('compares a valid control/treatment pair instead of rejecting it', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(baseline, candidate);

    // The pair is no longer rejected for its (necessarily) different
    // configuration identities; it is compared and the tokens are simply missing.
    expect(result.verdict).toBe('unavailable');
    expect(result.reason).toMatch(/token/i);
    expect(result.notes).toEqual([]);
  });

  it('verifies a real improvement when host-reported token usage exists', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(withTotalTokens(baseline, 1000), withTotalTokens(candidate, 800));

    expect(result.verdict).toBe('benchmark-verified');
    expect(result.tokenDelta).toEqual({ evidence: 'measured', value: -200 });
    if (result.tokenDeltaPercent.evidence === 'unavailable') {
      throw new Error('expected an available percentage');
    }
    expect(result.tokenDeltaPercent.value).toBeCloseTo(-20, 10);
  });

  it('still reports a regression when the treatment arm costs more', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(withTotalTokens(baseline, 1000), withTotalTokens(candidate, 1100));

    expect(result.verdict).toBe('regression');
    expect(result.correctnessRegression).toBe(false);
  });

  it('stamps both arms with the declared experiment and axis', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    expect(baseline.provenance.variant).toEqual({
      declarationId: 'duplicate-elision-a',
      variantId: 'control',
      axis: 'optimizer-configuration',
      role: 'baseline',
    });
    expect(candidate.provenance.variant).toEqual({
      declarationId: 'duplicate-elision-a',
      variantId: 'safe-mode-v1',
      axis: 'optimizer-configuration',
      role: 'candidate',
    });
    expect(baseline.provenance.configurationId).not.toBe(candidate.provenance.configurationId);
    expect(baseline.inputHash).toBe(candidate.inputHash);
  });
});

describe('declared variant metadata guards', () => {
  it('rejects a pair whose declared arms record the same configuration', async () => {
    const { baseline, candidate } = await makeDeclaredRuns({
      treatmentConfiguration: declaration.control.optimizerConfiguration,
    });

    const result = compareRuns(baseline, candidate);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/same optimizer configuration/);
  });

  it('rejects a pair declaring the same variant arm on both sides', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const sameArm = withProvenance(candidate, {
      variant: { ...variantProvenanceFor(declaration, 'candidate'), variantId: 'control' },
    });

    const result = compareRuns(baseline, sameArm);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/same variant arm/);
  });

  it('rejects a pair from different declared experiments', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const otherExperiment = withProvenance(candidate, {
      variant: { ...variantProvenanceFor(declaration, 'candidate'), declarationId: 'duplicate-elision-b' },
    });

    const result = compareRuns(baseline, otherExperiment);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/different controlled experiments/);
  });

  it('rejects a declaration that only one arm carries', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const missingOnCandidate = compareRuns(baseline, withoutVariant(candidate));
    const missingOnBaseline = compareRuns(withoutVariant(baseline), candidate);

    expect(missingOnCandidate.verdict).toBe('invalid');
    expect(missingOnCandidate.reason).toMatch(/Inconsistent variant metadata/);
    expect(missingOnBaseline.verdict).toBe('invalid');
    expect(missingOnBaseline.reason).toMatch(/Inconsistent variant metadata/);
  });

  it('rejects swapped arm roles even when the declared identifiers differ', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const swappedBaseline = withProvenance(baseline, {
      variant: variantProvenanceFor(declaration, 'candidate'),
    });
    const swappedCandidate = withProvenance(candidate, {
      variant: variantProvenanceFor(declaration, 'baseline'),
    });

    const result = compareRuns(swappedBaseline, swappedCandidate);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/assigned the wrong roles/);
  });

  it('rejects a pair whose arms both claim the candidate role', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const mislabelled = withProvenance(baseline, {
      variant: { ...variantProvenanceFor(declaration, 'baseline'), role: 'candidate' },
    });

    const result = compareRuns(mislabelled, candidate);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/assigned the wrong roles/);
  });

  it('rejects a configuration identity that is not derived from its recorded parts', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const tampered = withProvenance(candidate, { configurationId: 'synthetic-fixture|0.0.0|safe|pass-through' });

    const result = compareRuns(baseline, tampered);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/configuration identity is not consistent/);
  });

  it('rejects a declared pair that declares different axes', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const otherAxis = withProvenance(candidate, {
      variant: {
        ...variantProvenanceFor(declaration, 'candidate'),
        axis: 'model-settings' as never,
      },
    });

    const result = compareRuns(baseline, otherAxis);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/different optimization axes/);
  });
});

describe('unrelated differences remain rejected in a declared pair', () => {
  it('rejects different harnesses', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(
      withProvenance(baseline, { harness: 'opencode' }),
      withProvenance(candidate, { harness: 'codex' }),
    );

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/harnesses/);
  });

  it('rejects different optimization modes', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(
      withProvenance(baseline, { mode: 'safe' }),
      withProvenance(candidate, { mode: 'aggressive' }),
    );

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/modes/);
  });

  it('rejects different optimizer revisions', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(
      withProvenance(baseline, { optimizerRevision: '1.0.0' }),
      withProvenance(candidate, { optimizerRevision: '2.0.0' }),
    );

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/revisions/);
  });

  it('rejects a pair differing in more than the declared axis', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    // Harness and configuration both differ: the extra difference is not declared.
    const harnessAndConfiguration = compareRuns(
      withProvenance(baseline, {
        harness: 'opencode',
        configurationId: 'opencode|0.0.0|safe|pass-through',
      }),
      candidate,
    );
    // Mode and configuration both differ.
    const modeAndConfiguration = compareRuns(
      withProvenance(baseline, { mode: 'aggressive', configurationId: 'synthetic-fixture|0.0.0|aggressive|pass-through' }),
      candidate,
    );

    expect(harnessAndConfiguration.verdict).toBe('invalid');
    expect(harnessAndConfiguration.reason).toMatch(/harnesses/);
    expect(modeAndConfiguration.verdict).toBe('invalid');
    expect(modeAndConfiguration.reason).toMatch(/modes/);
  });

  it('rejects different models', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const differentModels = compareRuns(
      withProvenance(baseline, { model: measured('model-a') }),
      withProvenance(candidate, { model: measured('model-b') }),
    );
    const modelVersusUnknown = compareRuns(
      withProvenance(baseline, { model: measured('model-a') }),
      candidate,
    );

    expect(differentModels.verdict).toBe('invalid');
    expect(differentModels.reason).toMatch(/different models/);
    expect(modelVersusUnknown.verdict).toBe('invalid');
    expect(modelVersusUnknown.reason).toMatch(/different models/);
  });

  it('rejects different repository revisions', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(
      withProvenance(baseline, { repositoryRevision: measured('revision-a') }),
      withProvenance(candidate, { repositoryRevision: measured('revision-b') }),
    );

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/different repository revisions/);
  });

  it('rejects different measurement definitions', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const redefined = withProvenance(candidate, {
      measurementEvidence: { ...candidate.provenance.measurementEvidence, durationMs: 'unavailable' },
    });

    const result = compareRuns(baseline, redefined);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/measurement definitions/);
  });

  it('rejects different correctness criteria', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const otherChecks: BenchmarkRunRecord = {
      ...candidate,
      correctness: {
        passed: true,
        checks: [{ name: 'a-different-check', passed: true, detail: 'Different criteria.' }],
      },
    };

    const result = compareRuns(baseline, otherChecks);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/different correctness checks/);
  });

  it('rejects different input contexts', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(withProvenance(baseline, {}), { ...candidate, inputHash: 'f'.repeat(64) });

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/different input contexts/);
  });
});

describe('declared pair correctness and token-evidence safeguards', () => {
  it('never reports a verified saving when the treatment arm fails correctness', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(
      withTotalTokens(baseline, 1000),
      markCorrectnessFailed(withTotalTokens(candidate, 400)),
    );

    expect(result.verdict).toBe('regression');
    expect(result.correctnessRegression).toBe(true);
    expect(result.reason).toMatch(/correctness/i);
  });

  it('rejects a declared pair whose baseline failed correctness', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(markCorrectnessFailed(baseline), candidate);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/baseline run failed/);
  });

  it('reports unavailable rather than a saving when token usage is missing', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const none = compareRuns(baseline, candidate);
    const candidateOnly = compareRuns(baseline, withTotalTokens(candidate, 400));
    const baselineOnly = compareRuns(withTotalTokens(baseline, 1000), candidate);

    for (const result of [none, candidateOnly, baselineOnly]) {
      expect(result.verdict).toBe('unavailable');
      expect(result.tokenDelta.evidence).toBe('unavailable');
    }
  });

  it('refuses to verify savings from estimated token counts', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();

    const result = compareRuns(
      withTotalTokens(baseline, 1000),
      withTotalTokens(candidate, 500, 'estimated'),
    );

    expect(result.verdict).toBe('unavailable');
    expect(result.reason).toMatch(/estimate/i);
  });

  it('refuses a token measurement that provenance claims but the run does not carry', async () => {
    const { baseline, candidate } = await makeDeclaredRuns();
    const claimingMeasured = (run: BenchmarkRunRecord): BenchmarkRunRecord =>
      withProvenance(run, {
        measurementEvidence: { ...run.provenance.measurementEvidence, totalTokens: 'measured' },
      });
    // Provenance says the host reported total tokens; the candidate run carries no
    // value. A declared measurement must never be upgraded to a real one.
    const baselineRun = claimingMeasured(withTotalTokens(baseline, 1000));
    const candidateRun = claimingMeasured({
      ...candidate,
      metrics: {
        ...candidate.metrics,
        totalTokens: { evidence: 'unavailable', note: 'the host reported no usage' },
      },
    });

    const result = compareRuns(baselineRun, candidateRun);

    expect(result.verdict).toBe('unavailable');
    expect(result.tokenDelta.evidence).toBe('unavailable');
  });
});

describe('backward compatibility of undeclared comparisons', () => {
  it('keeps the original strict configuration guard', async () => {
    const { baseline, candidate } = await makeUndeclaredRuns({
      baseline: 'pass-through',
      candidate: 'pass-through+duplicate-elision',
    });

    const result = compareRuns(baseline, candidate);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toBe('The runs were recorded with different optimizer configurations.');
  });

  it('compares undeclared runs exactly as before', async () => {
    const { baseline, candidate } = await makeUndeclaredRuns();

    const result = compareRuns(withTotalTokens(baseline, 1000), withTotalTokens(candidate, 900));

    expect(result.verdict).toBe('benchmark-verified');
    expect(result.tokenDelta).toEqual({ evidence: 'measured', value: -100 });
    expect(baseline.provenance.variant).toBeUndefined();
  });

  it('does not let a declaration rescue an undeclared partner', async () => {
    const { baseline, candidate } = await makeUndeclaredRuns({
      baseline: 'pass-through',
      candidate: 'pass-through+duplicate-elision',
    });

    const result = compareRuns(
      withProvenance(baseline, { variant: variantProvenanceFor(declaration, 'baseline') }),
      candidate,
    );

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/Inconsistent variant metadata/);
  });

  it('omits the controlled-variant section from undeclared reports', async () => {
    const suite = await runBenchmarkSuite({ now: () => FIXED_NOW });

    expect(suite.report.controlledVariants).toBeUndefined();
    expect(suite.report.summary.verdicts['benchmark-verified']).toBe(0);
    expect(JSON.stringify(suite.report)).not.toContain('controlledVariants');
  });
});

describe('declared variants through the benchmark suite', () => {
  it('applies the declared configurations and records both arms', async () => {
    const suite = await runBenchmarkSuite({ variant: declaration, now: () => FIXED_NOW });
    const baselines = suite.report.runs.filter((run) => run.role === 'baseline');
    const candidates = suite.report.runs.filter((run) => run.role === 'candidate');

    expect(baselines).toHaveLength(suite.fixtures.length);
    expect(candidates).toHaveLength(suite.fixtures.length);
    expect(
      baselines.every(
        (run) => run.provenance.optimizerConfiguration === declaration.control.optimizerConfiguration,
      ),
    ).toBe(true);
    expect(
      candidates.every(
        (run) =>
          run.provenance.optimizerConfiguration === declaration.treatment.optimizerConfiguration,
      ),
    ).toBe(true);
    expect(
      baselines.every(
        (run) => run.provenance.variant?.variantId === declaration.control.variantId,
      ),
    ).toBe(true);
    expect(
      candidates.every(
        (run) => run.provenance.variant?.variantId === declaration.treatment.variantId,
      ),
    ).toBe(true);
    expect(suite.correctnessFailed).toBe(false);
    expect(suite.report.comparisons.every((comparison) => comparison.verdict !== 'invalid')).toBe(
      true,
    );
  });

  it('restates the declaration in the report, folding repeated arms', async () => {
    const suite = await runBenchmarkSuite({ variant: declaration, now: () => FIXED_NOW });

    expect(suite.report.controlledVariants).toEqual([
      {
        declarationId: 'duplicate-elision-a',
        axis: 'optimizer-configuration',
        arms: [
          {
            variantId: 'control',
            role: 'baseline',
            optimizerConfiguration: 'pass-through',
          },
          {
            variantId: 'safe-mode-v1',
            role: 'candidate',
            optimizerConfiguration: 'pass-through+duplicate-elision',
          },
        ],
      },
    ]);
  });

  it('produces deterministic comparisons and declarations for the same input', async () => {
    const first = await runBenchmarkSuite({ variant: declaration, now: () => FIXED_NOW });
    const second = await runBenchmarkSuite({ variant: declaration, now: () => FIXED_NOW });

    expect(second.report.comparisons).toEqual(first.report.comparisons);
    expect(second.report.controlledVariants).toEqual(first.report.controlledVariants);
    expect(second.report.summary).toEqual(first.report.summary);
  });

  it('rejects a declaration that contradicts an explicit arm configuration', async () => {
    await expect(
      runBenchmarkSuite({
        variant: declaration,
        baselineConfiguration: 'something-else',
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(InvalidVariantDeclarationError);
    await expect(
      runBenchmarkSuite({
        variant: declaration,
        candidateConfiguration: 'something-else',
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(InvalidVariantDeclarationError);
  });

  it('accepts an explicit arm configuration that matches the declaration', async () => {
    const suite = await runBenchmarkSuite({
      variant: declaration,
      baselineConfiguration: declaration.control.optimizerConfiguration,
      candidateConfiguration: declaration.treatment.optimizerConfiguration,
      now: () => FIXED_NOW,
    });

    expect(suite.report.controlledVariants).toHaveLength(1);
  });

  it('rejects malformed metadata supplied at runtime before recording any run', async () => {
    await expect(
      runBenchmarkSuite({
        variant: { declarationId: 'x', axis: 'optimizer-configuration' } as unknown as DeclaredVariant,
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(InvalidVariantDeclarationError);
  });
});

const malformedDeclarations: Array<[string, unknown]> = [
  ['a non-object declaration', 'control-vs-treatment'],
  ['an array declaration', []],
  ['a missing treatment arm', {
    declarationId: 'x',
    axis: 'optimizer-configuration',
    control: { variantId: 'control', role: 'baseline', optimizerConfiguration: 'a' },
  }],
  ['an unknown declaration field', {
    declarationId: 'x',
    axis: 'optimizer-configuration',
    control: { variantId: 'control', role: 'baseline', optimizerConfiguration: 'a' },
    treatment: { variantId: 'treatment', role: 'candidate', optimizerConfiguration: 'b' },
    extra: true,
  }],
  ['an unknown axis', {
    declarationId: 'x',
    axis: 'model-settings',
    control: { variantId: 'control', role: 'baseline', optimizerConfiguration: 'a' },
    treatment: { variantId: 'treatment', role: 'candidate', optimizerConfiguration: 'b' },
  }],
  ['an empty declaration identifier', {
    declarationId: '   ',
    axis: 'optimizer-configuration',
    control: { variantId: 'control', role: 'baseline', optimizerConfiguration: 'a' },
    treatment: { variantId: 'treatment', role: 'candidate', optimizerConfiguration: 'b' },
  }],
  ['an unknown arm role', {
    declarationId: 'x',
    axis: 'optimizer-configuration',
    control: { variantId: 'control', role: 'treatment-group', optimizerConfiguration: 'a' },
    treatment: { variantId: 'treatment', role: 'candidate', optimizerConfiguration: 'b' },
  }],
  ['a control arm that is not the baseline', {
    declarationId: 'x',
    axis: 'optimizer-configuration',
    control: { variantId: 'control', role: 'candidate', optimizerConfiguration: 'a' },
    treatment: { variantId: 'treatment', role: 'candidate', optimizerConfiguration: 'b' },
  }],
  ['a treatment arm that is not the candidate', {
    declarationId: 'x',
    axis: 'optimizer-configuration',
    control: { variantId: 'control', role: 'baseline', optimizerConfiguration: 'a' },
    treatment: { variantId: 'treatment', role: 'baseline', optimizerConfiguration: 'b' },
  }],
  ['two arms with the same variant identifier', {
    declarationId: 'x',
    axis: 'optimizer-configuration',
    control: { variantId: 'same', role: 'baseline', optimizerConfiguration: 'a' },
    treatment: { variantId: 'same', role: 'candidate', optimizerConfiguration: 'b' },
  }],
  ['two arms with the same optimizer configuration', {
    declarationId: 'x',
    axis: 'optimizer-configuration',
    control: { variantId: 'control', role: 'baseline', optimizerConfiguration: 'same' },
    treatment: { variantId: 'treatment', role: 'candidate', optimizerConfiguration: 'same' },
  }],
  ['an arm with an unknown field', {
    declarationId: 'x',
    axis: 'optimizer-configuration',
    control: { variantId: 'control', role: 'baseline', optimizerConfiguration: 'a', note: 'hi' },
    treatment: { variantId: 'treatment', role: 'candidate', optimizerConfiguration: 'b' },
  }],
];

describe('variant declaration validation', () => {
  it('accepts a well-formed declaration', () => {
    expect(validateVariantDeclaration(declaration)).toEqual(declaration);
  });

  it.each(malformedDeclarations)('rejects %s', (_label, value) => {
    expect(() => validateVariantDeclaration(value)).toThrow(InvalidVariantDeclarationError);
  });

  it('names the offending field in the failure', () => {
    expect(() => validateVariantDeclaration({ declarationId: 'x' })).toThrow(/axis/);
  });
});
