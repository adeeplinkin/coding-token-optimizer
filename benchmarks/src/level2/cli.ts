#!/usr/bin/env node
/**
 * Level 2 command line.
 *
 * Three modes, and the difference between them is entirely about what they are
 * allowed to spend:
 *
 * - `--offline-verify` (the default) touches no model, no credential and no network.
 *   It proves the apparatus: repositories, grader, plan, contract, report.
 * - `--rehearse` drives the **real** runtime once per arm against a loopback
 *   scripted provider. No model is called and nothing is billed; the point is to
 *   exercise plugin loading, the apply switch, the wire probe, the summary capture
 *   and the artifact intake end to end. A rehearsal cannot solve a coding task, and
 *   the run is expected to report that honestly.
 * - `--live` calls the configured provider for a pinned model. It refuses to start
 *   unless the operator explicitly approves, names the model, and caps the run count
 *   at or above the plan's arm-run total.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  LEVEL2_REPORT_DIR,
  buildExperiment,
  describeObservation,
  renderLevel2Json,
  renderLevel2Markdown,
} from './report.js';
import { MIN_PAIRS_PER_TASK, buildPlan, validatePlan } from './plan.js';
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_COST_USD_PER_RUN,
  DEFAULT_MAX_UNITS,
  DEFAULT_MAX_UNITS_PER_RUN,
  createBudgetTracker,
} from './budget.js';
import {
  DEFAULT_CLI_PATH,
  armWorkspace,
  isolationVerdict,
  probeArmEnvironment,
  probeCanRunModel,
  runArm,
} from './runner.js';
import type { ArmRuntimeMode } from './runner.js';
import { describeLiveBounds, liveRunRefusals, readWorkingTree } from './guards.js';
import {
  FREE_ONLY_APPROVED_MODELS,
  FREE_ONLY_AUXILIARY_MODEL,
  FREE_ONLY_PRIMARY_MODEL,
  MODEL_REQUEST_HOOK,
  PRIMARY_REQUEST_KIND,
  auxiliaryRequestKinds,
  describeResolvedPolicy,
  endpointModelIds,
  freeOnlyModelConfig,
  freeOnlyModelConfigDigest,
  isApprovedEndpointModel,
  readResolvedModelPolicy,
  resolvedPolicyRefusals,
} from './free-model-policy.js';
import { runArmSequence } from './sequence.js';
import { startScriptedProvider } from './scripted-provider.js';
import { runContainmentProbe } from './containment-probe.js';
import type { ContainmentProbeRun, ContainmentProbeStepResult } from './containment-probe.js';
import { LEVEL2_TASKS, MECHANISM_TASK_ID, findTask, mechanismReadPath } from './tasks.js';
import { requireTask } from './verify.js';
import { resolveLevel2Declaration } from './variants.js';
import { runOfflineVerification } from './verify.js';
import type { Level2ArmObservation, Level2RunDisposition, Level2Task } from './types.js';

interface CliOptions {
  readonly mode: 'offline-verify' | 'plan' | 'preflight' | 'rehearse' | 'live' | 'help';
  readonly taskId: string | undefined;
  readonly pairs: number;
  readonly model: string | undefined;
  readonly approveLive: boolean;
  readonly maxRuns: number | undefined;
  /** Cumulative cap on conservative token units; `undefined` means no cap. */
  readonly maxUnits: number | undefined;
  /** Per-session cap on conservative token units; `undefined` means no cap. */
  readonly maxUnitsPerRun: number | undefined;
  /** Cumulative cap on provider-reported spend in USD; `undefined` means no cap. */
  readonly maxCostUsd: number | undefined;
  /** Per-session cap on provider-reported spend in USD; `undefined` means no cap. */
  readonly maxCostUsdPerRun: number | undefined;
  /** Which runtime carries a session: the isolated private server or the running service. */
  readonly runtime: ArmRuntimeMode;
  readonly workspaceRoot: string;
  readonly timeoutMs: number | undefined;
  readonly cliPath: string;
}

const USAGE = `Dr. Token Level 2 (paired control/treatment coding benchmark)

Usage: npm run level2 -- [options]

Modes (default: --offline-verify)
  --offline-verify       Verify the apparatus without any model call (default)
  --plan                 Print the run plan and its checks, then exit
  --rehearse             Drive both arms once through a loopback scripted provider
  --live                 Run the plan against a real provider (requires --approve-live)

Options
  --task <id>            Restrict a rehearsal to one task
  --pairs <n>            Pairs per task (minimum ${MIN_PAIRS_PER_TASK}; forced to the minimum in rehearse)
  --model <id>           Model identifier; required by --live and recorded in provenance
  --approve-live         Explicit authorization for live model calls
  --max-runs <n>         Cap on arm runs; --live refuses if the plan exceeds it
  --max-units <n>        Cumulative hard cap; the run stops before the next session if exceeded
  --max-units-per-run <n>  Per-session hard cap; stops the run when one session exceeds it
  --max-cost-usd <n>     Cumulative spending cap in reported USD; stops the run when exceeded
  --max-cost-usd-per-run <n>  Per-session spending cap in reported USD; stops the run when exceeded, and on
                         the service runtime is also enforced in-session through the runtime's own
                         session interrupt (the overshoot is bounded by one poll interval, never by the cap)
                         Each of the four accepts "none", which removes that bound; --live refuses to
                         start unless one per-session and one total bound remain
  --preflight            Report the plan, caps, model and credential facts without spending
  --runtime <mode>       standalone (isolated private server) or service (the running one)
  --workspace <dir>      Where repositories and artifacts are created
  --timeout-ms <n>       Per-session timeout
  --cli <path>           OpenCode CLI to drive (default: the installed Desktop runtime)
  --help                 Show this help

Exit codes: 0 = every check and every task passed, 1 = a check or a task failed,
2 = the mode could not run (missing CLI, refused authorization, spawn failure).`;

