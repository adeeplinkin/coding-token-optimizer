/**
 * Offline verification of the Level 2 apparatus.
 *
 * Everything here runs without a model, a credential or a network call, and it is
 * the part of Level 2 that can be *proved* before any authorization: that the task
 * repositories are reproducible, that the grader accepts a correct solution and
 * rejects a wrong one, that editing the repository's tests gains an agent nothing,
 * that the plan meets the design's minimum samples and alternates its order, and
 * that the declared-variant contract compares the pair instead of refusing it —
 * while still refusing a swapped arm or a treatment failure.
 *
 * The one thing it cannot verify is the live path: which model, which provider, and
 * what the host reports for tokens. That is exactly what the authorization gate is
 * for.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareRuns } from '../comparison.js';
import { isAvailable } from '../measurement.js';
import { buildPlan, MIN_PAIRS_PER_TASK, MIN_TASKS, validatePlan, type Level2Plan } from './plan.js';
import { gradeTask } from './grade.js';
import {
  applyFiles,
  digest,
  provisionTaskRepo,
  removeRepo,
  repoRevision,
  weakenGradedFiles,
} from './repos.js';
import { buildArmRunRecord } from './records.js';
import { checkLiveEngagement } from './engagement.js';
import { intakeArmEvidence } from './intake.js';
import { buildExperiment, renderLevel2Markdown } from './report.js';
import { findTask, LEVEL2_TASKS } from './tasks.js';
import { resolveLevel2Declaration } from './variants.js';
import type {
  Level2ArmObservation,
  Level2ContainmentEvidence,
  Level2InSessionGovernorEvidence,
  Level2Task,
  Level2TaskCategory,
} from './types.js';

const run = promisify(execFile);

/** One verification check. */
export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** Result of the offline verification. */
export interface OfflineVerificationResult {
  readonly checks: readonly VerificationCheck[];
  readonly failures: readonly string[];
}

function check(name: string, passed: boolean, detail: string): VerificationCheck {
  return { name, passed, detail };
}

/**
 * A synthetic arm observation, used to exercise the comparison contract without
 * running a model.
 *
 * It is deliberately *shaped* like a real one (declared variant provenance, per-field
 * usage, a mechanism classification) so that the contract checks fail if the mapping
 * in `records.ts` regresses, rather than passing because a fixture is simpler than
 * reality.
 */
