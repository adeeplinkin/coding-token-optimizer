import {
  SYNTHETIC_HARNESS_ID,
  compareRuns,
  findInvalidMetricValues,
  runFixture,
} from '@dr-token/benchmarks';
import type { BenchmarkFixture, BenchmarkRunRecord, RunMetrics } from '@dr-token/benchmarks';
import { describe, expect, it } from 'vitest';
import {
  CALCULATED_NOT_REPRESENTABLE_NOTE,
  HARNESS_OWNED_METRIC_NOTE,
  OPENCODE_HARNESS_ID,
  toHarnessEvidence,
  toHarnessMeasurement,
  toObservedRunMetrics,
} from '../src/index.js';
import type { ObservationMeasurement, SessionObservationSummary } from '../src/index.js';
import { createObservationHarness } from './helpers.js';

/**
 * Stage 1B integration.
 *
 * The observer produces baseline information about what an agent did. It is not
 * an optimizer, so nothing here may produce a `benchmark-verified` verdict, and
 * no derived aggregate may be projected as a directly measured value.
 */

const fixture: BenchmarkFixture = {
  id: 'opencode-observer-integration',
  description: 'Synthetic fixture used to check observer metric compatibility with the Stage 1B model.',
  category: 'ordinary-text',
  context: 'alpha\n\tbeta\n',
  expectExactPreservation: true,
  requiredContent: [{ label: 'alpha', text: 'alpha' }],
};

const fixedClock = (): Date => new Date('2026-10-10T00:00:00.000Z');

interface ObservedActivity {
  readonly summary: SessionObservationSummary;
  readonly metrics: RunMetrics;
}

/**
 * Drive a deterministic session, then project it into the Stage 1B metric shape.
 *
 * Two reads of the same file and range make `repeatedFileReads` a derived
 * aggregate, and one assistant message makes the token fields aggregates too —
 * exactly the values that must not be presented as direct measurements.
 */
