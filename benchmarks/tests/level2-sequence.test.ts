import { describe, expect, it } from 'vitest';
import { buildPlan, findTask, runArmSequence, syntheticObservation } from '../src/level2/index.js';
import type {
  ArmRunOutcome,
  ArmSequenceBudget,
  Level2ArmObservation,
  Level2Plan,
  Level2PlannedRun,
  Level2Task,
} from '../src/level2/index.js';

/**
 * The live arm sequence's stopping rule, exercised by **fault injection**.
 *
 * The defect these tests exist for was measured, not imagined: on 2026-10-12 the control session
 * of a two-session, single-use authorized canary exited non-zero (the provider refused the request
 * upstream). Its run was correctly refused as `session-exit-nonzero` — and the treatment arm was
 * launched anyway, spending the second half of the authorization to learn the same thing twice.
 *
 * So the rule under test is: **the first fatal outcome ends the plan**. The per-run execution is
 * injected here, which is what makes "the second arm never launched" a fact about the returned
 * `launched` list rather than a claim about control flow inside a file no test can import.
 */

const plan: Level2Plan = buildPlan({
  pairsPerTask: 1,
  tasks: ['repeated-reads-catalogue', 'read-and-edit-total'].flatMap((id): Level2Task[] => {
    const task = findTask(id);
    if (task === undefined) {
      throw new Error(`the task pack no longer contains ${id}`);
    }
    return [task];
  }),
  declarationFingerprint: 'declaration-fingerprint',
  allowIncomplete: true,
});

/** A run outcome for each case: what the arm driver would have reported. */
function outcome(overrides: Partial<ArmRunOutcome> = {}): ArmRunOutcome {
  return {
    observation: undefined,
    problems: [],
    artifactPath: 'C:/tmp/arm/artifacts/arm-observation.json',
    outputRevision: undefined,
    driverExitCode: 1,
    accepted: false,
    invalidReason: 'session-exit-nonzero',
    modelUnavailable: false,
    ...overrides,
  };
}

/** A healthy observation: a run that ran, passed its tests and reported usage. */
function healthy(arm: 'control' | 'treatment'): Level2ArmObservation {
  return syntheticObservation({ arm, taskPassed: true, inputTokens: 1_000, outputTokens: 200 });
}

/** A budget that never blocks, so a run only stops for the reason under test. */
const permissiveBudget = { observe: () => ({ allowed: true, reason: undefined, detail: 'within cap' }) };

/** A budget that blocks after the first observation, as an unreported cost does. */
const blockingBudget = {
  observe: () => ({
    allowed: false,
    reason: 'cost-unreported' as const,
    detail: 'the run reported no cost, so a spending cap cannot bound it',
  }),
};

/** Run the sequence with an executor that records what it was asked for. */
async function sequenceWith(
  outcomes: readonly ArmRunOutcome[],
  budget: ArmSequenceBudget = permissiveBudget,
) {
  const launched: Level2PlannedRun[] = [];
  let calls = 0;
  const result = await runArmSequence({
    plan,
    model: 'opencode/gpt-5.4-mini',
    budget,
    execute: async (run) => {
      launched.push(run);
      const next = outcomes[calls] ?? outcomes[outcomes.length - 1] ?? outcome();
      calls += 1;
      return next;
    },
  });
  return { result, launched, calls };
}