export function syntheticObservation(options: {
  readonly arm: 'control' | 'treatment';
  readonly taskId?: string;
  readonly pairIndex?: number;
  readonly taskPassed: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly mechanism?: 'fired' | 'no-opportunity';
  readonly promptHash?: string;
  readonly repositoryRevision?: string;
  /** Override the containment evidence; defaults to a registered guard. */
  readonly containment?: Level2ContainmentEvidence | undefined;
  /** Override the governor evidence; defaults to "not a live session". */
  readonly inSessionGovernor?: Level2InSessionGovernorEvidence | undefined;
}): Level2ArmObservation {
  const control = options.arm === 'control';
  const mechanism =
    options.mechanism ?? (control ? 'not-applicable' : 'fired');
  const elidedBytes = 512;
  const markerBytes = 48;
  const apply = control
    ? undefined
    : mechanism === 'fired'
      ? {
          requestsAttempted: 2,
          requestsApplied: 1,
          elidedOccurrences: 1,
          elidedBytes,
          markerBytes,
        }
      : { requestsAttempted: 2, requestsApplied: 0, elidedOccurrences: 0, elidedBytes: 0, markerBytes: 0 };
  const markers = !control && mechanism === 'fired' ? 1 : 0;

  return {
    identity: {
      taskId: options.taskId ?? 'read-and-edit-total',
      arm: options.arm,
      runId: `${options.taskId ?? 'read-and-edit-total'}:p${options.pairIndex ?? 0}:${options.arm}`,
      pairIndex: options.pairIndex ?? 0,
      attempt: 1,
    },
    taskId: options.taskId ?? 'read-and-edit-total',
    model: 'synthetic/verify',
    harness: 'opencode-coding-task',
    optimizerRevision: '0.0.0',
    repositoryRevision: options.repositoryRevision ?? digest('synthetic-repo'),
    promptHash: options.promptHash ?? digest('synthetic-prompt'),
    startedAt: control ? '2026-10-11T00:00:00.000Z' : '2026-10-11T00:00:01.000Z',
    durationMs: 1_000,
    grading: {
      passed: options.taskPassed,
      command: 'node --test',
      exitCode: options.taskPassed ? 0 : 1,
      timedOut: false,
      durationMs: 500,
      outputDigest: digest(`grading-${options.arm}-${String(options.taskPassed)}`),
      outputExcerpt: options.taskPassed ? 'tests passed' : 'tests failed',
      checks: [
        { name: 'graded-files-restored', passed: true, detail: 'restored' },
        { name: 'test-command-ran', passed: true, detail: 'ran' },
        {
          name: 'task-acceptance',
          passed: options.taskPassed,
          detail: options.taskPassed ? 'passed' : 'failed',
        },
      ],
    },
    usage: {
      inputTokens: options.inputTokens,
      outputTokens: options.outputTokens,
      cacheReadTokens: options.cacheReadTokens ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: undefined,
      costUsd: undefined,
    },
    behaviour: {
      toolCalls: 4,
      repeatedFileReads: 1,
      assistantMessages: 3,
      observerInternalErrors: 0,
      optimizerErrors: 0,
      recoveryAttempts: 0,
    },
    apply,
    wire: {
      // Shaped like a rehearsal's evidence: measured at the loopback endpoint the run
      // was pointed at, which is the only place a real request length is observable.
      source: 'loopback-endpoint',
      requests: [
        { seq: 0, bodyBytes: 1_000, markerCount: 0 },
        { seq: 1, bodyBytes: 1_500 - (control ? 0 : elidedBytes - markerBytes), markerCount: markers },
      ],
      hookInvocations: 2,
      unmeasurableRequests: 0,
      allRequestsToProvider: true,
    },
    // Shaped like a session whose guard registered and whose workspace was known:
    // the shape every live arm must have before its numbers may be compared.
    containment:
      options.containment === undefined
        ? {
            guard: 'loaded',
            rootKnown: true,
            blockedCalls: 0,
            allowedCalls: 3,
            blockedByTool: {},
            permissionRules: [
              { action: 'shell', effect: 'deny', resource: 'any' },
              { action: 'external_directory', effect: 'deny', resource: 'any' },
            ],
            configDigest: digest('synthetic-containment-config'),
          }
        : options.containment,
    inSessionGovernor:
      options.inSessionGovernor === undefined
        ? {
            armed: false,
            reason: 'not a live session',
            capUsd: undefined,
            polls: 0,
            reportedCostUsd: undefined,
            interrupted: false,
            interruptAttempts: 0,
            killedAfterFailedInterrupt: false,
          }
        : options.inSessionGovernor,
    mechanism,
  };
}

/**
 * Run every offline check.
 *
 * The repositories are created under `workRoot` and removed again, so the check
 * leaves nothing behind but the report lines it returns.
 */
