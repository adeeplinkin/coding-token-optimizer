import { describe, expect, it } from 'vitest';
import {
  checkArmArtifactProvenance,
  checkLiveEngagement,
  checkModelGuard,
  digest,
  freeOnlyPolicyEvidence,
  intakeArmEvidence,
  modelGuardEvidence,
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
    // Which run mode produced this: a rehearsal's counts come from a script, so a caller that
    // asked for a live run must never read one.
    mode: 'live',
    // The session's own outcome: the arm ran to completion. A file that does not say so is
    // not a measurement, however well-formed the rest of it is.
    exitCode: 0,
    timedOut: false,
    sessionCleanExit: true,
    modelUnavailable: false,
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
    // The pre-transmission model guard: loaded, registered, nothing refused. A run that cannot show
    // its requests were bounded is refused as a measurement, because the provider restriction alone
    // admits every model that provider offers.
    modelGuard: modelGuardEvidence(),
    // The free-only envelope this run stayed inside: required, and re-derived from the artifact
    // rather than trusted. A paid session's numbers look exactly like a free one's, so a run that
    // cannot show its policy is refused rather than compared.
    modelPolicy: freeOnlyPolicyEvidence(),
    nativePermissions: {
      observed: true,
      source: 'api config.get --standalone',
      rules: [
        { action: 'external_directory', effect: 'deny', resource: 'any' },
        { action: 'shell', effect: 'deny', resource: 'any' },
        { action: 'subagent', effect: 'deny', resource: 'any' },
        { action: 'webfetch', effect: 'deny', resource: 'any' },
      ],
      requiredDenies: ['external_directory', 'shell', 'subagent', 'webfetch'],
      missingRequiredDenies: [],
      allRequiredPresent: true,
    },
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

describe('the run-mode gate', () => {
  const withMode = (mode: unknown) =>
    checkArmArtifactProvenance({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: text(artifact({ mode })),
      expectedRunNonce: NONCE,
      expectedMode: 'live',
    });

  it('accepts an artifact whose declared mode is the mode that was asked for', () => {
    expect(withMode('live').ok).toBe(true);
  });

  it('refuses a rehearsal artifact offered as a live measurement', () => {
    // The rehearsal and the live run share a driver, plugins and artifact shape; only the
    // provider differs, and a scripted provider's counts are not a measurement.
    const verdict = withMode('rehearse');
    expect(verdict.ok).toBe(false);
    expect(verdict.invalidReason).toBe('mode-mismatch');
    expect(verdict.parsed).toBeUndefined();
    expect(verdict.problems.join(' ')).toContain('rehearse');
  });

  it('refuses an artifact that declares no mode at all', () => {
    expect(withMode(undefined).invalidReason).toBe('mode-mismatch');
  });
});

describe('the session-completion gate', () => {
  /** A complete artifact for this run, with the session's outcome overridden. */
  const session = (overrides: Record<string, unknown>) =>
    checkArmArtifactProvenance({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: text(artifact(overrides)),
      expectedRunNonce: NONCE,
    });

  it('accepts a session that ran to completion', () => {
    const verdict = session({});
    expect(verdict.ok).toBe(true);
    expect(verdict.parsed).toBeDefined();
  });

  it('refuses a session whose runtime process exited non-zero', () => {
    // The driver exits 0 whenever it wrote a whole artifact, so a killed or crashed session
    // still arrives as a complete file; its counters describe a partial run.
    const verdict = session({ exitCode: 1, sessionCleanExit: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.invalidReason).toBe('session-exit-nonzero');
    expect(verdict.parsed).toBeUndefined();
    expect(verdict.problems.join(' ')).toContain('did not run to completion');
  });

  it('refuses a session the wall-clock bound stopped', () => {
    const verdict = session({ timedOut: true, sessionCleanExit: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.invalidReason).toBe('session-timed-out');
    expect(verdict.problems.join(' ')).toContain('wall-clock');
  });

  it('refuses an artifact that never states the session outcome', () => {
    const absent = session({ exitCode: undefined, sessionCleanExit: undefined });
    expect(absent.ok).toBe(false);
    expect(absent.invalidReason).toBe('session-outcome-unrecorded');

    // A zero exit that is not affirmed as a clean session is the same missing statement.
    const unaffirmed = session({ exitCode: 0, sessionCleanExit: undefined });
    expect(unaffirmed.invalidReason).toBe('session-outcome-unrecorded');
  });

  it('leaves the runtime\u2019s model refusal to the intake\u2019s own rule', () => {
    // A refusal is an environment to fix, not a session that went wrong; the gate defers so
    // the reason is reported with its own name, and that rule still refuses the run.
    const verdict = session({ modelUnavailable: true, exitCode: 1, sessionCleanExit: false });
    expect(verdict.ok).toBe(true);
    const outcome = intakeArmEvidence({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: text(artifact({ modelUnavailable: true, exitCode: 1, sessionCleanExit: false })),
      expectedRunNonce: NONCE,
      expected,
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.invalidReason).toBe('model-unavailable');
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

  /**
   * The pre-transmission model guard, at the gate that decides what may be published.
   *
   * The free-only policy tells the reader what the run was *configured* to do; this tells it whether
   * that configuration was *enforced* on the one channel that could still step outside it. The two
   * are separate refusals on purpose — a run can be configured perfectly and still fail here, which is
   * what the last case below says.
   */
  it('refuses a run that cannot show an unapproved model request would have been stopped', () => {
    const absent = intake({ modelGuard: undefined });
    expect(absent.accepted).toBe(false);
    expect(absent.invalidReason).toBe('model-guard-unverified');
    expect(absent.observation).toBeUndefined();
    expect(absent.problems.join(' ')).toContain('pre-transmission model-guard evidence');

    const unregistered = intake({
      modelGuard: { ...modelGuardEvidence(), hookRegistered: false },
    });
    expect(unregistered.accepted).toBe(false);
    expect(unregistered.invalidReason).toBe('model-guard-unverified');
    expect(unregistered.problems.join(' ')).toContain('did not register the request hook');

    // A driver cannot make an unregistered guard look armed by labelling it: the flag is recomputed
    // from the two facts the guard reports, never read from the artifact's own summary.
    const labelled = checkModelGuard({
      ...artifact(),
      modelGuard: { ...modelGuardEvidence(), guard: 'loaded', hookRegistered: false },
    });
    expect(labelled.ok).toBe(false);
    expect(labelled.invalidReason).toBe('model-guard-unverified');
  });

  it('refuses a run whose session attempted a request outside the envelope', () => {
    // Nothing was sent — that is what the guard is for — and the run is refused all the same: a
    // session that tried to leave the envelope is not the free-only session the experiment measures.
    const attempted = intake({
      modelGuard: {
        ...modelGuardEvidence(),
        refused: 1,
        refusals: [{ requestKind: 'primary', model: 'opencode/exo-free', reason: 'model-not-approved' }],
      },
    });
    expect(attempted.accepted).toBe(false);
    expect(attempted.invalidReason).toBe('model-guard-unverified');
    expect(attempted.problems.join(' ')).toContain('model-not-approved@primary[opencode/exo-free]');
  });

  it('refuses a guard that bounded a different policy than the run was configured with', () => {
    const mismatched = intake({
      modelGuard: { ...modelGuardEvidence(), policyDigest: digest('another-policy') },
    });
    expect(mismatched.accepted).toBe(false);
    expect(mismatched.invalidReason).toBe('model-guard-unverified');
    expect(mismatched.problems.join(' ')).toContain('enforced envelope');

    // The positive control: the same artifact, with the guard block the driver actually writes.
    expect(intake({}).accepted).toBe(true);
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

  it('refuses a run whose native permission layer was never observed', () => {
    // Containment has two layers. The guard's enforcement is proven against the installed
    // runtime; the runtime's own permission policy is evidenced by asking it what it resolved.
    const observation: Level2ArmObservation = {
      ...syntheticObservation({ arm: 'control', taskPassed: true, inputTokens: 10, outputTokens: 5 }),
      nativePermissions: undefined,
    };
    const verdict = checkLiveEngagement(observation, { requireNativePermissions: true });
    expect(verdict.measurable).toBe(false);
    expect(verdict.stop).toBe(true);
    expect(verdict.detail).toContain('native permission layer');
  });

  it('refuses a run whose runtime reported rules but not every required deny', () => {
    const observation = syntheticObservation({
      arm: 'control',
      taskPassed: true,
      inputTokens: 10,
      outputTokens: 5,
      nativePermissions: {
        observed: true,
        source: 'api config.get --standalone',
        rules: [
          { action: 'external_directory', effect: 'deny', resource: 'any' },
          { action: 'shell', effect: 'deny', resource: 'any' },
        ],
        requiredDenies: ['external_directory', 'shell', 'subagent', 'webfetch'],
        missingRequiredDenies: ['subagent', 'webfetch'],
        allRequiredPresent: false,
        error: undefined,
      },
    });
    const verdict = checkLiveEngagement(observation, { requireNativePermissions: true });
    expect(verdict.measurable).toBe(false);
    expect(verdict.detail).toContain('subagent');
  });

  it('refuses a run whose runtime reported no permission rule at all', () => {
    const observation = syntheticObservation({
      arm: 'control',
      taskPassed: true,
      inputTokens: 10,
      outputTokens: 5,
      nativePermissions: {
        observed: false,
        source: 'api config.get --standalone',
        rules: [],
        requiredDenies: ['external_directory', 'shell', 'subagent', 'webfetch'],
        missingRequiredDenies: [],
        allRequiredPresent: false,
        error: 'the runtime resolved no permission rule for this repository',
      },
    });
    const verdict = checkLiveEngagement(observation, { requireNativePermissions: true });
    expect(verdict.measurable).toBe(false);
    expect(verdict.detail).toContain('resolved no permission rule');
  });

  it('recomputes the native verdict instead of believing the artifact\u2019s own flag', () => {
    // An artifact that claims every required deny was resolved while reporting one rule is a
    // claim, not evidence: the reader recomputes it, and the gate then refuses the run.
    const outcome = intakeArmEvidence({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: text(
        artifact({
          nativePermissions: {
            observed: true,
            source: 'api config.get --standalone',
            rules: [{ action: 'external_directory', effect: 'deny', resource: 'any' }],
            requiredDenies: ['external_directory', 'shell', 'subagent', 'webfetch'],
            missingRequiredDenies: [],
            allRequiredPresent: true,
          },
        }),
      ),
      expectedRunNonce: NONCE,
      expected,
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.observation?.nativePermissions?.allRequiredPresent).toBe(false);
    const verdict = checkLiveEngagement(outcome.observation as Level2ArmObservation, {
      requireNativePermissions: true,
    });
    expect(verdict.measurable).toBe(false);
  });

  it('accepts a run whose runtime reported every required deny', () => {
    const verdict = checkLiveEngagement(
      syntheticObservation({ arm: 'control', taskPassed: true, inputTokens: 10, outputTokens: 5 }),
      { requireNativePermissions: true },
    );
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