describe('the live arm sequence', () => {
  it('runs every planned arm when nothing is fatal', async () => {
    const { result, launched, calls } = await sequenceWith([
      outcome({ observation: healthy('control'), accepted: true, invalidReason: undefined, driverExitCode: 0 }),
      outcome({
        observation: healthy('treatment'),
        accepted: true,
        invalidReason: undefined,
        driverExitCode: 0,
      }),
    ]);

    expect(result.stop).toBeUndefined();
    expect(result.failures).toBe(0);
    expect(launched).toHaveLength(plan.runs.length);
    expect(calls).toBe(plan.runs.length);
    expect(result.dispositions).toHaveLength(plan.runs.length);
    expect(result.dispositions.every((entry) => entry.disposition === 'solved')).toBe(true);
  });

  it('stops the plan when an arm produces no measurement, and never launches the next arm', async () => {
    // The exact canary shape: the control session crashed, and the treatment arm must not run.
    const { result, launched, calls } = await sequenceWith([
      outcome({ accepted: false, invalidReason: 'session-exit-nonzero' }),
      outcome({ observation: healthy('treatment'), accepted: true, driverExitCode: 0 }),
    ]);

    expect(calls).toBe(1);
    expect(launched).toEqual([plan.runs[0]]);
    expect(result.stop?.code).toBe('invalid-measurement');
    expect(result.stop?.detail).toContain('produced no measurement');
    expect(result.stop?.detail).toContain('session-exit-nonzero');
    expect(result.observations).toEqual([]);
    expect(result.failures).toBe(1);
  });

  it('keeps an accurate disposition for the failed run and marks the rest not-run', async () => {
    const { result } = await sequenceWith([outcome({ invalidReason: 'session-exit-nonzero' })]);

    expect(result.dispositions).toHaveLength(plan.runs.length);
    expect(result.dispositions[0]).toMatchObject({
      taskId: plan.runs[0]?.taskId,
      arm: plan.runs[0]?.arm,
      disposition: 'invalid-measurement',
    });
    expect(result.dispositions[0]?.detail).toContain('session-exit-nonzero');
    expect(
      result.dispositions.slice(1).every((entry) => entry.disposition === 'not-run'),
    ).toBe(true);
    expect(result.dispositions.slice(1).every((entry) => /stopped before this run/.test(entry.detail))).toBe(
      true,
    );
  });

  it('stops on a refused model without composing a request, and never launches another arm', async () => {
    const { result, calls } = await sequenceWith([
      outcome({ modelUnavailable: true, invalidReason: 'model-unavailable' }),
    ]);

    expect(calls).toBe(1);
    expect(result.stop?.code).toBe('model-refused');
    expect(result.dispositions[0]?.disposition).toBe('invalid-measurement');
    expect(result.dispositions[1]?.disposition).toBe('not-run');
  });

  it('stops when a session did not engage the harness', async () => {
    // A well-formed artifact whose containment evidence is missing: the harness never ran, so
    // there is nothing to compare and the next session cannot be assumed to differ.
    const disengaged: Level2ArmObservation = {
      ...syntheticObservation({ arm: 'control', taskPassed: true, inputTokens: 1_000, outputTokens: 200 }),
      containment: undefined,
    };
    const { result, calls } = await sequenceWith([
      outcome({
        observation: disengaged,
        accepted: true,
        invalidReason: undefined,
        driverExitCode: 0,
      }),
    ]);

    expect(calls).toBe(1);
    expect(result.stop?.code).toBe('not-engaged');
    expect(result.observations).toEqual([]);
    expect(result.dispositions[0]?.disposition).toBe('invalid-measurement');
    expect(result.dispositions[1]?.disposition).toBe('not-run');
  });

  it('stops after the session whose caps were broken, including an unreported cost', async () => {
    const { result, calls } = await sequenceWith(
      [
        outcome({
          observation: healthy('control'),
          accepted: true,
          invalidReason: undefined,
          driverExitCode: 0,
        }),
      ],
      blockingBudget,
    );

    // The run itself was a measurement — it is kept — and the *next* session is what does not start.
    expect(calls).toBe(1);
    expect(result.observations).toHaveLength(1);
    expect(result.stop?.code).toBe('budget');
    expect(result.stop?.detail).toContain('no cost');
    expect(result.dispositions[0]?.disposition).toBe('solved');
    expect(result.dispositions[1]?.disposition).toBe('not-run');
  });

  it('does not treat a coding failure or missing token fields as a reason to stop', async () => {
    // A task-failed run is a result about the model; stopping on it would end an experiment because
    // the model had a bad run.
    const failed = syntheticObservation({ arm: 'control', taskPassed: false, inputTokens: 900, outputTokens: 100 });
    const { result, calls } = await sequenceWith([
      outcome({ observation: failed, accepted: true, invalidReason: undefined, driverExitCode: 0 }),
      outcome({
        observation: healthy('treatment'),
        accepted: true,
        invalidReason: undefined,
        driverExitCode: 0,
      }),
    ]);

    expect(calls).toBe(plan.runs.length);
    expect(result.stop).toBeUndefined();
    expect(result.dispositions[0]?.disposition).toBe('task-failed');
    expect(result.dispositions.some((entry) => entry.disposition === 'not-run')).toBe(false);
  });
});