export async function runOfflineVerification(options: {
  readonly workRoot: string;
  readonly tasks?: readonly Level2Task[];
  readonly plan?: Level2Plan;
  readonly onProgress?: (line: string) => void;
}): Promise<OfflineVerificationResult> {
  const tasks = options.tasks ?? LEVEL2_TASKS;
  const plan =
    options.plan ??
    buildPlan({ pairsPerTask: MIN_PAIRS_PER_TASK, tasks, declarationFingerprint: resolveLevel2Declaration().fingerprint });
  const checks: VerificationCheck[] = [];
  const report = options.onProgress ?? (() => {});

  /* Plan: minimum samples and ordering. */
  const planProblems = validatePlan(plan);
  checks.push(
    check(
      'plan-minimum-samples',
      planProblems.length === 0,
      planProblems.length === 0
        ? `${plan.tasks.length} task(s), ${plan.pairsTotal} pair(s), ${plan.armRunsTotal} arm run(s); at least ${MIN_TASKS} tasks and ${MIN_PAIRS_PER_TASK} pairs per task, ordered ABBA.`
        : planProblems.join(' '),
    ),
  );

  const firstPairOrder = plan.runs
    .filter((entry) => entry.taskId === plan.tasks[0] && entry.pairIndex === 0)
    .map((entry) => entry.arm);
  const secondPairOrder = plan.runs
    .filter((entry) => entry.taskId === plan.tasks[0] && entry.pairIndex === 1)
    .map((entry) => entry.arm);
  checks.push(
    check(
      'plan-alternates-order',
      firstPairOrder[0] === 'control' && secondPairOrder[0] === 'treatment',
      `pair 0 runs ${firstPairOrder.join(' then ')}; pair 1 runs ${secondPairOrder.join(' then ')}`,
    ),
  );

  /* Task repositories: reproducibility, and a grader that can be trusted. */
  for (const task of tasks) {
    const root = `${options.workRoot}/${task.id}`;
    try {
      /* Reproducible: the same pack always produces the same revision identity. */
      const revision = repoRevision(task.files);
      await provisionTaskRepo(`${root}-a`, task);
      await provisionTaskRepo(`${root}-b`, task);
      const revisionAgain = repoRevision(task.files);
      checks.push(
        check(
          `${task.id}:repository-reproducible`,
          revision === revisionAgain && revision.length === 64,
          `revision ${revision.slice(0, 12)}…`,
        ),
      );

      /* The starting state must not already pass, or the task measures nothing. */
      const initial = await gradeTask(task, `${root}-a`);
      checks.push(
        check(
          `${task.id}:initial-state-fails`,
          !initial.passed,
          initial.passed
            ? 'The task\u2019s own tests already pass in the starting state, so the task cannot measure a coding change.'
            : `The starting state fails as intended (exit ${String(initial.exitCode)}).`,
        ),
      );

      /* A correct solution must be accepted. */
      await applyFiles(`${root}-a`, task.goldenFiles);
      const golden = await gradeTask(task, `${root}-a`);
      checks.push(
        check(
          `${task.id}:golden-solution-passes`,
          golden.passed,
          golden.passed
            ? 'The grader accepts the correct solution.'
            : `The grader rejected the correct solution (exit ${String(golden.exitCode)}): ${golden.outputExcerpt.slice(0, 200)}`,
        ),
      );

      /* A plausible wrong solution must be rejected. */
      await provisionTaskRepo(`${root}-b`, task);
      await applyFiles(`${root}-b`, task.brokenFiles);
      const broken = await gradeTask(task, `${root}-b`);
      checks.push(
        check(
          `${task.id}:wrong-solution-fails`,
          !broken.passed,
          broken.passed
            ? 'The grader accepted a wrong solution, so it does not measure correctness.'
            : `The grader rejected the wrong solution (exit ${String(broken.exitCode)}).`,
        ),
      );

      /* Editing the repository's tests must not help. */
      await provisionTaskRepo(`${root}-b`, task);
      await weakenGradedFiles(`${root}-b`, task);
      const cheating = await gradeTask(task, `${root}-b`);
      checks.push(
        check(
          `${task.id}:weakened-tests-still-fail`,
          !cheating.passed,
          cheating.passed
            ? 'An agent that replaces the tests with trivially passing ones would be graded as successful.'
            : 'Replacing the graded tests with trivially passing ones does not produce a pass, because grading restores the pristine copies.',
        ),
      );
      const restoreCheck = cheating.checks.find((entry) => entry.name === 'graded-files-restored');
      checks.push(
        check(
          `${task.id}:graded-files-restored`,
          restoreCheck?.passed === true,
          restoreCheck?.detail ?? 'The grader did not report a restore check.',
        ),
      );
    } finally {
      await removeRepo(`${root}-a`);
      await removeRepo(`${root}-b`);
    }
    report(`${task.id}: repository and grader verified`);
  }

  /* The declared-variant contract, exercised directly. */
  const declaration = resolveLevel2Declaration();
  const controlObservation = syntheticObservation({ arm: 'control', taskPassed: true, inputTokens: 1_000, outputTokens: 200 });
  const treatmentObservation = syntheticObservation({ arm: 'treatment', taskPassed: true, inputTokens: 900, outputTokens: 200 });

  const comparable = compareRuns(
    buildArmRunRecord(controlObservation, declaration.declaration),
    buildArmRunRecord(treatmentObservation, declaration.declaration),
  );
  checks.push(
    check(
      'contract:declared-pair-is-comparable',
      comparable.verdict !== 'invalid',
      `The declared control/treatment pair compared as "${comparable.verdict}" rather than being refused. (The total-token verdict is "unavailable" by construction: the host publishes no session total, and per-field values are reported separately.)`,
    ),
  );

  const regressed = compareRuns(
    buildArmRunRecord(controlObservation, declaration.declaration),
    buildArmRunRecord(
      syntheticObservation({ arm: 'treatment', taskPassed: false, inputTokens: 900, outputTokens: 200 }),
      declaration.declaration,
    ),
  );
  checks.push(
    check(
      'contract:treatment-failure-is-a-regression',
      regressed.correctnessRegression && regressed.verdict === 'regression',
      `A treatment run that fails the task is reported as "${regressed.verdict}" (correctnessRegression=${String(regressed.correctnessRegression)}).`,
    ),
  );

  const swapped = compareRuns(
    buildArmRunRecord(
      syntheticObservation({ arm: 'treatment', taskPassed: true, inputTokens: 900, outputTokens: 200 }),
      declaration.declaration,
    ),
    buildArmRunRecord(controlObservation, declaration.declaration),
  );
  checks.push(
    check(
      'contract:swapped-arms-are-refused',
      swapped.verdict === 'invalid',
      `Feeding the treatment run as the baseline is reported as "${swapped.verdict}".`,
    ),
  );

  const drift = compareRuns(
    buildArmRunRecord(controlObservation, declaration.declaration),
    buildArmRunRecord(
      syntheticObservation({
        arm: 'treatment',
        taskPassed: true,
        inputTokens: 900,
        outputTokens: 200,
        promptHash: digest('a different instruction'),
      }),
      declaration.declaration,
    ),
  );
  checks.push(
    check(
      'contract:prompt-drift-invalidates-the-pair',
      drift.verdict === 'invalid',
      `A treatment run with a different instruction hash is reported as "${drift.verdict}".`,
    ),
  );

  const experiment = buildExperiment([controlObservation, treatmentObservation], plan, tasks, [
    {
      taskId: controlObservation.taskId,
      pairIndex: 0,
      arm: 'control',
      disposition: 'solved',
      detail: 'graded outside the session',
    },
    {
      taskId: controlObservation.taskId,
      pairIndex: 0,
      arm: 'treatment',
      disposition: 'unavailable-evidence',
      detail: 'the host reported no token field',
    },
  ]);
  const inputField = experiment.tasks
    .find((task) => task.taskId === controlObservation.taskId)
    ?.fields.find((field) => field.field === 'inputTokens');
  checks.push(
    check(
      'report:per-field-deltas-are-computed',
      inputField !== undefined && isAvailable(inputField.delta) && inputField.delta.value.median === -100,
      inputField === undefined || !isAvailable(inputField.delta)
        ? 'No input-token delta was computed for a fired pair.'
        : `Median input delta ${inputField.delta.value.median} over ${inputField.delta.value.samples} pair(s).`,
    ),
  );

  const countersOnly = compareRuns(
    buildArmRunRecord(controlObservation, declaration.declaration),
    buildArmRunRecord(
      {
        ...treatmentObservation,
        wire: { ...treatmentObservation.wire, source: 'hook-unmeasurable', requests: [], hookInvocations: 2 },
        mechanism: 'fired-counters-only',
      },
      declaration.declaration,
    ),
  );
  checks.push(
    check(
      'contract:live-mode-is-labelled-rather-than-overclaimed',
      countersOnly.verdict !== 'invalid',
      'A run with no wire observation still compares, and its mechanism verdict is `fired-counters-only` rather than the observed-marker case.',
    ),
  );

  const markdown = renderLevel2Markdown(experiment, {
    model: 'synthetic/verify',
    harness: 'opencode-coding-task',
    pairsPerTask: plan.pairsPerTask,
    generatedAt: '2026-10-11T00:00:00.000Z',
  });
  const rendersSections =
    markdown.includes('## Per task') && markdown.includes('## What this report establishes');
  const carriesNoMarker = !markdown.includes('safe-mode/v1:');
  checks.push(
    check(
      'report:renders-without-content',
      rendersSections && carriesNoMarker,
      !rendersSections
        ? 'The report did not render its mandatory sections.'
        : carriesNoMarker
          ? 'The report renders its mandatory sections and carries no request content.'
          : 'The report contains Safe Mode marker text, which is request content.',
    ),
  );

  /*
   * Measurement integrity, exercised directly: the four ways a run can fail to be a
   * measurement, and the one shape that must still be accepted. These are the same
   * rejections the unit tests pin; keeping them in the offline gate means `level2:verify`
   * fails if any of them regresses, not only `npm test`.
   */
  const artifactFor = (runNonce: string, complete: boolean): Record<string, unknown> => ({
    taskId: controlObservation.taskId,
    arm: 'control',
    runId: controlObservation.identity.runId,
    runNonce,
    complete,
    pairIndex: 0,
    attempt: 1,
    startedAt: controlObservation.startedAt,
    durationMs: controlObservation.durationMs,
    harness: controlObservation.harness,
    optimizerRevision: controlObservation.optimizerRevision,
    repositoryRevision: controlObservation.repositoryRevision,
    promptHash: controlObservation.promptHash,
    model: controlObservation.model,
    grading: {
      passed: true,
      command: 'node --test',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      outputDigest: digest('intake-grading'),
      outputExcerpt: '',
      checks: [],
    },
    usage: { inputTokens: 1_000, outputTokens: 200 },
    behaviour: { toolCalls: 4, repeatedFileReads: 1 },
    containment: controlObservation.containment,
    inSessionGovernor: controlObservation.inSessionGovernor,
    wire: { source: 'none', requests: [], hookInvocations: 2, unmeasurableRequests: 0 },
  });
  const intakeExpected = {
    taskId: controlObservation.taskId,
    arm: 'control' as const,
    pairIndex: controlObservation.identity.pairIndex,
  };
  const intakeOf = (options: {
    readonly driverExitCode: number | undefined;
    readonly artifactPreexisting: boolean;
    readonly artifactText: string | undefined;
    readonly expectedRunNonce: string;
  }) => intakeArmEvidence({ ...options, expected: intakeExpected });

  const intakeAccepted = intakeOf({
    driverExitCode: 0,
    artifactPreexisting: false,
    artifactText: JSON.stringify(artifactFor('nonce-a', true)),
    expectedRunNonce: 'nonce-a',
  });
  checks.push(
    check(
      'intake:accepted-run-keeps-its-observation',
      intakeAccepted.accepted && intakeAccepted.observation !== undefined,
      intakeAccepted.accepted
        ? 'A complete artifact carrying this run\u2019s own nonce was accepted and produced an observation.'
        : `A valid artifact was refused (${intakeAccepted.invalidReason ?? 'no reason'}), so the checks below would pass vacuously.`,
    ),
  );

  const intakeCrashed = intakeOf({
    driverExitCode: 1,
    artifactPreexisting: true,
    artifactText: JSON.stringify(artifactFor('nonce-a', true)),
    expectedRunNonce: 'nonce-a',
  });
  checks.push(
    check(
      'intake:crashed-driver-is-refused-even-with-a-perfect-artifact',
      !intakeCrashed.accepted &&
        intakeCrashed.invalidReason === 'driver-exit-nonzero' &&
        intakeCrashed.observation === undefined,
      `A non-zero driver exit is ${intakeCrashed.accepted ? 'accepted' : `refused as ${intakeCrashed.invalidReason ?? 'unknown'}`} rather than reported as a measurement.`,
    ),
  );

  const intakeStale = intakeOf({
    driverExitCode: 0,
    artifactPreexisting: true,
    artifactText: JSON.stringify(artifactFor('a-previous-run', true)),
    expectedRunNonce: 'nonce-a',
  });
  checks.push(
    check(
      'intake:stale-artifact-is-refused',
      !intakeStale.accepted && intakeStale.invalidReason === 'artifact-foreign',
      `An artifact left by an earlier run at the reused path is ${intakeStale.accepted ? 'accepted' : `refused as ${intakeStale.invalidReason ?? 'unknown'}`}.`,
    ),
  );

  const intakePartial = intakeOf({
    driverExitCode: 0,
    artifactPreexisting: false,
    artifactText: JSON.stringify(artifactFor('nonce-a', false)),
    expectedRunNonce: 'nonce-a',
  });
  checks.push(
    check(
      'intake:partial-artifact-is-refused',
      !intakePartial.accepted && intakePartial.invalidReason === 'artifact-incomplete',
      `An artifact with no completion flag is ${intakePartial.accepted ? 'accepted' : `refused as ${intakePartial.invalidReason ?? 'unknown'}`}.`,
    ),
  );

  const governorGate = checkLiveEngagement(
    {
      ...controlObservation,
      inSessionGovernor: {
        armed: false,
        reason: 'the built plugin module does not export the governor helpers (missing: startCostGovernor)',
        capUsd: 0.5,
        polls: 0,
        reportedCostUsd: undefined,
        interrupted: false,
        interruptAttempts: 0,
        killedAfterFailedInterrupt: false,
      },
    },
    { requireInSessionGovernor: true },
  );
  checks.push(
    check(
      'engagement:capped-session-without-a-governor-is-refused',
      !governorGate.measurable && governorGate.stop,
      governorGate.measurable
        ? 'A capped session whose governor never armed was accepted as measurable.'
        : 'A capped session whose governor never armed is refused rather than compared.',
    ),
  );

  checks.push(
    check(
      'report:distinguishes-dispositions',
      markdown.includes('## Run dispositions') &&
        markdown.includes('unavailable-evidence') &&
        markdown.includes('`solved`'),
      'The report lists every planned run\u2019s disposition, separating solved, task-failed, invalid-measurement, unavailable-evidence and not-run.',
    ),
  );

  const failures = checks.filter((entry) => !entry.passed).map((entry) => entry.name);
  return { checks, failures };
}

/** Every task id in the pack, for callers that only need the names. */
export function taskIds(): readonly string[] {
  return LEVEL2_TASKS.map((task) => task.id);
}

/** Categories present in the pack, so a caller can check coverage. */
export function taskCategories(): readonly Level2TaskCategory[] {
  return LEVEL2_TASKS.map((task) => task.category);
}

/** Resolve one task by id, failing loudly rather than silently skipping. */
export function requireTask(id: string): Level2Task {
  const task = findTask(id);
  if (task === undefined) {
    throw new Error(`No Level 2 task named "${id}".`);
  }
  return task;
}

/** A shell-free way to run a command, kept for the live path's diagnostics. */
export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly status: number }> {
  try {
    const result = await run(command, [...args], { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), status: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
      status: typeof failure.code === 'number' ? failure.code : -1,
    };
  }
}
