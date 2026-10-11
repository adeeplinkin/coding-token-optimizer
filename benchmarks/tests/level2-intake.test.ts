import { describe, expect, it } from 'vitest';
import {
  checkArmArtifactProvenance,
  checkLiveEngagement,
  digest,
  intakeArmEvidence,
  syntheticObservation,
} from '../src/level2/index.js';
import type {
  Level2ArmObservation,
  Level2InSessionGovernorEvidence,
} from '../src/level2/index.js';

/**
 * Measurement integrity: the rejections that keep a non-measurement out of a report.
 *
 * Every case here is a real failure that produced (or would have produced) a published
 * "result": Stage 1V's canary crashed before any session started, and the run was reported
 * with a full observation because an artifact an earlier run had left at the reused
 * workspace path was read as this run's. The tests below pin each way a run can fail to be
 * a measurement, and prove the intake refuses it instead of passing it on.
 */

const TASK_ID = 'repeated-reads-catalogue';
const NONCE = 'run-nonce-1';
const expected = { taskId: TASK_ID, arm: 'treatment' as const, pairIndex: 0 };

/** A complete, well-formed artifact, exactly as the driver writes one. */
function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    arm: 'treatment',
    runId: `${TASK_ID}:p0:treatment`,
    // The run's own identity and completion flag: what makes this run's output provable.
    runNonce: NONCE,
    complete: true,
    pairIndex: 0,
    attempt: 1,
    startedAt: '2026-10-11T00:00:00.000Z',
    durationMs: 1_000,
    harness: 'opencode-coding-task',
    optimizerRevision: '0.0.0',
    repositoryRevision: digest('repo'),
    promptHash: digest('prompt'),
    model: 'opencode/test',
    grading: {
      passed: true,
      command: 'node --test',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      outputDigest: digest('out'),
      outputExcerpt: '',
      checks: [],
    },
    usage: { inputTokens: 10, outputTokens: 5 },
    behaviour: { toolCalls: 2, repeatedFileReads: 1 },
    containment: { guard: 'loaded', rootKnown: true, blockedCalls: 0, allowedCalls: 2, blockedByTool: {} },
    inSessionGovernor: {
      armed: true,
      capUsd: 0.5,
      polls: 3,
      interrupted: false,
      interruptAttempts: 0,
      killedAfterFailedInterrupt: false,
    },
    wire: { source: 'none', requests: [], hookInvocations: 2, unmeasurableRequests: 0 },
    ...overrides,
  };
}

const text = (value: unknown): string => JSON.stringify(value);

