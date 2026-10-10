import { describe, expect, it } from 'vitest';
import { compareRuns, estimated, measured, runFixture } from '../src/index.js';
import type { BenchmarkFixture, BenchmarkRunRecord } from '../src/index.js';
import { SAMPLE_CONTEXT } from './helpers.js';

const fixture: BenchmarkFixture = {
  id: 'comparison-fixture',
  description: 'Fixture used by comparison tests.',
  category: 'ordinary-text',
  context: SAMPLE_CONTEXT,
  expectExactPreservation: true,
  requiredContent: [{ label: 'sample-line', text: 'alpha' }],
};

async function makeRuns(): Promise<{
  baseline: BenchmarkRunRecord;
  candidate: BenchmarkRunRecord;
}> {
  const baseline = await runFixture(fixture, { role: 'baseline', mode: 'safe' });
  const candidate = await runFixture(fixture, { role: 'candidate', mode: 'safe' });
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

function withCorrectness(run: BenchmarkRunRecord, passed: boolean): BenchmarkRunRecord {
  return {
    ...run,
    correctness: {
      passed,
      checks: [{ name: 'fixture-check', passed, detail: 'Fixture correctness check.' }],
    },
  };
}

describe('compareRuns with unavailable token data', () => {
  it('reports unavailable instead of inventing a saving', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(baseline, candidate);

    expect(result.verdict).toBe('unavailable');
    expect(result.reason).toMatch(/token/i);
    expect(result.correctnessRegression).toBe(false);
    expect(result.tokenDelta.evidence).toBe('unavailable');
    expect(result.tokenDeltaPercent.evidence).toBe('unavailable');
  });

  it('reports unavailable when only the candidate has token data', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(baseline, withTotalTokens(candidate, 500));

    expect(result.verdict).toBe('unavailable');
  });
});

describe('compareRuns with measured token data', () => {
  it('verifies an improvement only when correctness passes', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(withTotalTokens(baseline, 1000), withTotalTokens(candidate, 800));

    expect(result.verdict).toBe('benchmark-verified');
    expect(result.tokenDelta).toEqual({ evidence: 'measured', value: -200 });
    if (result.tokenDeltaPercent.evidence === 'unavailable') {
      throw new Error('expected an available percentage');
    }
    expect(result.tokenDeltaPercent.value).toBeCloseTo(-20, 10);
  });

  it('reports a token regression', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(withTotalTokens(baseline, 1000), withTotalTokens(candidate, 1250));

    expect(result.verdict).toBe('regression');
    expect(result.correctnessRegression).toBe(false);
    expect(result.tokenDelta).toEqual({ evidence: 'measured', value: 250 });
  });

  it('reports no-change for equal token counts', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(withTotalTokens(baseline, 1000), withTotalTokens(candidate, 1000));

    expect(result.verdict).toBe('no-change');
    expect(result.tokenDelta).toEqual({ evidence: 'measured', value: 0 });
  });

  it('never reports a verified improvement when the candidate fails correctness', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(
      withTotalTokens(baseline, 1000),
      withCorrectness(withTotalTokens(candidate, 200), false),
    );

    expect(result.verdict).toBe('regression');
    expect(result.correctnessRegression).toBe(true);
    expect(result.reason).toMatch(/correctness/i);
  });

  it('refuses to verify savings from estimated token counts', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(
      withTotalTokens(baseline, 1000),
      withTotalTokens(candidate, 500, 'estimated'),
    );

    expect(result.verdict).toBe('unavailable');
    expect(result.reason).toMatch(/estimate/i);
  });

  it('protects against division by zero on a zero baseline', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(withTotalTokens(baseline, 0), withTotalTokens(candidate, 0));

    expect(result.verdict).toBe('unavailable');
    expect(result.reason).toMatch(/zero/i);
    expect(result.tokenDeltaPercent.evidence).toBe('unavailable');
    expect(result.tokenDelta).toEqual({ evidence: 'measured', value: 0 });
  });
});

describe('compareRuns provenance and validity guards', () => {
  it('rejects mismatched fixture identities', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(baseline, { ...candidate, fixtureId: 'other-fixture' });

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/different fixtures/);
  });

  it('rejects provenance that does not match the recorded fixture', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(baseline, {
      ...candidate,
      provenance: { ...candidate.provenance, fixtureId: 'other-fixture' },
    });

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/Provenance/);
  });

  it('rejects runs recorded with different harnesses', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(baseline, {
      ...candidate,
      provenance: { ...candidate.provenance, harness: 'opencode' },
    });

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/harnesses/);
  });

  it('rejects runs recorded in different modes', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(baseline, {
      ...candidate,
      provenance: { ...candidate.provenance, mode: 'aggressive' },
    });

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/modes/);
  });

  it('rejects runs recorded with different optimizer configurations', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(baseline, {
      ...candidate,
      provenance: { ...candidate.provenance, configurationId: 'other|0.0.0|safe|different' },
    });

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/configurations/);
  });

  it('rejects runs recorded with different optimizer revisions', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(baseline, {
      ...candidate,
      provenance: { ...candidate.provenance, optimizerRevision: '9.9.9' },
    });

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/revisions/);
  });

  it('rejects a comparison with swapped roles', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns({ ...baseline, role: 'candidate' }, candidate);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/one baseline run and one candidate run/);
  });

  it('rejects a baseline that failed its correctness checks', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(withCorrectness(baseline, false), candidate);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/baseline run failed/);
  });

  it('rejects negative measurements', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(withTotalTokens(baseline, -5), withTotalTokens(candidate, 100));

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/Invalid measurements/);
  });

  it('rejects non-finite measurements', async () => {
    const { baseline, candidate } = await makeRuns();

    const result = compareRuns(withTotalTokens(baseline, Number.NaN), withTotalTokens(candidate, 100));

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/Invalid measurements/);
  });

  it('rejects fractional counts for whole-number metrics', async () => {
    const { baseline, candidate } = await makeRuns();
    const withFractionalToolCalls: BenchmarkRunRecord = {
      ...candidate,
      metrics: { ...candidate.metrics, toolCalls: measured(2.5) },
    };

    const result = compareRuns(baseline, withFractionalToolCalls);

    expect(result.verdict).toBe('invalid');
    expect(result.reason).toMatch(/whole number/);
  });
});