async function observeActivity(): Promise<ObservedActivity> {
  const harness = await createObservationHarness();
  await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/src/main.ts' });
  await harness.after('ses_1', 'read', 'c1', { filePath: '/repo/src/main.ts' });
  await harness.before('ses_1', 'read', 'c2', { filePath: '/repo/src/main.ts' });
  await harness.after('ses_1', 'read', 'c2', { filePath: '/repo/src/main.ts' });
  await harness.before('ses_1', 'bash', 'c3');
  await harness.after('ses_1', 'bash', 'c3');
  await harness.event('message.updated', {
    info: {
      id: 'm1',
      sessionID: 'ses_1',
      role: 'assistant',
      cost: 0.02,
      tokens: { input: 800, output: 120, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });

  const summary = harness.summary('ses_1');
  // The compile-time check: the observer's metric shape must satisfy the real
  // Stage 1B `RunMetrics` type.
  const metrics: RunMetrics = toObservedRunMetrics(summary);
  return { summary, metrics };
}

async function compareWithObserverMetrics(): Promise<{
  readonly baseline: BenchmarkRunRecord;
  readonly candidate: BenchmarkRunRecord;
  readonly metrics: RunMetrics;
}> {
  const baseline = await runFixture(fixture, { role: 'baseline', mode: 'safe', now: fixedClock });
  const observed = await runFixture(fixture, { role: 'candidate', mode: 'safe', now: fixedClock });
  const { metrics } = await observeActivity();
  return { baseline, candidate: { ...observed, metrics }, metrics };
}

describe('observer metrics in the Stage 1B model', () => {
  it('maps every Stage 1B metric name', async () => {
    const { metrics } = await observeActivity();

    expect(Object.keys(metrics).sort()).toEqual([
      'durationMs',
      'inputTokens',
      'optimizerErrors',
      'outputTokens',
      'recoveryAttempts',
      'repeatedFileReads',
      'toolCalls',
      'totalTokens',
    ]);
  });

  it('produces metrics the Stage 1B validators accept', async () => {
    const { metrics } = await observeActivity();

    expect(findInvalidMetricValues(metrics)).toEqual([]);
  });

  it('reports observed tool completions as the directly measured metric', async () => {
    const { metrics } = await observeActivity();

    expect(metrics.toolCalls).toEqual({ evidence: 'measured', value: 3 });
  });

  it('never claims a benchmark verification from observation alone', async () => {
    const { metrics } = await observeActivity();

    expect(metrics.totalTokens.evidence).toBe('unavailable');
    expect(JSON.stringify(metrics)).not.toContain('benchmark-verified');
    expect(JSON.stringify(metrics)).not.toContain('saved');
  });

  it('leaves harness-owned metrics unavailable with a reason', async () => {
    const { metrics } = await observeActivity();

    for (const metric of [metrics.durationMs, metrics.recoveryAttempts, metrics.optimizerErrors]) {
      expect(metric).toEqual({ evidence: 'unavailable', note: HARNESS_OWNED_METRIC_NOTE });
    }
  });
});

describe('measurement provenance is preserved across the bridge', () => {
  it('does not present a calculated aggregate as a directly measured value', async () => {
    const { summary, metrics } = await observeActivity();

    // The observer is explicit about these being derived...
    expect(summary.measurements.repeatedFileReads.evidence).toBe('calculated');
    expect(summary.measurements.inputTokens.evidence).toBe('calculated');
    expect(summary.measurements.outputTokens.evidence).toBe('calculated');

    // ...and the Stage 1B projection must not upgrade them.
    expect(metrics.repeatedFileReads.evidence).toBe('unavailable');
    expect(metrics.inputTokens.evidence).toBe('unavailable');
    expect(metrics.outputTokens.evidence).toBe('unavailable');
  });

  it('marks only directly measured observations as measured', async () => {
    const { metrics } = await observeActivity();

    const measuredNames = Object.entries(metrics)
      .filter(([, measurement]) => measurement.evidence === 'measured')
      .map(([name]) => name)
      .sort();

    expect(measuredNames).toEqual(['toolCalls']);
  });

  it('applies the documented evidence mapping to every observation class', () => {
    expect(toHarnessEvidence('measured')).toBe('measured');
    expect(toHarnessEvidence('calculated')).toBe('unavailable');
    expect(toHarnessEvidence('estimated')).toBe('estimated');
    expect(toHarnessEvidence('unavailable')).toBe('unavailable');
  });

  it('converts each observation measurement faithfully', () => {
    expect(toHarnessMeasurement({ evidence: 'measured', value: 5 })).toEqual({
      evidence: 'measured',
      value: 5,
    });
    expect(toHarnessMeasurement({ evidence: 'estimated', value: 5 })).toEqual({
      evidence: 'estimated',
      value: 5,
    });
    expect(toHarnessMeasurement({ evidence: 'unavailable', note: 'no data' })).toEqual({
      evidence: 'unavailable',
      note: 'no data',
    });
    expect(toHarnessMeasurement({ evidence: 'calculated', value: 5 })).toEqual({
      evidence: 'unavailable',
      note: CALCULATED_NOT_REPRESENTABLE_NOTE,
    });
  });

  it('explains why a derived value cannot be represented', () => {
    expect(CALCULATED_NOT_REPRESENTABLE_NOTE).toContain('calculated aggregate');
    expect(CALCULATED_NOT_REPRESENTABLE_NOTE).toContain('unavailable');
    expect(CALCULATED_NOT_REPRESENTABLE_NOTE).not.toContain('Recorded as measured');
  });

  it('drops the aggregate value instead of smuggling it into the note', async () => {
    const { summary, metrics } = await observeActivity();

    expect(metrics.inputTokens).toEqual({
      evidence: 'unavailable',
      note: CALCULATED_NOT_REPRESENTABLE_NOTE,
    });
    expect(CALCULATED_NOT_REPRESENTABLE_NOTE).not.toContain('800');

    // The aggregate is not lost: it stays in the observation summary.
    expect(summary.measurements.inputTokens).toEqual({ evidence: 'calculated', value: 800 });
    expect(summary.measurements.repeatedFileReads).toEqual({ evidence: 'calculated', value: 1 });
  });

  it('maps every projected metric according to the rule, not the source class name', async () => {
    const { summary, metrics } = await observeActivity();
    const pairs: readonly (readonly [keyof RunMetrics, ObservationMeasurement<number>])[] = [
      ['inputTokens', summary.measurements.inputTokens],
      ['outputTokens', summary.measurements.outputTokens],
      ['totalTokens', summary.measurements.totalTokens],
      ['toolCalls', summary.measurements.toolCompletionsObserved],
      ['repeatedFileReads', summary.measurements.repeatedFileReads],
    ];

    for (const [name, observation] of pairs) {
      const projected = metrics[name];
      if (observation.evidence === 'calculated') {
        expect(projected.evidence, `${name} must not be presented as measured`).toBe('unavailable');
      } else {
        expect(projected.evidence).toBe(toHarnessEvidence(observation.evidence));
      }
    }
  });
});

describe('observer metrics in a Stage 1B comparison', () => {
  it('produces an unavailable verdict rather than a fabricated improvement', async () => {
    const { baseline, candidate, metrics } = await compareWithObserverMetrics();

    expect(metrics.toolCalls.evidence).toBe('measured');
    const result = compareRuns(baseline, candidate);

    expect(result.verdict).toBe('unavailable');
    expect(result.correctnessRegression).toBe(false);
    expect(result.reason).toContain('Total token usage is unavailable');
    expect(result.tokenDelta.evidence).toBe('unavailable');
  });

  it('keeps the baseline run unmodified', async () => {
    const { baseline } = await compareWithObserverMetrics();

    expect(baseline.metrics.totalTokens.evidence).toBe('unavailable');
    expect(baseline.correctness.passed).toBe(true);
    expect(baseline.contextPreservedExactly).toBe(true);
  });

  it('does not relabel a synthetic run as a real OpenCode run', async () => {
    const { candidate } = await compareWithObserverMetrics();

    expect(OPENCODE_HARNESS_ID).toBe('opencode');
    expect(candidate.provenance.harness).toBe(SYNTHETIC_HARNESS_ID);
    expect(candidate.provenance.harness).not.toBe(OPENCODE_HARNESS_ID);
  });
});