function parseArgs(argv: readonly string[]): CliOptions {
  const options: {
    mode: CliOptions['mode'];
    taskId: string | undefined;
    pairs: number;
    model: string | undefined;
    approveLive: boolean;
    maxRuns: number | undefined;
    maxUnits: number | undefined;
    maxUnitsPerRun: number | undefined;
    maxCostUsd: number | undefined;
    maxCostUsdPerRun: number | undefined;
    runtime: ArmRuntimeMode;
    workspaceRoot: string;
    timeoutMs: number | undefined;
    cliPath: string;
  } = {
    mode: 'offline-verify',
    taskId: undefined,
    pairs: MIN_PAIRS_PER_TASK,
    model: undefined,
    approveLive: false,
    maxRuns: undefined,
    maxUnits: DEFAULT_MAX_UNITS,
    maxUnitsPerRun: DEFAULT_MAX_UNITS_PER_RUN,
    maxCostUsd: DEFAULT_MAX_COST_USD,
    maxCostUsdPerRun: DEFAULT_MAX_COST_USD_PER_RUN,
    runtime: 'standalone',
    workspaceRoot: join(process.env['LOCALAPPDATA'] ?? '.', 'Temp', 'dr-token-level2'),
    timeoutMs: undefined,
    cliPath: DEFAULT_CLI_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    switch (key) {
      case '--help':
      case '-h':
        options.mode = 'help';
        break;
      case '--offline-verify':
        options.mode = 'offline-verify';
        break;
      case '--plan':
        options.mode = 'plan';
        break;
      case '--preflight':
        options.mode = 'preflight';
        break;
      case '--rehearse':
        options.mode = 'rehearse';
        break;
      case '--live':
        options.mode = 'live';
        break;
      case '--approve-live':
        options.approveLive = true;
        break;
      case '--task':
        options.taskId = requireValue(key, value);
        index += 1;
        break;
      case '--pairs':
        options.pairs = Number(requireValue(key, value));
        index += 1;
        break;
      case '--model':
        options.model = requireValue(key, value);
        index += 1;
        break;
      case '--max-runs':
        options.maxRuns = Number(requireValue(key, value));
        index += 1;
        break;
      case '--max-units':
        options.maxUnits = requireCap(key, requireValue(key, value));
        index += 1;
        break;
      case '--max-units-per-run':
        options.maxUnitsPerRun = requireCap(key, requireValue(key, value));
        index += 1;
        break;
      case '--max-cost-usd':
        options.maxCostUsd = requireCap(key, requireValue(key, value));
        index += 1;
        break;
      case '--max-cost-usd-per-run':
        options.maxCostUsdPerRun = requireCap(key, requireValue(key, value));
        index += 1;
        break;
      case '--runtime': {
        const value2 = requireValue(key, value);
        if (value2 !== 'standalone' && value2 !== 'service') {
          throw new Error('--runtime must be standalone or service.');
        }
        options.runtime = value2;
        index += 1;
        break;
      }
      case '--workspace':
        options.workspaceRoot = resolve(requireValue(key, value));
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(requireValue(key, value));
        index += 1;
        break;
      case '--cli':
        options.cliPath = requireValue(key, value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument "${key}".`);
    }
  }

  return options;
}

function requireValue(key: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Option ${key} requires a value.`);
  }
  return value;
}

/**
 * Parse a cap. `none` removes the bound explicitly; anything else must be a positive number.
 *
 * Removing a bound has to be spelled out, so a typo cannot silently disable the only thing standing
 * between an authorization and an unbounded run — `--max-cost-usd nuan` is an error, not "no cap".
 */
function requireCap(key: string, value: string): number | undefined {
  if (value.trim().toLowerCase() === 'none') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Option ${key} needs a positive number, or "none" to remove the bound (got "${value}").`);
  }
  return parsed;
}

async function writeReports(
  name: string,
  markdown: string,
  json: string,
): Promise<readonly string[]> {
  await mkdir(LEVEL2_REPORT_DIR, { recursive: true });
  const markdownPath = join(LEVEL2_REPORT_DIR, `${name}.md`);
  const jsonPath = join(LEVEL2_REPORT_DIR, `${name}.json`);
  await writeFile(markdownPath, markdown, 'utf8');
  await writeFile(jsonPath, json, 'utf8');
  return [markdownPath, jsonPath];
}

function tasksFor(options: CliOptions): readonly Level2Task[] {
  if (options.taskId === undefined) {
    return LEVEL2_TASKS;
  }
  const task = findTask(options.taskId);
  if (task === undefined) {
    throw new Error(`No Level 2 task named "${options.taskId}".`);
  }
  return [task];
}

async function runOffline(): Promise<number> {
  const workRoot = join(process.env['LOCALAPPDATA'] ?? '.', 'Temp', 'dr-token-level2-verify');
  const plan = buildPlan({
    pairsPerTask: MIN_PAIRS_PER_TASK,
    declarationFingerprint: resolveLevel2Declaration().fingerprint,
  });
  const result = await runOfflineVerification({
    workRoot,
    plan,
    onProgress: (line) => {
      process.stdout.write(`      ${line}\n`);
    },
  });

  process.stdout.write('Level 2 offline verification\n\n');
  for (const entry of result.checks) {
    process.stdout.write(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name} — ${entry.detail}\n`);
  }
  process.stdout.write('\n');
  if (result.failures.length === 0) {
    process.stdout.write('ALL LEVEL 2 OFFLINE CHECKS PASSED\n');
    return 0;
  }
  process.stdout.write(`${result.failures.length} LEVEL 2 OFFLINE CHECK(S) FAILED: ${result.failures.join('; ')}\n`);
  return 1;
}

function printPlan(plan: ReturnType<typeof buildPlan>): number {
  const problems = validatePlan(plan);
  process.stdout.write('Level 2 run plan\n\n');
  process.stdout.write(`tasks:            ${plan.tasks.length} (${plan.tasks.join(', ')})\n`);
  process.stdout.write(`pairs per task:   ${plan.pairsPerTask}\n`);
  process.stdout.write(`pairs total:      ${plan.pairsTotal}\n`);
  process.stdout.write(`arm runs total:   ${plan.armRunsTotal}\n`);
  process.stdout.write(`task pack hash:   ${plan.taskPackFingerprint}\n`);
  process.stdout.write(`declaration hash: ${plan.declarationFingerprint}\n`);
  const firstTask = plan.tasks[0];
  const order = plan.runs
    .filter((entry) => entry.taskId === firstTask)
    .map((entry) => `${entry.taskId}#p${entry.pairIndex}:${entry.arm}`)
    .join(' | ');
  process.stdout.write(`order (task 1):   ${order}\n`);
  process.stdout.write('\n');
  if (problems.length === 0) {
    process.stdout.write('PLAN MEETS THE DESIGN\u2019S MINIMUM SAMPLES AND ORDER RULES\n');
    return 0;
  }
  for (const problem of problems) {
    process.stdout.write(`PLAN PROBLEM: ${problem}\n`);
  }
  return 1;
}

