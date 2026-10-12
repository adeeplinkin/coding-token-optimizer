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
import { liveRunRefusals } from './guards.js';
import { runArmSequence } from './sequence.js';
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
import {
  FREE_ONLY_APPROVED_MODELS,
  FREE_ONLY_AUXILIARY_MODEL,
  FREE_ONLY_PRIMARY_MODEL,
  MODEL_REQUEST_HOOK,
  PRIMARY_REQUEST_KIND,
  REQUEST_KINDS,
  approvedModelRefusals,
  auxiliaryRequestKinds,
  freeOnlyModelConfig,
  freeOnlyModelConfigDigest,
  endpointModelIds,
  freeOnlyPriceRefusals,
  isApprovedEndpointModel,
  isFreeOnlyModelConfig,
  resolvedPolicyRefusals,
} from './free-model-policy.js';
import { hasNoReportedUsage, createBudgetTracker, reportedCostUsd } from './budget.js';
import { findTask, LEVEL2_TASKS } from './tasks.js';
import { resolveLevel2Declaration } from './variants.js';
import type {
  Level2ArmObservation,
  Level2ContainmentEvidence,
  Level2InSessionGovernorEvidence,
  Level2ModelGuardEvidence,
  Level2ModelPolicyEvidence,
  Level2NativePermissionsEvidence,
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
 * The wording every task prompt must carry: the session cannot run the suite itself.
 *
 * The canary denies the shell tool, so a prompt that told the agent to run the tests was an
 * instruction no session could obey — and an unobeyable instruction makes a coding outcome
 * unreadable. The prompts state the limit instead, and that grading happens outside the session.
 */
const NO_SHELL_STATEMENT = 'This session has no shell tool';

/**
 * A shell instruction in a task prompt: a backticked command, or a bare test invocation.
 *
 * Deliberately narrower than "a backticked word": the prompts name symbols and files that way
 * (`` `findEntry(entries, id)` ``, `` `total` ``, `` `parseRows` ``), and only a *command* is
 * forbidden. The positive control below exercises this against the wording the pack used to carry.
 */
const SHELL_INSTRUCTION_PATTERN =
  /`(?:node|npm|npx|pnpm|yarn|sh|bash|cmd|powershell|git|python)\b[^`]*`|\bnode --test\b|\bnpm (?:test|run)\b/;

/** The wording the pack used to carry, used as the detector's positive control. */
const FORMER_SHELL_INSTRUCTION =
  'Read the existing source and tests first, then make the change. Run `node --test` until every test passes.';

/**
 * The pre-transmission model-guard block a verifier fixture carries.
 *
 * Shaped exactly as the arm driver writes it — loaded, the hook the runtime dispatches registered,
 * and no request refused — because the intake reads it: a run whose guard did not register, or which
 * refused a request, is refused as a measurement. One exported shape for every fixture in the suites
 * and in this gate, so a fixture cannot quietly describe a guard the driver never writes.
 */
export function modelGuardEvidence(): Level2ModelGuardEvidence {
  const digestOfConfig = freeOnlyModelConfigDigest(freeOnlyModelConfig());
  return {
    guard: 'loaded',
    hook: MODEL_REQUEST_HOOK,
    loaded: true,
    hookRegistered: true,
    invocations: 2,
    allowed: 2,
    refused: 0,
    refusals: [],
    misconfigured: false,
    policyDigest: digestOfConfig,
    envelope: {
      primary: FREE_ONLY_PRIMARY_MODEL,
      approved: [...FREE_ONLY_APPROVED_MODELS],
      allowedKinds: [...REQUEST_KINDS],
      policyDigest: digestOfConfig,
    },
    evidenceLines: 4,
  };
}

/**
 * The free-only evidence block a verifier fixture carries.
 *
 * Shaped exactly as the arm driver writes it, because the intake reads it: a configuration whose
 * digest matches the policy's, a resolved reading in which every setting survived, a zero price row
 * in all four tiers, and request kinds in which nothing but `primary` was composed. The individual
 * checks below then alter one field at a time, so a gate that stopped looking at any of them would
 * stop failing.
 */
export function freeOnlyPolicyEvidence(): Level2ModelPolicyEvidence {
  return {
    primaryModel: FREE_ONLY_PRIMARY_MODEL,
    auxiliaryModel: FREE_ONLY_AUXILIARY_MODEL,
    approvedModels: [...FREE_ONLY_APPROVED_MODELS],
    config: freeOnlyModelConfig(),
    configDigest: freeOnlyModelConfigDigest(freeOnlyModelConfig()),
    configAccepted: true,
    catalogueSource: 'service',
    priceVerifiedFree: true,
    priceRow: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    priceCheckSkippedReason: undefined,
    refusals: [],
    resolved: {
      source: 'api config.get --standalone (this repository\u2019s own document)',
      found: true,
      model: FREE_ONLY_PRIMARY_MODEL,
      titleModel: FREE_ONLY_AUXILIARY_MODEL,
      compactionAuto: false,
      providersAllowed: ['opencode'],
      providersDeniedAll: true,
      update: 'disable',
      share: 'disabled',
      error: undefined,
    },
    requests: {
      source: 'model-request-hooks',
      // The measured hook name, and nothing else: a per-kind name registers without error and
      // never fires, so a fixture that carried four names would not be the shape a real
      // artifact has.
      kindsRegistered: [MODEL_REQUEST_HOOK],
      kinds: { primary: 2 },
      modelsNamed: { [FREE_ONLY_PRIMARY_MODEL]: 2 },
      registrationFailures: [],
      payloadKeys: ['agent', 'kind', 'messages', 'model', 'sessionID'],
      endpointKinds: { requests: 2, withToolRegistry: 2, withoutToolRegistry: 0 },
      auxiliaryRequests: 0,
    },
    titleGenerationSuppressed: true,
  };
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
  /** Override the native permission evidence; defaults to every required deny resolved. */
  readonly nativePermissions?: Level2NativePermissionsEvidence | undefined;
  /** Override the governor evidence; defaults to "not a live session". */
  readonly inSessionGovernor?: Level2InSessionGovernorEvidence | undefined;
  /** Override the model-guard evidence; defaults to a guard that loaded and refused nothing. */
  readonly modelGuard?: Level2ModelGuardEvidence | undefined;
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
    modelPolicy: freeOnlyPolicyEvidence(),
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
    // The native layer as the runtime resolves it. The default is the shape every live arm must
    // have: all four required denies reported by the runtime's own read-only configuration call.
    nativePermissions:
      options.nativePermissions === undefined
        ? {
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
            error: undefined,
          }
        : options.nativePermissions,
    // Shaped like a session whose request hook the runtime accepted and across which nothing was
    // refused: the shape every live arm must have before its numbers may be compared.
    modelGuard: options.modelGuard === undefined ? modelGuardEvidence() : options.modelGuard,
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

  /*
   * The instruction itself: a prompt must ask only for tools the containment policy allows.
   * `repeated-reads-catalogue` used to tell the agent to run `node --test`, which the canary's
   * shell deny makes impossible; the prompt now says so instead. This gate keeps that from
   * drifting back, and it is a positive control as well as a check: the detector must fire on the
   * wording the pack used to carry, or a prompt that asked for a shell would pass unnoticed.
   */
  const promptProblems = tasks.flatMap((task) => {
    const problems: string[] = [];
    if (SHELL_INSTRUCTION_PATTERN.test(task.prompt)) {
      problems.push(`${task.id} asks the agent to run a shell command, which containment denies`);
    }
    if (!task.prompt.includes(NO_SHELL_STATEMENT)) {
      problems.push(`${task.id} does not tell the agent that the session has no shell tool`);
    }
    return problems;
  });
  const detectorWorks = SHELL_INSTRUCTION_PATTERN.test(FORMER_SHELL_INSTRUCTION);
  checks.push(
    check(
      'tasks:prompts-fit-the-session-they-run-in',
      promptProblems.length === 0 && detectorWorks,
      !detectorWorks
        ? 'The shell-instruction detector did not fire on the wording this pack used to carry, so this check would pass vacuously.'
        : promptProblems.length === 0
          ? `All ${String(tasks.length)} prompts ask only for allowed tools and state that the session has no shell tool (the suite is run outside it, against pristine copies). The arms receive the same prompt; grading is unchanged and independent.`
          : promptProblems.join('; '),
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
  // The same block the fixtures carry, so the acceptance checks below exercise the shape a real
  // artifact has rather than a hand-written approximation of it.
  const freeOnlyPolicyBlock = (): Record<string, unknown> => ({ ...freeOnlyPolicyEvidence() });

  const artifactFor = (runNonce: string, complete: boolean): Record<string, unknown> => ({
    modelPolicy: freeOnlyPolicyBlock(),
    taskId: controlObservation.taskId,
    arm: 'control',
    runId: controlObservation.identity.runId,
    runNonce,
    complete,
    // Which mode produced this: the offline gate speaks for a live run, so a rehearsal's counts
    // could never stand in for one.
    mode: 'live',
    // The session itself: a run is only a measurement if the arm ran to completion, and the
    // driver states that outcome in the artifact for exactly this check.
    exitCode: 0,
    timedOut: false,
    sessionCleanExit: true,
    modelUnavailable: false,
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
    inSessionGovernor: controlObservation.inSessionGovernor,
    modelGuard: modelGuardEvidence(),
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
  }) => intakeArmEvidence({ ...options, expectedMode: 'live', expected: intakeExpected });

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

  /*
   * The session's own outcome. The driver exits 0 as soon as it has written a whole
   * artifact, so these three are the runs that used to arrive looking complete: a
   * process that ended non-zero, a session the wall clock stopped, and an artifact that
   * never states which happened. Each must be refused by name, and the positive control
   * above (`intake:accepted-run-keeps-its-observation`) is what keeps these from passing
   * vacuously.
   */
  const intakeIncompleteSessions: readonly (readonly [string, object, string])[] = [
    ['session-exit-nonzero', { exitCode: 1, timedOut: false, sessionCleanExit: false }, 'a session whose runtime process exited non-zero'],
    ['session-timed-out', { exitCode: 0, timedOut: true, sessionCleanExit: false }, 'a session the wall-clock bound stopped'],
    ['session-outcome-unrecorded', { exitCode: undefined, timedOut: false, sessionCleanExit: true }, 'an artifact that does not record the session outcome'],
  ];
  for (const [reason, outcome, label] of intakeIncompleteSessions) {
    const refused = intakeOf({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: JSON.stringify({ ...artifactFor('nonce-a', true), ...outcome }),
      expectedRunNonce: 'nonce-a',
    });
    checks.push(
      check(
        `intake:session-outcome-is-refused:${reason}`,
        !refused.accepted && refused.invalidReason === reason && refused.observation === undefined,
        `${label} is ${refused.accepted ? 'accepted as a measurement' : `refused as ${refused.invalidReason ?? 'unknown'}`}.`,
      ),
    );
  }

  /*
   * Containment integrity, at the contract level. The enforcement itself is proven against the
   * installed runtime by the containment probe's own test; what these keep in the gate is the
   * rule that a session which cannot show it was contained is never publishable — with the
   * guarded case as the positive control, so they cannot pass on a gate that refuses everything.
   */
  const intakeWrongMode = intakeOf({
    driverExitCode: 0,
    artifactPreexisting: false,
    artifactText: JSON.stringify({ ...artifactFor('nonce-a', true), mode: 'rehearse' }),
    expectedRunNonce: 'nonce-a',
  });
  checks.push(
    check(
      'intake:rehearsal-artifact-is-refused-as-a-live-measurement',
      !intakeWrongMode.accepted && intakeWrongMode.invalidReason === 'mode-mismatch',
      `A rehearsal artifact offered to a live run is ${intakeWrongMode.accepted ? 'accepted' : `refused as ${intakeWrongMode.invalidReason ?? 'unknown'}`}, so scripted counts can never stand in for a measurement.`,
    ),
  );

  const guardedGate = checkLiveEngagement(controlObservation);
  checks.push(
    check(
      'engagement:guarded-session-is-accepted',
      guardedGate.measurable && !guardedGate.stop,
      guardedGate.measurable
        ? `A session whose guard registered and whose workspace was known is measurable (${String(controlObservation.containment?.blockedCalls ?? 0)} call(s) refused during it).`
        : `A guarded session was refused: ${guardedGate.detail}`,
    ),
  );

  const noContainmentGate = checkLiveEngagement({
    ...controlObservation,
    containment: undefined,
  });
  checks.push(
    check(
      'engagement:missing-containment-evidence-is-refused',
      !noContainmentGate.measurable && noContainmentGate.stop,
      noContainmentGate.measurable
        ? 'A session carrying no containment evidence was accepted as measurable.'
        : 'A session whose artifact carries no containment evidence is refused rather than treated as contained because it did not say otherwise.',
    ),
  );

  const unguardedGate = checkLiveEngagement({
    ...controlObservation,
    containment: {
      guard: 'missing',
      rootKnown: true,
      blockedCalls: 0,
      allowedCalls: 0,
      blockedByTool: {},
      permissionRules: undefined,
      configDigest: undefined,
    },
  });
  checks.push(
    check(
      'engagement:unregistered-guard-is-refused',
      !unguardedGate.measurable && unguardedGate.stop,
      unguardedGate.measurable
        ? 'A session whose guard never registered its tool hook was accepted as measurable.'
        : 'A session whose containment guard never registered is refused, however complete its artifact looks.',
    ),
  );

  /*
   * The pre-transmission model guard, at the engagement level. The enforcement itself is proven
   * against the installed runtime by the model-guard probe's own test; these keep the rule that a
   * session which cannot show its requests were bounded is never publishable, with the guarded case
   * above as the positive control.
   */
  const noModelGuardGate = checkLiveEngagement({ ...controlObservation, modelGuard: undefined });
  checks.push(
    check(
      'engagement:missing-model-guard-evidence-is-refused',
      !noModelGuardGate.measurable && noModelGuardGate.stop,
      noModelGuardGate.measurable
        ? 'A session carrying no model-guard evidence was accepted as measurable.'
        : 'A session whose artifact carries no pre-transmission model-guard evidence is refused rather than treated as bounded because it did not say otherwise.',
    ),
  );

  const unguardedModelGate = checkLiveEngagement({
    ...controlObservation,
    modelGuard: {
      ...modelGuardEvidence(),
      guard: 'capability-missing',
      hookRegistered: false,
      invocations: 0,
      allowed: 0,
      evidenceLines: 2,
    },
  });
  checks.push(
    check(
      'engagement:unregistered-model-guard-is-refused',
      !unguardedModelGate.measurable && unguardedModelGate.stop,
      unguardedModelGate.measurable
        ? 'A session whose model guard never registered its request hook was accepted as measurable.'
        : 'A session whose model guard loaded but never registered the request hook is refused: the plugin having run is not the same fact as the runtime accepting the callback that would refuse a request.',
    ),
  );

  const refusedModelGate = checkLiveEngagement({
    ...controlObservation,
    modelGuard: {
      ...modelGuardEvidence(),
      invocations: 3,
      refused: 1,
      refusals: [{ requestKind: 'title', model: 'open-code/exo-free', reason: 'model-not-approved' }],
      evidenceLines: 5,
    },
  });
  checks.push(
    check(
      'engagement:a-refused-model-request-is-refused',
      !refusedModelGate.measurable && refusedModelGate.stop,
      refusedModelGate.measurable
        ? 'A session that attempted a request outside the envelope was accepted as measurable.'
        : 'A session in which the guard refused a request outside the envelope is refused as a measurement: nothing was sent, but the session is not the free-only session the experiment declares.',
    ),
  );

  const noNativeGate = checkLiveEngagement(
    { ...controlObservation, nativePermissions: undefined },
    { requireNativePermissions: true },
  );
  checks.push(
    check(
      'engagement:native-permission-layer-unobserved-is-refused',
      !noNativeGate.measurable && noNativeGate.stop,
      noNativeGate.measurable
        ? 'A live run with no evidence of the runtime\u2019s resolved permission rules was accepted.'
        : 'A live run whose runtime did not report its resolved permission rules is refused, so the second containment layer is never assumed to be in force.',
    ),
  );

  const partialNativeGate = checkLiveEngagement(
    {
      ...controlObservation,
      nativePermissions: {
        observed: true,
        source: 'api config.get --standalone',
        rules: [{ action: 'shell', effect: 'deny', resource: 'any' }],
        requiredDenies: ['external_directory', 'shell', 'subagent', 'webfetch'],
        missingRequiredDenies: ['external_directory', 'subagent', 'webfetch'],
        allRequiredPresent: false,
        error: undefined,
      },
    },
    { requireNativePermissions: true },
  );
  checks.push(
    check(
      'engagement:partly-resolved-native-denies-are-refused',
      !partialNativeGate.measurable && partialNativeGate.stop,
      partialNativeGate.measurable
        ? 'A run whose runtime resolved only some of the required denies was accepted.'
        : 'A run whose runtime resolved only some of the required denies is refused rather than compared.',
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

  /*
   * The free-only model policy.
   *
   * The decision this block pins is permanent for the current plan: the paired experiment runs on
   * free models only, and "free" means every applicable price tier is **explicitly** zero in the
   * runtime's own row — never that an identifier contains `free`. The checks below are the ones a
   * token comparison cannot make from the inside, because a session on a paid model produces
   * perfectly ordinary numbers: the approval list, the price verdict, the cross-arm identity of
   * the configuration, the runtime's own resolved reading of it, and the intake's refusal of a run
   * that does not carry all of them.
   */
  const zeroPriceRow = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const paidPriceRow = { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 };
  const priceFactsFor = (over: {
    readonly listed?: boolean;
    readonly priceRow?: typeof zeroPriceRow | undefined;
    readonly catalogueSize?: number;
  }) => ({
    model: FREE_ONLY_PRIMARY_MODEL,
    runtime: 'service' as const,
    catalogueSize: over.catalogueSize ?? 42,
    listed: over.listed ?? true,
    priceRow: over.priceRow,
  });
  checks.push(
    check(
      'free-only:every-price-tier-must-be-explicitly-zero',
      freeOnlyPriceRefusals(priceFactsFor({ priceRow: zeroPriceRow })).length === 0 &&
        freeOnlyPriceRefusals(priceFactsFor({ priceRow: paidPriceRow })).length === 1 &&
        freeOnlyPriceRefusals(priceFactsFor({ priceRow: undefined })).length === 1 &&
        freeOnlyPriceRefusals(priceFactsFor({ listed: false })).length === 1 &&
        freeOnlyPriceRefusals(priceFactsFor({ catalogueSize: 0, listed: false })).length === 1,
      'A zero row in all four tiers passes; a non-zero tier, an absent row, an unlisted model and a runtime that reports no catalogue at all are each refused by name.',
    ),
  );
  checks.push(
    check(
      'free-only:the-approval-list-decides-before-the-price-does',
      approvedModelRefusals(FREE_ONLY_PRIMARY_MODEL).length === 0 &&
        approvedModelRefusals(FREE_ONLY_AUXILIARY_MODEL).length === 0 &&
        approvedModelRefusals('opencode/some-other-free-model').length === 1 &&
        approvedModelRefusals(undefined).length === 1,
      'The primary and the backup are approved; any other identifier is refused even when its name contains "free", and a run that names no model is refused rather than defaulted.',
    ),
  );
  checks.push(
    check(
      'free-only:the-configuration-is-one-object-for-both-arms',
      freeOnlyModelConfigDigest(freeOnlyModelConfig()) === freeOnlyModelConfigDigest(freeOnlyModelConfig()) &&
        isFreeOnlyModelConfig(freeOnlyModelConfig()) &&
        !isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), model: 'opencode/gpt-5.4-mini' }) &&
        !isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), small_model: 'opencode/gpt-5.4-mini' }) &&
        !isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), compaction: { auto: true } }) &&
        !isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), enabled_providers: ['opencode', 'anthropic'] }),
      'The policy builds one configuration with no arm parameter, its digest is stable, and a substituted primary, a substituted auxiliary, compaction re-enabled or a second allowed provider all fail the structural check.',
    ),
  );
  const resolvedFreeOnly = {
    source: 'api config.get --standalone (this repository\u2019s own document)',
    found: true,
    model: FREE_ONLY_PRIMARY_MODEL,
    titleModel: FREE_ONLY_AUXILIARY_MODEL,
    compactionAuto: false,
    providersAllowed: ['opencode'],
    providersDeniedAll: true,
    update: 'disable',
    share: 'disabled',
    error: undefined,
  };
  checks.push(
    check(
      'free-only:the-runtime-must-confirm-every-setting-it-resolved',
      resolvedPolicyRefusals(resolvedFreeOnly).length === 0 &&
        resolvedPolicyRefusals({ ...resolvedFreeOnly, compactionAuto: undefined }).length === 1 &&
        resolvedPolicyRefusals({ ...resolvedFreeOnly, titleModel: 'opencode/gpt-5.4-mini' }).length === 1 &&
        resolvedPolicyRefusals({ ...resolvedFreeOnly, providersAllowed: ['opencode', 'anthropic'] }).length === 1 &&
        resolvedPolicyRefusals({ ...resolvedFreeOnly, providersDeniedAll: false }).length === 1 &&
        resolvedPolicyRefusals({ ...resolvedFreeOnly, model: 'opencode/gpt-5.4-mini' }).length === 1 &&
        resolvedPolicyRefusals({ ...resolvedFreeOnly, found: false, error: 'no document' }).length === 1,
      'A resolved configuration that matches every setting passes; a dropped compaction key, a paid auxiliary model, a second allowed provider, a missing deny-others rule, a substituted primary and an unreported configuration are each refused.',
    ),
  );

  checks.push(
    check(
      'free-only:the-endpoint-names-the-model-in-its-own-spelling',
      // The measured spelling first: the runtime's outbound body says `mimo-v2.6-flash-free`
      // while everything else says `opencode/mimo-v2.6-flash-free`. Accepting both — and only
      // those — is what makes the endpoint check an evidence check instead of a spelling trap.
      isApprovedEndpointModel('mimo-v2.6-flash-free', [FREE_ONLY_PRIMARY_MODEL]) &&
        isApprovedEndpointModel(FREE_ONLY_PRIMARY_MODEL, [FREE_ONLY_PRIMARY_MODEL]) &&
        endpointModelIds([FREE_ONLY_PRIMARY_MODEL]).length === 2 &&
        // Closed: a substitution, a near-miss name, a provider-qualified foreign model, an
        // auxiliary model standing in for the primary, and "no identifier at all" all fail.
        !isApprovedEndpointModel('gpt-5.4-mini-free', [FREE_ONLY_PRIMARY_MODEL]) &&
        !isApprovedEndpointModel('mimo-v2.6-flash-free-turbo', [FREE_ONLY_PRIMARY_MODEL]) &&
        !isApprovedEndpointModel('anthropic/mimo-v2.6-flash-free', [FREE_ONLY_PRIMARY_MODEL]) &&
        !isApprovedEndpointModel(FREE_ONLY_AUXILIARY_MODEL, [FREE_ONLY_PRIMARY_MODEL]) &&
        !isApprovedEndpointModel(undefined, [FREE_ONLY_PRIMARY_MODEL]) &&
        // The auxiliary model keeps its own endpoint spelling, so the approved set is complete.
        isApprovedEndpointModel('muse-spark-1.3-contributor-free') &&
        !isApprovedEndpointModel('opencode/gpt-5.4-mini'),
      'A loopback endpoint sees the runtime\u2019s body, which names the model without its provider (measured), so both spellings of an approved id pass while a substitution, a near-miss name, a foreign provider\u2019s same-named model, the auxiliary model standing in for the primary, and an absent identifier all fail.',
    ),
  );
  checks.push(
    check(
      'free-only:every-request-kind-but-the-primary-one-counts-as-auxiliary',
      auxiliaryRequestKinds({ primary: 3 }).length === 0 &&
        auxiliaryRequestKinds({ primary: 2, title: 1 }).join(',') === 'title' &&
        auxiliaryRequestKinds({ primary: 1, mystery: 1 }).join(',') === 'mystery' &&
        MODEL_REQUEST_HOOK === 'model.request' &&
        PRIMARY_REQUEST_KIND === 'primary',
      'The only kind a free-only run may compose is `primary`; every other kind \u2014 including one this harness has never heard of \u2014 is counted as auxiliary work and refuses the run, and the hook the counts come from is named in one place rather than in each reader.',
    ),
  );

  /*
   * The pre-transmission model guard, at the contract level.
   *
   * It is a *separate* refusal reason from `model-policy-unverified`: the free-only gate reads
   * intent (the configuration the run was given), and this reads whether that configuration was
   * enforced on the one channel that could still step outside it. A run may be configured perfectly
   * and still be refused here, which is the case these checks pin.
   */
  const guardRefused = (modelGuard: unknown) =>
    intakeArmEvidence({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: JSON.stringify({ ...artifactFor('nonce-a', true), modelGuard }),
      expectedRunNonce: 'nonce-a',
      expectedMode: 'live',
      expected: intakeExpected,
    });
  const guardBlock = (): Record<string, unknown> => ({ ...modelGuardEvidence() });
  const guardAccepted = guardRefused(guardBlock());
  const guardMissing = guardRefused(undefined);
  const guardUnregistered = guardRefused({ ...guardBlock(), hookRegistered: false });
  const guardMisconfigured = guardRefused({ ...guardBlock(), misconfigured: true });
  const guardDigestMismatch = guardRefused({ ...guardBlock(), policyDigest: digest('another-policy') });
  const guardRefusal = guardRefused({
    ...guardBlock(),
    refused: 1,
    refusals: [{ requestKind: 'primary', model: 'opencode/exo-free', reason: 'model-not-approved' }],
  });
  checks.push(
    check(
      'model-guard:a-run-that-cannot-show-bounded-requests-is-refused',
      guardAccepted.accepted &&
        !guardMissing.accepted &&
        guardMissing.invalidReason === 'model-guard-unverified' &&
        !guardUnregistered.accepted &&
        guardUnregistered.invalidReason === 'model-guard-unverified' &&
        !guardMisconfigured.accepted &&
        guardMisconfigured.invalidReason === 'model-guard-unverified' &&
        !guardDigestMismatch.accepted &&
        !guardRefusal.accepted &&
        guardRefusal.invalidReason === 'model-guard-unverified',
      `A run whose guard registered and refused nothing is accepted, while a missing guard block, an unregistered hook, a guard built without an envelope, a guard bounding a different policy digest and a session in which one request was refused are all refused as ${String(guardMissing.invalidReason ?? 'unknown')}. The last case is the one a token comparison cannot see: nothing was sent, and the run is still not the free-only session the experiment declares.`,
    ),
  );
  checks.push(
    check(
      'model-guard:registration-is-not-inferred-from-a-claim',
      // `hookRegistered: false` with `guard: 'loaded'` written by the artifact must not be read as
      // armed: the flag is recomputed from the two facts, never taken from the file.
      !guardRefused({ ...guardBlock(), hookRegistered: false, guard: 'loaded' }).accepted,
      'An artifact that asserts `guard: "loaded"` while recording `hookRegistered: false` is refused, so a driver cannot make an unregistered guard look armed by labelling it.',
    ),
  );

  const policyRefused = (modelPolicy: unknown, mode: 'live' | 'rehearse' = 'live') =>
    intakeArmEvidence({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: JSON.stringify({ ...artifactFor('nonce-a', true), mode, modelPolicy }),
      expectedRunNonce: 'nonce-a',
      expectedMode: mode,
      expected: intakeExpected,
    });
  const policyAccepted = policyRefused(freeOnlyPolicyBlock());
  checks.push(
    check(
      'free-only:a-run-outside-the-policy-is-refused',
      policyAccepted.accepted &&
        !policyRefused({ ...freeOnlyPolicyBlock(), config: { ...freeOnlyModelConfig(), model: 'opencode/gpt-5.4-mini' } }).accepted &&
        policyRefused({ ...freeOnlyPolicyBlock(), config: { ...freeOnlyModelConfig(), model: 'opencode/gpt-5.4-mini' } }).invalidReason === 'model-policy-unverified' &&
        !policyRefused({ ...freeOnlyPolicyBlock(), primaryModel: 'opencode/gpt-5.4-mini' }).accepted &&
        !policyRefused({ ...freeOnlyPolicyBlock(), priceVerifiedFree: false, priceRow: paidPriceRow }).accepted &&
        !policyRefused({ ...freeOnlyPolicyBlock(), titleGenerationSuppressed: false }).accepted &&
        !policyRefused({ ...freeOnlyPolicyBlock(), refusals: ['the model is not free'] }).accepted &&
        !policyRefused(undefined).accepted,
      `A verified free-only run is accepted as the positive control, while a substituted primary, an unapproved primary, a non-zero price row, an unsuppressed title call, a recorded pre-spawn refusal and a missing policy block are all refused as ${String(policyRefused({ ...freeOnlyPolicyBlock(), primaryModel: 'x' }).invalidReason ?? 'unknown')}.`,
    ),
  );
  checks.push(
    check(
      'free-only:an-auxiliary-request-refuses-the-run',
      !policyRefused({
        ...freeOnlyPolicyBlock(),
        requests: {
          source: 'model-request-hooks',
          kindsRegistered: ['primary', 'compaction', 'title', 'generate'],
          kinds: { primary: 2, title: 1 },
          modelsNamed: { [FREE_ONLY_PRIMARY_MODEL]: 3 },
          registrationFailures: [],
          auxiliaryRequests: 1,
        },
      }).accepted,
      'A session that composed one title request is refused rather than compared, because the auxiliary call is part of what the run measured.',
    ),
  );
  checks.push(
    check(
      'free-only:a-rehearsal-may-record-why-no-price-was-checked',
      policyRefused(
        {
          ...freeOnlyPolicyBlock(),
          catalogueSource: 'not-checked',
          priceVerifiedFree: false,
          priceRow: null,
          priceCheckSkippedReason: 'a rehearsal spends nothing and holds no account catalogue',
        },
        'rehearse',
      ).accepted,
      'A rehearsal, which spends nothing and holds no account, is accepted while recording why no price row exists; a live run must show a verified-zero row instead.',
    ),
  );
  const zeroCostObservation: Level2ArmObservation = {
    ...controlObservation,
    usage: { ...controlObservation.usage, inputTokens: 1_482, outputTokens: 96, costUsd: 0 },
  };
  const zeroCostDecision = createBudgetTracker({
    maxUnitsPerRun: undefined,
    maxTotalUnits: undefined,
    maxCostUsdPerRun: 0.5,
    maxCostUsd: 1,
  }).observe(zeroCostObservation);
  checks.push(
    check(
      'free-only:a-reported-zero-cost-is-a-measurement-not-a-gap',
      reportedCostUsd(zeroCostObservation) === 0 &&
        !hasNoReportedUsage(zeroCostObservation) &&
        zeroCostDecision.allowed,
      'A free session reports cost 0 while its token fields stay reported, so the spending cap reads it as a value rather than as an unreported cost and does not stop the run.',
    ),
  );

  /*
   * The live run's stopping rule, exercised offline by fault injection: the first fatal arm
   * outcome must end the plan. The 2026-10-12 canary launched its treatment arm after the control
   * session had already failed, so this is a check about money as much as about correctness — a
   * single-use authorization was spent twice. The per-run execution is a fake here, so the
   * sequence is exercised with no runtime, no provider and no cost.
   */
  const injectedLaunches: string[] = [];
  const injectedPlan = buildPlan({
    pairsPerTask: 1,
    tasks: [requireTask('repeated-reads-catalogue'), requireTask('read-and-edit-total')],
    declarationFingerprint: declaration.fingerprint,
    allowIncomplete: true,
  });
  const injected = await runArmSequence({
    plan: injectedPlan,
    model: 'synthetic/verify',
    budget: { observe: () => ({ allowed: true, reason: undefined, detail: 'within cap' }) },
    execute: async (run) => {
      injectedLaunches.push(`${run.taskId}:${run.arm}`);
      return {
        observation: undefined,
        problems: [],
        artifactPath: 'synthetic/artifact.json',
        outputRevision: undefined,
        driverExitCode: 1,
        accepted: false,
        invalidReason: 'session-exit-nonzero',
        modelUnavailable: false,
      };
    },
  });
  const notRun = injected.dispositions.filter((entry) => entry.disposition === 'not-run');
  checks.push(
    check(
      'sequence:a-fatal-arm-outcome-stops-the-plan',
      injectedLaunches.length === 1 &&
        injected.stop?.code === 'invalid-measurement' &&
        notRun.length === injectedPlan.runs.length - 1 &&
        injected.observations.length === 0,
      `A run with no measurement launched ${String(injectedLaunches.length)} arm(s) and stopped the plan ` +
        `(${injected.stop?.code ?? 'no stop'}), publishing ${String(notRun.length)} unattempted run(s) as not-run.`,
    ),
  );

  /*
   * The clean-tree prerequisite. A live run is an experiment against a revision; if the checkout
   * carries uncommitted work the report cannot name what was run, and on 2026-10-12 the run started
   * anyway. Read-only: this check repairs nothing and changes no git state.
   */
  const dirtyTreeRefusal = liveRunRefusals({
    approveLive: true,
    model: 'synthetic/verify',
    runtime: 'service',
    cliPath: 'synthetic/opencode-cli.exe',
    cliPresent: true,
    workingTree: {
      clean: false,
      entries: [{ code: ' M', path: 'src/level2/cli.ts' }],
      error: undefined,
    },
    maxRuns: 2,
    planArmRuns: 2,
    maxUnitsPerRun: 1_500_000,
    maxUnits: 3_000_000,
    maxCostUsdPerRun: 0.5,
    maxCostUsd: 1,
    timeoutMs: 300_000,
  });
  const cleanTreeAllowed = liveRunRefusals({
    approveLive: true,
    model: 'synthetic/verify',
    runtime: 'service',
    cliPath: 'synthetic/opencode-cli.exe',
    cliPresent: true,
    workingTree: { clean: true, entries: [], error: undefined },
    maxRuns: 2,
    planArmRuns: 2,
    maxUnitsPerRun: 1_500_000,
    maxUnits: 3_000_000,
    maxCostUsdPerRun: 0.5,
    maxCostUsd: 1,
    timeoutMs: 300_000,
  });
  checks.push(
    check(
      'guards:a-dirty-working-tree-refuses-a-live-run',
      dirtyTreeRefusal.length > 0 &&
        dirtyTreeRefusal.join(' ').includes('uncommitted change') &&
        cleanTreeAllowed.length === 0,
      dirtyTreeRefusal.length === 0
        ? 'A live run on a dirty working tree was allowed to start.'
        : 'A live run on a dirty working tree is refused (and the same run on a clean tree is not), so the report can name the revision it measured.',
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