describe('arm artifact provenance', () => {
  it('accepts this run\u2019s own, complete output', () => {
    const verdict = checkArmArtifactProvenance({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: text(artifact()),
      expectedRunNonce: NONCE,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.invalidReason).toBeUndefined();
    expect(verdict.parsed).toBeDefined();
  });

  it('refuses a run whose driver exited non-zero, whatever the artifact says', () => {
    // The exact Stage 1V shape: the driver crashed, and a perfectly formed artifact from an
    // earlier run sat at the path. The exit code is checked first, so it cannot be read.
    const verdict = checkArmArtifactProvenance({
      driverExitCode: 1,
      artifactPreexisting: true,
      artifactText: text(artifact()),
      expectedRunNonce: NONCE,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.invalidReason).toBe('driver-exit-nonzero');
    expect(verdict.parsed).toBeUndefined();
    expect(verdict.problems.join(' ')).toContain('did not complete');
  });

  it('refuses a driver that never started', () => {
    const verdict = checkArmArtifactProvenance({
      driverExitCode: undefined,
      artifactPreexisting: false,
      artifactText: undefined,
      expectedRunNonce: NONCE,
    });
    expect(verdict.invalidReason).toBe('driver-exit-nonzero');
  });

  it('refuses a missing artifact, an unreadable one and an incomplete one', () => {
    const missing = checkArmArtifactProvenance({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: undefined,
      expectedRunNonce: NONCE,
    });
    expect(missing.invalidReason).toBe('artifact-missing');

    const unreadable = checkArmArtifactProvenance({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: '{"schemaVersion":1,"taskId":"repeated-reads',
      expectedRunNonce: NONCE,
    });
    expect(unreadable.invalidReason).toBe('artifact-unreadable');

    // A truncation that lands on a valid JSON prefix parses cleanly, which is why the
    // completion flag is required rather than inferred from parseability.
    const partial = checkArmArtifactProvenance({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: text(artifact({ complete: undefined })),
      expectedRunNonce: NONCE,
    });
    expect(partial.invalidReason).toBe('artifact-incomplete');
  });

  it('refuses another run\u2019s artifact, however well-formed it is', () => {
    const stale = checkArmArtifactProvenance({
      driverExitCode: 0,
      artifactPreexisting: true,
      artifactText: text(artifact({ runNonce: 'a-previous-run' })),
      expectedRunNonce: NONCE,
    });
    expect(stale.ok).toBe(false);
    expect(stale.invalidReason).toBe('artifact-foreign');
    // The reused workspace is reported, so the reason is visible rather than inferred.
    expect(stale.problems.join(' ')).toContain('reused between runs');
  });

  it('does not call a fresh nonce a match when the artifact is not an object', () => {
    const verdict = checkArmArtifactProvenance({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: '"not-an-artifact"',
      expectedRunNonce: NONCE,
    });
    expect(verdict.invalidReason).toBe('artifact-invalid');
  });
});

describe('arm evidence intake', () => {
  const intake = (overrides: Record<string, unknown> = {}, extra: Partial<Parameters<typeof intakeArmEvidence>[0]> = {}) =>
    intakeArmEvidence({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: text(artifact(overrides)),
      expectedRunNonce: NONCE,
      expected,
      ...extra,
    });

  it('accepts a matched run and returns its observation', () => {
    const outcome = intake();
    expect(outcome.accepted).toBe(true);
    expect(outcome.invalidReason).toBeUndefined();
    expect(outcome.observation?.taskId).toBe(TASK_ID);
    expect(outcome.observation?.inSessionGovernor?.armed).toBe(true);
  });

  it('refuses an artifact labelled for a different task, arm or pair', () => {
    const wrongTask = intake({ taskId: 'other-task' });
    expect(wrongTask.accepted).toBe(false);
    expect(wrongTask.invalidReason).toBe('artifact-invalid');
    expect(wrongTask.observation).toBeUndefined();
    expect(wrongTask.problems.join(' ')).toContain('not "repeated-reads-catalogue"');
  });

  it('refuses a run whose artifact shows the runtime refused the model', () => {
    const refused = intake({ modelUnavailable: true, model: undefined, usage: {} });
    expect(refused.accepted).toBe(false);
    expect(refused.invalidReason).toBe('model-unavailable');
    expect(refused.modelUnavailable).toBe(true);
    // A refused session must not be published as a run that measured zero tokens.
    expect(refused.observation).toBeUndefined();
  });

  it('never accepts a foreign artifact, even when every other field is perfect', () => {
    const outcome = intake({ runNonce: 'someone-elses-run' });
    expect(outcome.accepted).toBe(false);
    expect(outcome.invalidReason).toBe('artifact-foreign');
  });
});

describe('the engagement gate on a capped live session', () => {
  const armed = (armedValue: boolean): Level2InSessionGovernorEvidence => ({
    armed: armedValue,
    reason: armedValue ? undefined : 'the built plugin module does not export the governor helpers (missing: startCostGovernor)',
    capUsd: 0.5,
    polls: 4,
    reportedCostUsd: 0.01,
    interrupted: false,
    interruptAttempts: 0,
    killedAfterFailedInterrupt: false,
  });

  it('refuses a capped session whose governor did not enforce the cap', () => {
    const observation = syntheticObservation({
      arm: 'treatment',
      taskPassed: true,
      inputTokens: 10,
      outputTokens: 5,
      inSessionGovernor: armed(false),
    });
    const verdict = checkLiveEngagement(observation, { requireInSessionGovernor: true });
    expect(verdict.measurable).toBe(false);
    expect(verdict.stop).toBe(true);
    expect(verdict.detail).toContain('startCostGovernor');
    expect(verdict.detail).toContain('not in force');
  });

  it('refuses a capped session that records no governor evidence at all', () => {
    // The fixture defaults an omitted override to "not a live session", so absence is
    // expressed by removing the field: an artifact written before the governor existed.
    const observation: Level2ArmObservation = {
      ...syntheticObservation({
        arm: 'control',
        taskPassed: true,
        inputTokens: 10,
        outputTokens: 5,
      }),
      inSessionGovernor: undefined,
    };
    const verdict = checkLiveEngagement(observation, { requireInSessionGovernor: true });
    expect(verdict.measurable).toBe(false);
    expect(verdict.detail).toContain('no governor evidence');
  });

  it('accepts a capped session whose governor armed and enforced it', () => {
    const observation = syntheticObservation({
      arm: 'treatment',
      taskPassed: true,
      inputTokens: 10,
      outputTokens: 5,
      inSessionGovernor: armed(true),
    });
    const verdict = checkLiveEngagement(observation, { requireInSessionGovernor: true });
    expect(verdict.measurable).toBe(true);
    expect(verdict.stop).toBe(false);
  });

  it('does not demand a governor when no cap was configured', () => {
    // A rehearsal or an uncapped live run has no in-session bound to require, so the same
    // observation is measurable there — the requirement is about the authorized bound, not
    // about the governor existing for its own sake.
    const observation = syntheticObservation({
      arm: 'control',
      taskPassed: false,
      inputTokens: 10,
      outputTokens: 5,
      inSessionGovernor: armed(false),
    });
    expect(checkLiveEngagement(observation).measurable).toBe(true);
  });
});