async function runRehearse(options: CliOptions): Promise<number> {
  // The rehearsal's default task is the one the pass is *for*: a task whose repository holds a
  // file large enough for two identical reads to be eligible. Without `--task` the first task id
  // used to be chosen, and its repository has no `data/` directory — the scripted reads answered
  // "file not found", the pass had nothing to elide, and the rehearsal reported `no-opportunity`
  // as if that were the apparatus working. A rehearsal that cannot exercise the mechanism proves
  // nothing about the mechanism, so the default is the task that can.
  const task = options.taskId === undefined ? requireTask(MECHANISM_TASK_ID) : tasksFor(options)[0];
  if (task === undefined) {
    throw new Error('A rehearsal needs a task.');
  }
  // The file the scripted provider asks for, taken from the task's own files: a path the task
  // does not contain makes the two reads identical *failures*, which is not a duplicate.
  const rehearsalReadPath = mechanismReadPath(task);
  if (rehearsalReadPath === undefined) {
    throw new Error(`Task "${task.id}" declares no files, so a rehearsal has nothing to read.`);
  }
  if (!existsSync(options.cliPath)) {
    process.stderr.write(`level2: the OpenCode CLI was not found at ${options.cliPath}\n`);
    return 2;
  }
  // A rehearsal runs the approved free primary and nothing else. It drives the same driver a live
  // arm does, and that driver refuses a command line that disagrees with the model its free-only
  // configuration pins — so accepting `--model <something else>` here would only move the refusal
  // one process later, while suggesting a rehearsal could be run outside the policy at all.
  const rehearsalModel = FREE_ONLY_PRIMARY_MODEL;
  if (options.model !== undefined && options.model !== rehearsalModel) {
    process.stderr.write(
      `level2: a rehearsal runs the approved free model \`${rehearsalModel}\`; refusing \`${options.model}\`. The free-only configuration pins the primary model, and a rehearsal under a different model would prove nothing about the configuration a live run receives.\n`,
    );
    return 2;
  }

  const observations: Level2ArmObservation[] = [];
  const dispositions: Level2RunDisposition[] = [];
  const armAccepted = new Map<string, boolean>();
  let failures = 0;

  for (const arm of ['control', 'treatment'] as const) {
    const workspace = armWorkspace(options.workspaceRoot, task.id, 0, arm, 1);
    const readPath = join(workspace, 'repo', ...rehearsalReadPath.split('/'));
    const capturePath = join(workspace, 'provider-capture.jsonl');
    // The scripted provider answers two `read` calls for the same file, which is the
    // shape the pass needs; the capture file holds what the provider received.
    const provider = await startScriptedProvider({ readPath, capturePath, toolCalls: 2 });
    try {
      const outcome = await runArm({
        task,
        arm,
        pairIndex: 0,
        workspaceRoot: options.workspaceRoot,
        mode: 'rehearse',
        model: rehearsalModel,
        baseUrl: provider.baseUrl,
        readPath,
        // The loopback provider's own record is what makes real request lengths and
        // marker counts available to the mechanism check.
        providerCapture: capturePath,
        cliPath: options.cliPath,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        onProgress: (line) => {
          process.stdout.write(`      ${line}\n`);
        },
      });
      for (const problem of outcome.problems) {
        process.stdout.write(`NOTE  ${problem}\n`);
      }
      armAccepted.set(arm, outcome.accepted);
      // Classified with the same vocabulary as a live run: a rehearsal's coding outcome is a
      // genuine `task-failed` (a scripted provider cannot solve the task), not a `solved` run
      // and not an invalid measurement — the measurement itself was fine.
      const rehearsalDisposition =
        outcome.observation === undefined
          ? 'invalid-measurement'
          : outcome.observation.grading.passed
            ? 'solved'
            : 'task-failed';
      dispositions.push({
        taskId: task.id,
        pairIndex: 0,
        arm,
        disposition: rehearsalDisposition,
        detail:
          outcome.observation === undefined
            ? `the rehearsal run was refused as a measurement (${outcome.invalidReason ?? 'no observation'})`
            : 'the scripted provider cannot solve the task, so this is a plumbing result rather than a coding one',
      });
      if (outcome.observation === undefined) {
        process.stdout.write(`FAIL  ${arm} arm produced no observation\n`);
        failures += 1;
        continue;
      }
      observations.push(outcome.observation);
      process.stdout.write(`      ${describeObservation(outcome.observation)}\n`);
    } finally {
      provider.stop();
    }
  }    if (observations.length === 2) {
    const declaration = resolveLevel2Declaration();
    const plan = buildPlan({
      pairsPerTask: 1,
      tasks: [task],
      declarationFingerprint: declaration.fingerprint,
      // One task, one pair: the minimum-sample rule does not apply to a plumbing
      // check, and the experiment is labelled incomplete so no conclusion can be
      // drawn from it. `validatePlan` still refuses a plan like this for a live run.
      allowIncomplete: true,
    });
    const experiment = buildExperiment(observations, plan, [task], dispositions);
    const context = {
      model: rehearsalModel,
      harness: 'opencode-coding-task',
      pairsPerTask: 1,
      generatedAt: new Date().toISOString(),
    };
    const paths = await writeReports(
      'level2-rehearse',
      renderLevel2Markdown(experiment, context),
      renderLevel2Json(experiment, context),
    );
    for (const path of paths) {
      process.stdout.write(`      wrote ${path}\n`);
    }

    const control = observations.find((entry) => entry.identity.arm === 'control');
    const treatment = observations.find((entry) => entry.identity.arm === 'treatment');

    // ------------------------------------------------------------------ //
    // Containment enforcement probe: one real session per arm, asked for calls the
    // policy must refuse.
    //
    // A guard that loads is not a guard that enforces, and the guard's own report of
    // itself is not an independent observation. Each arm's probe session is therefore
    // asked — by the loopback provider's own script — for a fixed matrix: an
    // in-workspace read and write that must succeed, and an absolute path outside, a
    // traversal, a shell, an out-of-workspace write, a patch, a fetch and a nested
    // agent that must not. The provider's own capture says what the runtime did with
    // each call, and the filesystem is checked for the traces the refused calls would
    // have left.
    // ------------------------------------------------------------------ //
    const probeRuns: ContainmentProbeRun[] = [];
    const probeProblems: string[] = [];
    for (const arm of ['control', 'treatment'] as const) {
      try {
        probeRuns.push(
          await runContainmentProbe({
            workspaceRoot: options.workspaceRoot,
            cliPath: options.cliPath,
            arm,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            onProgress: (line) => {
              process.stdout.write(`      ${line}\n`);
            },
          }),
        );
      } catch (error) {
        probeProblems.push(`${arm}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const probeControl = probeRuns.find((run) => run.arm === 'control');
    const probeTreatment = probeRuns.find((run) => run.arm === 'treatment');
    const stepsOf = (run: ContainmentProbeRun | undefined): readonly ContainmentProbeStepResult[] =>
      run?.steps ?? [];
    const refusedStepsOf = (run: ContainmentProbeRun | undefined): readonly ContainmentProbeStepResult[] =>
      stepsOf(run).filter((step) => step.expectation === 'refused');
    const stepOf = (
      run: ContainmentProbeRun | undefined,
      id: string,
    ): ContainmentProbeStepResult | undefined => stepsOf(run).find((step) => step.id === id);
    const refusedWithNoContent = (run: ContainmentProbeRun | undefined): boolean => {
      const refused = refusedStepsOf(run);
      return (
        refused.length > 0 &&
        refused.every(
          (step) => step.outcome === 'refusal' && !step.forbiddenTextReachedProvider,
        )
      );
    };
    const refusedWithNoTrace = (run: ContainmentProbeRun | undefined): boolean =>
      refusedStepsOf(run).every(
        (step) => step.sideEffectPath === undefined || !step.sideEffectCreated,
      );
    /** What each arm's restrictions came to, so the two can be compared as evidence. */
    const enforcementSignature = (run: ContainmentProbeRun | undefined): string =>
      JSON.stringify({
        steps: refusedStepsOf(run).map((step) => [step.id, step.outcome]),
        reasons: [...(run?.guardBlockReasons ?? [])].sort(),
        blockedByTool: run?.blockedByTool ?? {},
      });
    const describeRefusals = (run: ContainmentProbeRun | undefined): string =>
      probeProblems.length > 0
        ? probeProblems.join(' | ')
        : `guard=${run?.guard ?? 'none'} refused=${String(run?.blockedCalls ?? 0)} allowed=${String(run?.allowedCalls ?? 0)} tools=${Object.keys(run?.blockedByTool ?? {}).join(',') || 'none'}`;
    const describeProbe = (run: ContainmentProbeRun | undefined): string =>
      run === undefined
        ? 'no probe run'
        : `provenance=${run.provenanceOk ? 'accepted' : (run.invalidReason ?? 'refused')} driverExit=${String(run.driverExitCode)} artifact=${run.root}`;
    const describeUnexpected = (run: ContainmentProbeRun | undefined): string =>
      refusedStepsOf(run)
        .flatMap((step) =>
          step.outcome === 'refusal' && !step.forbiddenTextReachedProvider
            ? []
            : [`${step.id}=${step.outcome}${step.forbiddenTextReachedProvider ? '+canary' : ''}`],
        )
        .join(',') || 'none';
    const describeTraces = (run: ContainmentProbeRun | undefined): string =>
      refusedStepsOf(run)
        .flatMap((step) => (step.sideEffectCreated ? [step.id] : []))
        .join(',') || 'no trace';


    /**
     * Stands in for missing resolved-policy evidence, so "absent" is checked as a refusal rather
     * than passed over. A check that treated absent evidence as agreement would be vacuous.
     */
    const unresolvedPolicy = {
      source: 'unrecorded',
      found: false,
      model: undefined,
      titleModel: undefined,
      compactionAuto: undefined,
      providersAllowed: [],
      providersDeniedAll: false,
      update: undefined,
      share: undefined,
      error: 'no resolved configuration was recorded',
    };
    const describeResolvedFor = (observation: Level2ArmObservation | undefined): string => {
      const resolved = readResolvedModelPolicy(observation?.modelPolicy?.resolved) ?? unresolvedPolicy;
      const refusals = resolvedPolicyRefusals(resolved);
      return refusals.length === 0
        ? `resolved ${describeResolvedPolicy(resolved)}`
        : `NOT APPLIED: ${refusals.join('; ')}`;
    };
    const describeKinds = (observation: Level2ArmObservation | undefined): string => {
      const policy = observation?.modelPolicy;
      if (policy === undefined) return 'no policy evidence';
      const kinds = Object.entries(policy.requests.kinds)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(' ');
      return `${kinds || 'no requests'} via ${policy.requests.source}`;
    };
    const describeRequestModels = (observation: Level2ArmObservation | undefined): string => {
      const requests = observation?.wire.requests ?? [];
      if (requests.length === 0) return 'no request observed at the endpoint';
      const models = [...new Set(requests.map((request) => request.model ?? 'unread'))];
      const withTools = requests.filter((request) => request.hasTools === true).length;
      return `${String(requests.length)} request(s), models [${models.join(', ')}], ${String(withTools)} with a tool registry`;
    };
    // The endpoint names a model without its provider — measured, not assumed: the runtime's own
    // body carries `mimo-v2.6-flash-free` while the configuration, the hook payload and the
    // runtime's resolved policy all carry `opencode/mimo-v2.6-flash-free`. The acceptable
    // spellings come from the policy so this check and the policy cannot disagree, and the set
    // stays closed: the *primary* only, because every request at the endpoint must be the agent
    // loop and the resolved policy pins that loop to the primary.
    const endpointPrimaryIds = endpointModelIds([FREE_ONLY_PRIMARY_MODEL]);
    // `modelsNamed` is normalized by its source: the hook hands over a provider-qualified reference
    // (`{providerID, model}`), while the endpoint's own capture can only see the body, which has no
    // provider in it. Each reading is therefore compared against the set its own shape can name —
    // and a source that is neither is given no allowance at all, so an unrecognized reading fails
    // rather than passing by default.
    const approvedNamedIds = (observation: Level2ArmObservation | undefined): readonly string[] => {
      const source = observation?.modelPolicy?.requests.source;
      if (source === 'model-request-hooks') return FREE_ONLY_APPROVED_MODELS;
      if (source === 'loopback-endpoint') return endpointPrimaryIds;
      return [];
    };

    const checks: readonly (readonly [string, boolean, string])[] = [
      [
        'both arms ran a real session and were observed',
        control !== undefined && treatment !== undefined,
        `control sessions observed, treatment sessions observed`,
      ],
      [
        'the control arm carried no Safe Mode marker',
        (control?.wire.requests ?? []).every((request) => request.markerCount === 0),
        `${control?.wire.requests.length ?? 0} request(s) observed`,
      ],
      [
        'both arms recorded a wire length for every request',
        (control?.wire.requests ?? []).length > 0 && (treatment?.wire.requests ?? []).length > 0,
        `control=${control?.wire.requests.length ?? 0} treatment=${treatment?.wire.requests.length ?? 0}`,
      ],
      [
        'the scripted provider cannot solve the task, and the grader says so',
        control?.grading.passed === false && treatment?.grading.passed === false,
        'a rehearsal is a plumbing check, not a coding result',
      ],
      [
        `the pass fired in the treatment arm on the task\u2019s own repeated read (${rehearsalReadPath})`,
        // The free-only configuration (title suppressed, compaction off, one provider, an auxiliary
        // model that is never used) must not disturb the measurement it was added to protect: the
        // treatment arm elides the duplicate read, the marker reaches the wire, and the control arm
        // carries none. This is also what keeps the read-path choice honest — a rehearsal that read
        // a file the task does not contain would report `no-opportunity` here and fail.
        treatment?.mechanism === 'fired' &&
          (treatment?.apply?.requestsApplied ?? 0) > 0 &&
          (treatment?.apply?.elidedBytes ?? 0) > 0 &&
          (treatment?.wire.requests.reduce((total, request) => total + request.markerCount, 0) ?? 0) > 0 &&
          control?.mechanism === 'not-applicable' &&
          (control?.wire.requests ?? []).every((request) => request.markerCount === 0),
        `control: mechanism=${control?.mechanism ?? 'none'}, ${String(control?.wire.requests.reduce((total, request) => total + request.markerCount, 0) ?? 0)} marker(s); treatment: mechanism=${treatment?.mechanism ?? 'none'}, ${String(treatment?.apply?.elidedBytes ?? 0)} byte(s) elided, ${String(treatment?.wire.requests.reduce((total, request) => total + request.markerCount, 0) ?? 0)} marker(s) on the wire`,
      ],
      [
        'both arms registered the containment guard',
        control?.containment?.guard === 'loaded' && treatment?.containment?.guard === 'loaded',
        `control=${control?.containment?.guard ?? 'none'} treatment=${treatment?.containment?.guard ?? 'none'}`,
      ],
      [
        'both arms registered the pre-transmission model guard (the hook that refuses a request before it is sent)',
        [control, treatment].every(
          (observation) =>
            observation?.modelGuard?.guard === 'loaded' &&
            observation.modelGuard.hookRegistered === true &&
            observation.modelGuard.misconfigured === false &&
            observation.modelGuard.hook === MODEL_REQUEST_HOOK,
        ),
        `control: guard=${control?.modelGuard?.guard ?? 'none'}${control?.modelGuard?.hookRegistered === true ? ' (hook registered)' : ''}; treatment: guard=${treatment?.modelGuard?.guard ?? 'none'}${treatment?.modelGuard?.hookRegistered === true ? ' (hook registered)' : ''} — the layer that acts before a provider request is dispatched, on the one hook the runtime dispatches every request to`,
      ],
      [
        'neither arm attempted a model request outside the approved envelope',
        [control, treatment].every((observation) => observation?.modelGuard?.refused === 0),
        `control=${String(control?.modelGuard?.refused ?? 'none')} refusal(s) over ${String(control?.modelGuard?.invocations ?? 0)} request(s); treatment=${String(treatment?.modelGuard?.refused ?? 'none')} refusal(s) over ${String(treatment?.modelGuard?.invocations ?? 0)} request(s)`,
      ],
      [
        'the guard bounded each arm against that arm\u2019s own configuration digest',
        // The envelope is not a list the guard chose: it carries the digest of the configuration the
        // repository received, so an enforcement of a different policy than the one configured is
        // visible here rather than being assumed away.
        [control, treatment].every(
          (observation) =>
            observation?.modelGuard?.policyDigest !== undefined &&
            observation.modelGuard.policyDigest.length > 0 &&
            observation.modelGuard.policyDigest === observation.modelPolicy?.configDigest,
        ) &&
          control?.modelGuard?.policyDigest === treatment?.modelGuard?.policyDigest,
        `control=${control?.modelGuard?.policyDigest?.slice(0, 16) ?? 'none'} treatment=${treatment?.modelGuard?.policyDigest?.slice(0, 16) ?? 'none'} vs configuration ${control?.modelPolicy?.configDigest?.slice(0, 16) ?? 'none'}/${treatment?.modelPolicy?.configDigest?.slice(0, 16) ?? 'none'}`,
      ],
      [
        'the guard saw every model request the runtime dispatched in each arm',
        // Two independent registrations of the same hook: the guard's, and the driver's own counting
        // probe. Equal counts are what make the guard's "nothing was refused" a statement about the
        // requests this session made rather than about a hook that fired for none of them.
        [control, treatment].every(
          (observation) =>
            observation?.modelGuard?.invocations !== undefined &&
            observation.modelGuard.invocations ===
              (observation.modelPolicy?.requests.kinds[PRIMARY_REQUEST_KIND] ?? 0),
        ),
        `control: ${String(control?.modelGuard?.invocations ?? 'none')} guarded / ${String(control?.modelPolicy?.requests.kinds[PRIMARY_REQUEST_KIND] ?? 0)} counted; treatment: ${String(treatment?.modelGuard?.invocations ?? 'none')} guarded / ${String(treatment?.modelPolicy?.requests.kinds[PRIMARY_REQUEST_KIND] ?? 0)} counted`,
      ],
      [
        'both arms armed the in-session spending governor (the live initialisation path)',
        control?.inSessionGovernor?.armed === true && treatment?.inSessionGovernor?.armed === true,
        `control=${control?.inSessionGovernor?.armed === true ? 'armed' : (control?.inSessionGovernor?.reason ?? 'no evidence')} treatment=${treatment?.inSessionGovernor?.armed === true ? 'armed' : (treatment?.inSessionGovernor?.reason ?? 'no evidence')}`,
      ],
      [
        'both arms produced an accepted artifact (this run\u2019s own, complete output)',
        armAccepted.get('control') === true && armAccepted.get('treatment') === true,
        `control=${armAccepted.get('control') === true ? 'accepted' : 'refused'} treatment=${armAccepted.get('treatment') === true ? 'accepted' : 'refused'}`,
      ],
      [
        'both arms received the byte-identical free-only model configuration',
        control?.modelPolicy !== undefined &&
          treatment?.modelPolicy !== undefined &&
          control.modelPolicy.configDigest === treatment.modelPolicy.configDigest &&
          control.modelPolicy.configDigest === freeOnlyModelConfigDigest(freeOnlyModelConfig()) &&
          control.modelPolicy.configAccepted === true &&
          treatment.modelPolicy.configAccepted === true,
        `control=${control?.modelPolicy?.configDigest?.slice(0, 16) ?? 'none'} treatment=${treatment?.modelPolicy?.configDigest?.slice(0, 16) ?? 'none'} expected=${freeOnlyModelConfigDigest(freeOnlyModelConfig()).slice(0, 16)} (primary ${control?.modelPolicy?.primaryModel ?? 'none'}, auxiliary ${control?.modelPolicy?.auxiliaryModel ?? 'none'})`,
      ],
      [
        'the runtime resolved the free-only configuration in both arms (a dropped key would show here)',
        [control, treatment].every((observation) => {
          const resolved = resolvedPolicyRefusals(readResolvedModelPolicy(observation?.modelPolicy?.resolved) ?? unresolvedPolicy);
          return observation?.modelPolicy?.configAccepted === true && resolved.length === 0;
        }),
        `control: ${describeResolvedFor(control)}; treatment: ${describeResolvedFor(treatment)}`,
      ],
      [
        'the runtime\u2019s own model-request hook fired, so a kind count of zero is an observation and not a silence',
        [control, treatment].every((observation) => {
          const requests = observation?.modelPolicy?.requests;
          return (
            requests?.source === 'model-request-hooks' &&
            requests.kindsRegistered.includes(MODEL_REQUEST_HOOK) &&
            requests.registrationFailures.length === 0 &&
            // The positive control: this hook counted the requests the session really made. A
            // registration alone proves nothing — the runtime accepts any name and then never
            // calls one it does not dispatch.
            (requests.kinds[PRIMARY_REQUEST_KIND] ?? 0) > 0 &&
            requests.payloadKeys.length > 0
          );
        }),
        [control, treatment]
          .map((observation) => {
            const requests = observation?.modelPolicy?.requests;
            return `${observation?.identity.arm ?? 'arm'}: ${describeKinds(observation)} (hook ${requests?.kindsRegistered.join(',') || 'none'}, payload keys ${requests?.payloadKeys.join(',') || 'none'})`;
          })
          .join('; '),
      ],
      [
        'no automatic title generation, and no other auxiliary request, happened in either arm',
        [control, treatment].every((observation) => {
          const requests = observation?.modelPolicy?.requests;
          if (requests === undefined) return false;
          const extra = auxiliaryRequestKinds(requests.kinds);
          return extra.length === 0 && requests.auxiliaryRequests === 0;
        }),
        `control: ${describeKinds(control)}; treatment: ${describeKinds(treatment)} — the session title is supplied on the command line, so the runtime composes no title (or compaction, or generate) request at all`,
      ],
      [
        'the loopback endpoint\u2019s own record agrees: every request it received carried the agent-loop tool registry',
        [control, treatment].every((observation) => {
          const endpoint = observation?.modelPolicy?.requests.endpointKinds;
          const requests = observation?.modelPolicy?.requests;
          if (endpoint === undefined || requests === undefined) return false;
          return (
            endpoint.requests > 0 &&
            endpoint.withoutToolRegistry === 0 &&
            // The two readings are independent (the runtime's hook and the endpoint it was pointed
            // at), so agreement is the evidence; a disagreement is a finding, not a rounding error.
            endpoint.withToolRegistry === (requests.kinds[PRIMARY_REQUEST_KIND] ?? 0)
          );
        }),
        [control, treatment]
          .map((observation) => {
            const endpoint = observation?.modelPolicy?.requests.endpointKinds;
            return `${observation?.identity.arm ?? 'arm'}: ${endpoint === undefined ? 'no endpoint capture' : `${String(endpoint.requests)} request(s), ${String(endpoint.withToolRegistry)} with a tool registry, ${String(endpoint.withoutToolRegistry)} without`}`;
          })
          .join('; '),
      ],
      [
        'every request the endpoint received named the approved primary model and carried the agent-loop tool registry',
        [control, treatment].every(
          (observation) =>
            (observation?.wire.requests.length ?? 0) > 0 &&
            (observation?.wire.requests ?? []).every(
              (request) =>
                isApprovedEndpointModel(request.model, [FREE_ONLY_PRIMARY_MODEL]) &&
                request.hasTools === true,
            ),
        ),
        `control: ${describeRequestModels(control)}; treatment: ${describeRequestModels(treatment)} — expected [${endpointPrimaryIds.join(' or ')}], an auxiliary request would appear here without a tool registry, and any substitution as a different identifier`,
      ],
      [
        'no paid auxiliary model was configured or requested, and the approved pair is the only model set',
        [control, treatment].every(
          (observation) =>
            observation?.modelPolicy !== undefined &&
            observation.modelPolicy.auxiliaryModel === FREE_ONLY_AUXILIARY_MODEL &&
            observation.modelPolicy.approvedModels.length === FREE_ONLY_APPROVED_MODELS.length &&
            observation.modelPolicy.primaryModel === FREE_ONLY_PRIMARY_MODEL &&
            Object.keys(observation.modelPolicy.requests.modelsNamed).every((id) =>
              approvedNamedIds(observation).includes(id),
            ),
        ),
        `approved=[${FREE_ONLY_APPROVED_MODELS.join(', ')}]; models actually named: control: ${Object.keys(control?.modelPolicy?.requests.modelsNamed ?? {}).join(',') || 'none'}; treatment: ${Object.keys(treatment?.modelPolicy?.requests.modelsNamed ?? {}).join(',') || 'none'}`,
      ],
      [
        'each arm\u2019s containment probe ran a real session and produced its own whole artifact',
        probeControl?.provenanceOk === true && probeTreatment?.provenanceOk === true,
        `${describeProbe(probeControl)} | ${describeProbe(probeTreatment)}`,
      ],
      [
        'the guard registered its tool hook with a known workspace in both probe sessions',
        probeControl?.guard === 'loaded' &&
          probeTreatment?.guard === 'loaded' &&
          probeControl?.rootKnown === true &&
          probeTreatment?.rootKnown === true,
        `control=${probeControl?.guard ?? 'none'}/rootKnown=${String(probeControl?.rootKnown ?? false)} treatment=${probeTreatment?.guard ?? 'none'}/rootKnown=${String(probeTreatment?.rootKnown ?? false)}`,
      ],
      [
        'permitted in-workspace work still happened in both arms, so the prohibited half is not vacuous',
        stepOf(probeControl, 'read-inside')?.allowedTextReachedProvider === true &&
          probeControl?.allowedWriteCreated === true &&
          stepOf(probeTreatment, 'read-inside')?.allowedTextReachedProvider === true &&
          probeTreatment?.allowedWriteCreated === true,
        `control: read reached the provider=${String(stepOf(probeControl, 'read-inside')?.allowedTextReachedProvider ?? false)}, in-workspace write present=${String(probeControl?.allowedWriteCreated ?? false)}; treatment: read=${String(stepOf(probeTreatment, 'read-inside')?.allowedTextReachedProvider ?? false)}, write=${String(probeTreatment?.allowedWriteCreated ?? false)}`,
      ],
      [
        'every prohibited call was refused, with no content in its result, in both arms',
        refusedWithNoContent(probeControl) && refusedWithNoContent(probeTreatment),
        `control: ${String(refusedStepsOf(probeControl).length)} refused call(s), unexpected=[${describeUnexpected(probeControl)}]; treatment: ${String(refusedStepsOf(probeTreatment).length)} refused call(s), unexpected=[${describeUnexpected(probeTreatment)}]`,
      ],
      [
        'no prohibited call left a trace outside the workspace in either arm',
        refusedWithNoTrace(probeControl) && refusedWithNoTrace(probeTreatment),
        `control: ${describeTraces(probeControl)}; treatment: ${describeTraces(probeTreatment)} (the shell marker, the write and the patch targets checked on disk)`,
      ],
      [
        'the fetch tool never reached the probe\u2019s own loopback target in either arm',
        (probeControl?.fetchTargetsReceived.length ?? -1) === 0 &&
          (probeTreatment?.fetchTargetsReceived.length ?? -1) === 0,
        `control=${probeControl?.fetchTargetsReceived.length ?? 'no probe'} treatment=${probeTreatment?.fetchTargetsReceived.length ?? 'no probe'} request(s) reached the fetch target`,
      ],
      [
        'the guard recorded the refusals it made, by tool and reason',
        probeControl !== undefined &&
          probeControl.blockedCalls > 0 &&
          Object.keys(probeControl.blockedByTool).length > 0 &&
          probeControl.guardBlockReasons.length > 0,
        `control: ${describeRefusals(probeControl)}; treatment: ${describeRefusals(probeTreatment)}`,
      ],
      [
        'both arms showed the runtime\u2019s native permission denies (the second containment layer)',
        control?.nativePermissions?.allRequiredPresent === true &&
          treatment?.nativePermissions?.allRequiredPresent === true,
        `control=${control?.nativePermissions === undefined ? 'no evidence' : `${String(control.nativePermissions.rules.length)} rule(s), missing [${control.nativePermissions.missingRequiredDenies.join(',') || 'none'}]`} treatment=${treatment?.nativePermissions === undefined ? 'no evidence' : `${String(treatment.nativePermissions.rules.length)} rule(s), missing [${treatment.nativePermissions.missingRequiredDenies.join(',') || 'none'}]`}`,
      ],
      [
        'both arms enforced identically (same refused calls, reasons and tools)',
        enforcementSignature(probeControl) === enforcementSignature(probeTreatment) &&
          probeControl !== undefined,
        `control: ${enforcementSignature(probeControl)}; treatment: ${enforcementSignature(probeTreatment)}`,
      ],
    ];
    for (const [name, passed, detail] of checks) {
      process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name} — ${detail}\n`);
      if (!passed) {
        failures += 1;
      }
    }
    process.stdout.write(
      `\nRehearsal mechanism: control=${control?.mechanism ?? 'none'} treatment=${treatment?.mechanism ?? 'none'} (treatment elided ${treatment?.apply?.elidedBytes ?? 0} byte(s), ${treatment?.wire.requests.reduce((total, request) => total + request.markerCount, 0) ?? 0} marker(s) on the wire)\n`,
    );
  }

  return failures === 0 ? 0 : 1;
}

/**
 * Everything that must be true before a session is allowed to spend anything.
 *
 * Read-only and free: the plan and the arm driver's own environment probe, which asks
 * the *isolated* environment (private config and data home, `--standalone`) what it can
 * see. Asking the CLI without `--standalone` instead is answered by the developer's
 * background service, and Stage 1U showed what that costs: a green preflight followed
 * by sessions that could not start at all.
 */
async function preflightReport(
  options: CliOptions,
  armRuns: number,
  model: string | undefined,
): Promise<number> {
  const lines: string[] = [];
  lines.push('Level 2 preflight (no session is started, nothing is spent)');
  lines.push('');
  lines.push(`runtime:            ${options.cliPath}`);
  lines.push(`runtime present:    ${existsSync(options.cliPath) ? 'yes' : 'no'}`);
  lines.push(`planned arm runs:   ${armRuns}`);
  lines.push(`run cap:            ${options.maxRuns === undefined ? 'none' : options.maxRuns}`);
  lines.push(`unit cap (total):   ${options.maxUnits === undefined ? 'none' : options.maxUnits}`);
  lines.push(`unit cap (per run): ${options.maxUnitsPerRun === undefined ? 'none' : options.maxUnitsPerRun}`);
  lines.push(
    `cost cap (total):   ${options.maxCostUsd === undefined ? 'none' : `$${options.maxCostUsd.toFixed(2)}`}`,
  );
  lines.push(
    `cost cap (per run): ${options.maxCostUsdPerRun === undefined ? 'none' : `$${options.maxCostUsdPerRun.toFixed(2)}`}`,
  );
  lines.push(`session timeout:    ${options.timeoutMs === undefined ? 'driver default (20 min)' : `${options.timeoutMs} ms`}`);
  lines.push(
    'units: every reported token field added together, used only as an accounting bound; never reported as usage',
  );
  lines.push(
    'caps: the unit caps and the cumulative caps are checked after each session, so they bound the sequence only (post-session breakers).',
  );
  lines.push(
    'in-session spending: on the service runtime the per-session spending cap is enforced while the session runs — a governor reads the cost the runtime reports and calls the runtime\u2019s own session.interrupt when the cap is crossed, so the overshoot is limited to the steps that complete in one poll interval (1.5 s) plus the interrupt\u2019s latency, never by the cap. The wall-clock timeout is the only unconditional in-session stop; no in-session request-count or output-token limit is enforced.',
  );
  lines.push(
    'containment: every repository receives the same native permission policy (external_directory, bash, task and webfetch denied) plus a guard plugin that refuses any file path outside the session workspace and any shell-like call. The session reports its own guard evidence, and a session whose guard did not register is refused as a measurement rather than compared.',
  );
  lines.push(
    'model requests: every repository also receives a pre-transmission model guard, which refuses a request naming a model outside the approved free pair *before* it is dispatched — the provider policy admits every model the provider offers, so this is the layer that stops a same-provider paid model rather than discarding the measurement afterwards. A session whose guard did not register its hook, or in which any request was refused, is refused as a measurement.',
  );
  // Reported here as well as enforced at the live gate, so the operator sees it *before*
  // authorizing rather than discovering it in the refusal. Gitignored artifacts do not count.
  const checkedTree = readWorkingTree(process.cwd());
  lines.push(
    `working tree:       ${
      checkedTree.error !== undefined
        ? `UNREADABLE (${checkedTree.error}) — a live run would be REFUSED`
        : checkedTree.clean
          ? 'clean — a live run may be attributed to a revision'
          : `DIRTY (${String(checkedTree.entries.length)} uncommitted change(s)) — a live run would be REFUSED; commit or stash them first`
    }`,
  );
  lines.push(
    'failure rule: the first fatal arm outcome (no measurement, a refused model, a disengaged harness, a cap) ends the plan; the remaining planned runs are published as `not-run` and are never launched.',
  );
  lines.push('');
  lines.push(`selected runtime:   ${options.runtime}`);
  lines.push('Runtime catalogues (read-only, asked through the runtime\u2019s own model.list):');

  const probe = await probeArmEnvironment({
    model: model ?? '',
    workspaceRoot: options.workspaceRoot,
    ...(options.cliPath === undefined ? {} : { cliPath: options.cliPath }),
    runtime: options.runtime,
  });
  if (probe.probe === undefined) {
    for (const problem of probe.problems) {
      lines.push(`  ${problem}`);
    }
  } else {
    const facts = probe.probe;
    lines.push(`  runtime version:   ${facts.runtimeVersion ?? 'unreported'}`);
    lines.push(`  config home:       ${facts.isolatedConfigHome}`);
    lines.push(`  data home:         ${facts.isolatedDataHome}`);
    lines.push(`  credentials:       ${facts.storedCredentials} stored (values are never read or printed)`);
    lines.push(
      `  private server:    ${facts.standaloneCatalogue} model(s)${facts.standaloneModelListed === true ? `, ${model} listed` : facts.standaloneModelListed === false ? `, ${model} NOT listed` : ''}`,
    );
    lines.push(
      `  background service:${facts.serviceCatalogue} model(s)${facts.serviceModelListed === true ? `, ${model} listed` : facts.serviceModelListed === false ? `, ${model} NOT listed` : ''}`,
    );
    if (facts.pricing !== undefined) {
      lines.push(
        `  price (USD/M):     input ${facts.pricing.input ?? 'unreported'}, output ${facts.pricing.output ?? 'unreported'}, cache read ${facts.pricing.cacheRead ?? 'unreported'}, cache write ${facts.pricing.cacheWrite ?? 'unreported'}`,
      );
      lines.push(
        `  model status:      ${facts.modelStatus ?? 'unreported'}${facts.contextLimit === undefined ? '' : `, context ${facts.contextLimit} token(s)`}`,
      );
    }
    const isolation = isolationVerdict(facts, options.runtime);
    lines.push(
      `  isolation:         ${
        isolation.applicable ? (isolation.proven ? 'PROVEN' : 'UNPROVEN') : 'NOT APPLICABLE'
      } — ${isolation.detail}`,
    );
    const verdict = probeCanRunModel(facts, options.runtime);
    lines.push(`  verdict:           ${verdict.ok ? 'OK' : 'BLOCKED'} [${verdict.reason}] — ${verdict.detail}`);
    // The free-only verdict, on the runtime the caller selected: the same question the driver asks
    // before it spawns a session, so a model that cannot be shown free is visible before an
    // authorization is spent on it rather than in a refusal afterwards.
    lines.push(
      facts.freeOnly === undefined
        ? '  free-only policy:  NOT REPORTED — this driver build does not report the free-only verdict, so a live run would be refused'
        : `  free-only policy:  ${facts.freeOnly.verdict === 'free' ? 'FREE' : 'REFUSED'}${
            facts.freeOnly.verdict === 'free'
              ? ` — \`${facts.freeOnly.primaryModel}\` is approved and every price tier (${facts.freeOnly.priceFields.join(', ')}) is zero on the ${options.runtime} runtime; auxiliary calls use \`${facts.freeOnly.auxiliaryModel}\``
              : ` — ${facts.freeOnly.refusals.join('; ')}`
          }`,
    );
    lines.push(
      verdict.ok
        ? '                     a live run may be authorized on this runtime'
        : `                     authorizing a live run on \`${options.runtime}\` would spend nothing and measure nothing`,
    );
    for (const note of facts.notes) {
      lines.push(`  note: ${note}`);
    }
  }
  lines.push('');
  lines.push('Uncertainty this preflight cannot remove:');
  lines.push(
    '- the runtime exposes no price list to a CLI caller, so the caps are a usage bound and a cap on *reported* cost; the price rows behind that number come from the provider catalogue the runtime fetches, not from this repository;',
  );
  lines.push(
    '- the in-session governor acts on the cost the runtime reports: if a session reports no cost at all, the governor has nothing to act on, and the post-session tracker fails closed on that instead of continuing with an invisible bound;',
  );
  lines.push(
    '- a model can be listed and still be refused at run time (this happened in the Stage 1U pilot); the harness stops the plan on that refusal instead of repeating it;',
  );
  lines.push('- only a real session can confirm that the provider answers for the chosen model.');

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function runLive(options: CliOptions): Promise<number> {
  const declaration = resolveLevel2Declaration();
  // A live run restricted to a subset of the pack is a *pilot*: it is allowed to run
  // below the design's minimum samples, it is labelled as unable to support a
  // conclusion, and the report says so.
  const pilot = options.taskId !== undefined;
  const plan = buildPlan({
    pairsPerTask: options.pairs,
    tasks: tasksFor(options),
    declarationFingerprint: declaration.fingerprint,
    allowIncomplete: pilot,
  });
  const problems = validatePlan(plan);
  if (problems.length > 0 && !pilot) {
    for (const problem of problems) {
      process.stderr.write(`level2: ${problem}\n`);
    }
    return 2;
  }

  // Every refusal that stands between this authorization and a model call, evaluated before anything
  // is spawned or created. The caps are part of it: a live run with no per-session bound or no total
  // bound is refused rather than started, because nothing about it could be stopped.
  // The checkout this run would be attributed to. Read, never repaired: a dirty tree is refused
  // here rather than annotated in the report, because a report that cannot name the revision it
  // ran against is not reproducible. Gitignored artifacts are not changes.
  const workingTree = readWorkingTree(process.cwd());
  const guard = {
    approveLive: options.approveLive,
    model: options.model,
    runtime: options.runtime,
    cliPath: options.cliPath,
    cliPresent: existsSync(options.cliPath),
    workingTree,
    maxRuns: options.maxRuns,
    planArmRuns: plan.armRunsTotal,
    maxUnitsPerRun: options.maxUnitsPerRun,
    maxUnits: options.maxUnits,
    maxCostUsdPerRun: options.maxCostUsdPerRun,
    maxCostUsd: options.maxCostUsd,
    timeoutMs: options.timeoutMs,
  };
  const refusals = liveRunRefusals(guard);
  if (refusals.length > 0) {
    for (const refusal of refusals) {
      process.stderr.write(`level2: ${refusal}\n`);
    }
    return 2;
  }
  process.stdout.write(`${describeLiveBounds(guard)}\n`);
  // `model` is guaranteed by the guard above; the assertion keeps the type honest without a cast.
  const model = options.model as string;

  // Fail closed on an environment that cannot offer the model. The check asks the
  // arm's own isolated environment, is read-only and costs nothing, and is the check
  // Stage 1U needed: an authorization that starts sessions against an environment with
  // no account spends nothing and measures nothing. It is still not sufficient — a
  // listed model can be refused at run time — which is why the run also stops on that
  // refusal.
  const probed = await probeArmEnvironment({
    model,
    workspaceRoot: options.workspaceRoot,
    ...(options.cliPath === undefined ? {} : { cliPath: options.cliPath }),
    runtime: options.runtime,
  });
  if (probed.probe === undefined) {
    for (const problem of probed.problems) {
      process.stderr.write(`level2: refusing to start: ${problem}\n`);
    }
    return 2;
  }
  const isolation = isolationVerdict(probed.probe, options.runtime);
  process.stdout.write(
    `Isolation: ${
      isolation.applicable ? (isolation.proven ? 'proven' : 'unproven') : 'not applicable'
    } — ${isolation.detail}\n`,
  );
  const usable = probeCanRunModel(probed.probe, options.runtime);
  if (!usable.ok) {
    process.stderr.write(
      `level2: refusing to start on --runtime ${options.runtime}: ${usable.detail}. This is the Stage 1U failure mode; run --preflight to see both catalogues.\n`,
    );
    return 2;
  }
  process.stdout.write(`${usable.detail}.\n`);
  // Free-only enforcement before anything is spawned. Two independent refusals: the model must be
  // one of the approved free models, and the selected runtime's own catalogue must report a row
  // that is zero in every applicable tier. A model whose identifier merely contains `free` is not
  // evidence of anything, which is why the price row is what decides.
  if (probed.probe.freeOnly === undefined) {
    process.stderr.write(
      'level2: refusing to start: the arm driver did not report a free-only verdict, so the model\u2019s price cannot be shown to be zero in every tier and the run is not verifiably free.\n',
    );
    return 2;
  }
  if (probed.probe.freeOnly.verdict !== 'free') {
    process.stderr.write(
      `level2: refusing to start: ${probed.probe.freeOnly.refusals.join('; ')}. Run --preflight to see both catalogues and the free-only verdict.\n`,
    );
    return 2;
  }
  process.stdout.write(
    `Free-only policy: \`${probed.probe.freeOnly.primaryModel}\` is approved and priced at zero in every tier (${probed.probe.freeOnly.priceFields.join(', ')}) on the ${options.runtime} runtime; auxiliary calls are pinned to \`${probed.probe.freeOnly.auxiliaryModel}\`.\n`,
  );
  if (probed.probe.pricing !== undefined) {
    process.stdout.write(
      `The runtime reports this model at $${probed.probe.pricing.input ?? '?'} per million input token(s), $${probed.probe.pricing.output ?? '?'} per million output token(s), $${probed.probe.pricing.cacheRead ?? '?'} per million cached read token(s).\n`,
    );
  }

  const budget = createBudgetTracker({
    maxUnitsPerRun: options.maxUnitsPerRun,
    maxTotalUnits: options.maxUnits,
    maxCostUsdPerRun: options.maxCostUsdPerRun,
    maxCostUsd: options.maxCostUsd,
  });
  process.stdout.write(`${budget.describe()}\n`);

  process.stdout.write(
    `Level 2 live run: ${plan.armRunsTotal} arm run(s) across ${plan.tasks.length} task(s), model ${model}\n`,
  );
  if (pilot) {
    process.stdout.write(
      'PILOT: below the design\u2019s minimum samples. This validates the live path and cannot support a conclusion about tokens or correctness overall.\n',
    );
  }

  // Every planned run's task is resolved before the first session, so a plan naming an unknown
  // task fails without spending anything.
  const taskById = new Map<string, Level2Task>();
  for (const run of plan.runs) {
    const task = findTask(run.taskId);
    if (task === undefined) {
      process.stderr.write(`level2: no task named "${run.taskId}"\n`);
      return 2;
    }
    taskById.set(run.taskId, task);
  }

  // The runs are launched by `runArmSequence`, whose rule is that the first fatal outcome ends
  // the plan: no observation, a refused model, a disengaged harness, or a cap. Until 2026-10-12
  // this loop lived here and *continued* after a refused run, which is how the control session's
  // failure was followed by launching the treatment arm. Every planned run still gets a
  // disposition, so nothing authorized can disappear from the report.
  const sequence = await runArmSequence({
    plan,
    model,
    budget,
    requirements: {
      // The governor requirement is stated here as well as enforced in the driver: a live capped
      // service session that reports an unarmed governor is refused rather than compared.
      requireInSessionGovernor:
        options.runtime === 'service' && options.maxCostUsdPerRun !== undefined,
      // Both layers of containment must be evidenced: the plugin guard's enforcement is proven
      // against the installed runtime, and the native permission rules are what the runtime
      // itself resolved for this repository before the session started.
      requireNativePermissions: true,
    },
    report: (line) => {
      process.stdout.write(`${line}\n`);
    },
    execute: (run) =>
      runArm({
        task: taskById.get(run.taskId) as Level2Task,
        arm: run.arm,
        pairIndex: run.pairIndex,
        workspaceRoot: options.workspaceRoot,
        mode: 'live',
        runtime: options.runtime,
        model,
        cliPath: options.cliPath,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        // The same number the post-session cap uses, so there is one spending bound and
        // it is enforced both while the session runs and after it ends.
        ...(options.maxCostUsdPerRun === undefined
          ? {}
          : { inSessionCostCapUsd: options.maxCostUsdPerRun }),
        onProgress: (line) => {
          process.stdout.write(`      ${line}\n`);
        },
      }),
  });
  const { observations, dispositions, stop } = sequence;
  // The sequence counts its own fatal outcomes; the report adds the coding-regression failure
  // below, so the exit code reflects both.
  let failures = sequence.failures;

  const experiment = buildExperiment(
    observations,
    plan,
    plan.tasks.map((id) => requireTask(id)),
    dispositions,
  );
  const context = {
    model,
    harness: 'opencode-coding-task',
    pairsPerTask: plan.pairsPerTask,
    generatedAt: new Date().toISOString(),
  };
  const name = `level2-live-${context.generatedAt.replace(/[:.]/g, '-')}`;
  const paths = await writeReports(
    name,
    renderLevel2Markdown(experiment, context),
    renderLevel2Json(experiment, context),
  );
  process.stdout.write(`\n${renderLevel2Markdown(experiment, context)}\n`);
  for (const path of paths) {
    process.stdout.write(`Report written to ${path}\n`);
  }

  const dispositionCounts = dispositions.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
    return counts;
  }, {});
  process.stdout.write(
    `\nRun dispositions: ${dispositions.length} planned, ${dispositionCounts['solved'] ?? 0} solved, ${dispositionCounts['task-failed'] ?? 0} task-failed, ${dispositionCounts['invalid-measurement'] ?? 0} invalid-measurement, ${dispositionCounts['unavailable-evidence'] ?? 0} unavailable-evidence, ${dispositionCounts['not-run'] ?? 0} not-run\n`,
  );

  const spent = budget.state();
  process.stdout.write(
    `\nUsage accounting: ${spent.spentUnits} unit(s) over ${spent.runs} session(s)${spent.runsWithoutReportedUsage > 0 ? `, of which ${spent.runsWithoutReportedUsage} reported no token field at all (so the unit cap could not see them)` : ''}. Units are an accounting bound, not a reported measurement.\n`,
  );
  process.stdout.write(
    `Spending accounting: $${spent.spentCostUsd.toFixed(4)} reported over ${spent.runs} session(s)${spent.runsWithoutReportedCost > 0 ? `, of which ${spent.runsWithoutReportedCost} reported no cost (the provider's own figure, not an estimate)` : ''}.\n`,
  );
  if (stop !== undefined) {
    if (stop.code === 'budget') {
      process.stdout.write(`The run stopped early: ${stop.detail}.\n`);
    } else if (stop.code === 'model-refused') {
      process.stdout.write(
        'The run stopped early because the runtime refused the requested model; nothing was sent for those sessions.\n',
      );
    } else if (stop.code === 'not-engaged') {
      process.stdout.write(
        'The run stopped early because a session did not engage the harness, so the live path is broken rather than the model being slow or wrong.\n',
      );
    } else {
      process.stdout.write(
        `The run stopped early because a session produced no measurement (${stop.detail}); the remaining planned runs were not launched.\n`,
      );
    }
  }

  // A coding regression is a failure regardless of any token difference.
  if (experiment.tasks.some((task) => task.treatmentFailures > 0)) {
    failures += 1;
    process.stdout.write('FAIL  at least one treatment run did not solve its task\n');
  }
  if (!experiment.meetsMinimumSamples) {
    process.stdout.write('NOTE  the experiment did not reach the design\u2019s minimum samples\n');
  }

  return failures === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`level2: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  switch (options.mode) {
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case 'plan':
      return printPlan(
        buildPlan({
          pairsPerTask: options.pairs,
          tasks: tasksFor(options),
          declarationFingerprint: resolveLevel2Declaration().fingerprint,
          allowIncomplete: options.taskId !== undefined,
        }),
      );
    case 'preflight': {
      const plan = buildPlan({
        pairsPerTask: options.pairs,
        tasks: tasksFor(options),
        declarationFingerprint: resolveLevel2Declaration().fingerprint,
        allowIncomplete: options.taskId !== undefined,
      });
      return await preflightReport(options, plan.armRunsTotal, options.model);
    }
    case 'rehearse':
      return runRehearse(options);
    case 'live':
      return runLive(options);
    case 'offline-verify':
      return runOffline();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`level2: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
