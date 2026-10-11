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
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  hasNoReportedUsage,
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
import { describeLiveBounds, liveRunRefusals } from './guards.js';
import { checkLiveEngagement } from './engagement.js';
import { findTask, LEVEL2_TASKS } from './tasks.js';
import { requireTask } from './verify.js';
import { resolveLevel2Declaration } from './variants.js';
import { runOfflineVerification } from './verify.js';
import type { Level2ArmObservation, Level2RunDisposition, Level2Task } from './types.js';

const SCRIPTED_PROVIDER = fileURLToPath(
  new URL('../../../integrations/opencode/scripts/stage1r-capture-server.mjs', import.meta.url),
);

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

/** Start the loopback scripted provider and wait for its readiness line. */
async function startScriptedProvider(
  readPath: string,
  capturePath: string,
  toolCalls: number,
): Promise<{ readonly baseUrl: string; readonly stop: () => void }> {
  // The provider writes its capture file at startup, so its directory must exist
  // before it is spawned.
  await mkdir(dirname(capturePath), { recursive: true });

  const server = spawn(
    process.execPath,
    [
      SCRIPTED_PROVIDER,
      '--capture',
      capturePath,
      '--port',
      '0',
      '--mode',
      'scripted',
      '--read-path',
      readPath,
      '--tool-calls',
      String(toolCalls),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let diagnosis = '';
  server.stderr.on('data', (chunk) => {
    diagnosis += String(chunk);
  });

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let buffered = '';
    const timer = setTimeout(
      () =>
        rejectPort(
          new Error(`the scripted provider did not report readiness: ${diagnosis.trim().slice(0, 300)}`),
        ),
      15_000,
    );
    server.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      const match = /LISTENING (\d+)/.exec(buffered);
      if (match !== null) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    server.on('error', (error) => rejectPort(error));
    server.on('close', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        rejectPort(new Error(`the scripted provider exited with code ${String(code)}: ${diagnosis.trim().slice(0, 300)}`));
      }
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stop: () => {
      server.kill();
    },
  };
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
  const task = tasksFor(options)[0];
  if (task === undefined) {
    throw new Error('A rehearsal needs a task.');
  }
  if (!existsSync(options.cliPath)) {
    process.stderr.write(`level2: the OpenCode CLI was not found at ${options.cliPath}\n`);
    return 2;
  }

  const observations: Level2ArmObservation[] = [];
  const dispositions: Level2RunDisposition[] = [];
  const armAccepted = new Map<string, boolean>();
  let failures = 0;

  for (const arm of ['control', 'treatment'] as const) {
    const workspace = armWorkspace(options.workspaceRoot, task.id, 0, arm, 1);
    const readPath = join(workspace, 'repo', ...'data/catalog.json'.split('/'));
    const capturePath = join(workspace, 'provider-capture.jsonl');
    // The scripted provider answers two `read` calls for the same file, which is the
    // shape the pass needs; the capture file holds what the provider received.
    const provider = await startScriptedProvider(readPath, capturePath, 2);
    try {
      const outcome = await runArm({
        task,
        arm,
        pairIndex: 0,
        workspaceRoot: options.workspaceRoot,
        mode: 'rehearse',
        model: options.model ?? 'opencode/big-pickle',
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
  }

  if (observations.length === 2) {
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
      model: options.model ?? 'opencode/big-pickle',
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
    // Containment probe: prove the guard end to end, not just in unit tests.
    //
    // The scripted provider is pointed at a file *outside* the session's repository
    // copy, and a canary token in that file must never appear in the provider's own
    // capture of what it received. Run one extra session for it, and take the
    // in-workspace half from the control arm's existing run as the negative control:
    // without it, a probe whose session never read anything would look contained.
    // ------------------------------------------------------------------ //
    const probeWorkspace = armWorkspace(options.workspaceRoot, task.id, 9, 'control', 1);
    const probeCapturePath = join(probeWorkspace, 'provider-capture.jsonl');
    const canaryPath = join(probeWorkspace, 'containment-canary.txt');
    const canaryToken = `DR-TOKEN-CANARY-${String(Date.now())}`;
    let insideMarker: string | undefined;
    let insideMarkerFound = false;
    let outsideAttempted = false;
    let outsideTokenFound = true;
    let outsideGuardBlocks = 0;
    let probeError: string | undefined;
    try {
      // A distinctive phrase from the frozen catalogue fixture (letters, digits and
      // spaces only, so it survives JSON escaping verbatim). The pack's own tests pin
      // the fixture, so a change here fails loudly rather than silently weakening the
      // probe.
      const markerMatch = /[A-Za-z][A-Za-z0-9 ]{20,}/.exec(task.files['data/catalog.json'] ?? '');
      insideMarker = markerMatch === null ? undefined : markerMatch[0].trim();
      await mkdir(probeWorkspace, { recursive: true });
      await writeFile(
        canaryPath,
        `if this text reaches the provider, containment failed: ${canaryToken}\n`,
        'utf8',
      );
      const probeProvider = await startScriptedProvider(canaryPath, probeCapturePath, 1);
      try {
        await runArm({
          task,
          arm: 'control',
          pairIndex: 9,
          workspaceRoot: options.workspaceRoot,
          mode: 'rehearse',
          model: options.model ?? 'opencode/big-pickle',
          baseUrl: probeProvider.baseUrl,
          readPath: canaryPath,
          providerCapture: probeCapturePath,
          cliPath: options.cliPath,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } finally {
        probeProvider.stop();
      }
      const outsideCapture = await readFile(probeCapturePath, 'utf8');
      outsideAttempted = outsideCapture.trim().length > 0;
      outsideTokenFound = outsideCapture.includes(canaryToken);
      const guardText = await readFile(
        join(probeWorkspace, 'artifacts', 'containment-guard.jsonl'),
        'utf8',
      ).catch(() => '');
      outsideGuardBlocks = guardText.split('\n').filter((line) => line.includes('"kind":"blocked"')).length;

      const controlCapturePath = join(
        armWorkspace(options.workspaceRoot, task.id, 0, 'control', 1),
        'provider-capture.jsonl',
      );
      const controlCapture = await readFile(controlCapturePath, 'utf8');
      insideMarkerFound = insideMarker !== undefined && controlCapture.includes(insideMarker);
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
    }

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
        'both arms registered the containment guard',
        control?.containment?.guard === 'loaded' && treatment?.containment?.guard === 'loaded',
        `control=${control?.containment?.guard ?? 'none'} treatment=${treatment?.containment?.guard ?? 'none'}`,
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
        'an in-workspace read reaches the provider, so the containment probe is not vacuous',
        insideMarkerFound,
        insideMarkerFound
          ? `the catalogue text appeared in the control arm's provider capture`
          : `the catalogue text did not appear in the control arm's provider capture${probeError === undefined ? '' : ` (${probeError})`}`,
      ],
      [
        'a read outside the session workspace never reaches the provider',
        outsideAttempted && !outsideTokenFound,
        outsideAttempted
          ? `the provider capture ${outsideTokenFound ? 'contains' : 'does not contain'} the canary token; the guard recorded ${String(outsideGuardBlocks)} refusal(s)`
          : `the scripted out-of-workspace read was never attempted${probeError === undefined ? '' : `: ${probeError}`}`,
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
  const guard = {
    approveLive: options.approveLive,
    model: options.model,
    runtime: options.runtime,
    cliPath: options.cliPath,
    cliPresent: existsSync(options.cliPath),
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

  const observations: Level2ArmObservation[] = [];
  // Every planned run gets a disposition, including the ones refused or never started, so
  // nothing that was authorized can disappear from the report.
  const dispositions: Level2RunDisposition[] = [];
  let runsStarted = 0;
  let failures = 0;
  let stoppedByBudget: string | undefined;
  let stoppedByModel = false;
  let stoppedByEngagement: string | undefined;

  for (const run of plan.runs) {
    if (stoppedByBudget !== undefined || stoppedByModel || stoppedByEngagement !== undefined) {
      break;
    }
    runsStarted += 1;
    const task = findTask(run.taskId);
    if (task === undefined) {
      process.stderr.write(`level2: no task named "${run.taskId}"\n`);
      return 2;
    }
    const outcome = await runArm({
      task,
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
    });
    for (const problem of outcome.problems) {
      process.stdout.write(`NOTE  ${problem}\n`);
    }
    if (outcome.modelUnavailable) {
      // Repeating this would spend authorization without producing a measurement.
      stoppedByModel = true;
      failures += 1;
      dispositions.push({
        taskId: run.taskId,
        pairIndex: run.pairIndex,
        arm: run.arm,
        disposition: 'invalid-measurement',
        detail: 'the runtime refused the model, so this session never composed a request',
      });
      process.stdout.write(
        `STOP  the runtime refused the model \`${model}\` for ${run.taskId} pair ${run.pairIndex} ${run.arm}; stopping the plan rather than repeating it.\n`,
      );
      continue;
    }
    if (outcome.observation === undefined) {
      failures += 1;
      dispositions.push({
        taskId: run.taskId,
        pairIndex: run.pairIndex,
        arm: run.arm,
        disposition: 'invalid-measurement',
        detail: `refused as a measurement (${outcome.invalidReason ?? 'no observation'})`,
      });
      process.stdout.write(
        `FAIL  ${run.taskId} pair ${run.pairIndex} ${run.arm} produced no measurement (${outcome.invalidReason ?? 'no observation'})\n`,
      );
      continue;
    }
    process.stdout.write(`      ${describeObservation(outcome.observation)}\n`);
    const governor = outcome.observation.inSessionGovernor;
    if (governor !== undefined) {
      process.stdout.write(
        `      in-session spending bound: ${
          governor.armed
            ? `armed at $${governor.capUsd ?? '?'} (polls ${governor.polls}, reported cost ${governor.reportedCostUsd ?? 'none'}${governor.interrupted ? ', interrupt confirmed' : ''})`
            : `not armed (${governor.reason ?? 'no reason recorded'})`
        }\n`,
      );
    }

    // A session whose plugin never reached the runtime is not a datapoint, and it is not a
    // transient to retry: the same environment would produce the same nothing. Stage 1U's
    // pilot is the reason this is checked rather than assumed — it produced well-formed
    // observations of sessions that could not have measured anything.
    // The governor requirement is stated here as well as enforced in the driver: a live capped
    // service session that reports an unarmed governor is refused rather than compared.
    const engagement = checkLiveEngagement(outcome.observation, {
      requireInSessionGovernor:
        options.runtime === 'service' && options.maxCostUsdPerRun !== undefined,
    });
    process.stdout.write(`      ${engagement.detail}\n`);
    if (!engagement.measurable) {
      failures += 1;
      stoppedByEngagement = engagement.detail;
      dispositions.push({
        taskId: run.taskId,
        pairIndex: run.pairIndex,
        arm: run.arm,
        disposition: 'invalid-measurement',
        detail: `the session did not engage the harness: ${engagement.detail}`,
      });
      process.stdout.write(`STOP  ${engagement.detail}\n`);
      process.stdout.write(`      the arm artifact is at ${outcome.artifactPath}\n`);
      continue;
    }
    observations.push(outcome.observation);

    // A measured run, classified in the report's own vocabulary: the coding outcome first
    // (it is the gate), then whether the host reported anything to compare.
    const solved = outcome.observation.grading.passed;
    if (hasNoReportedUsage(outcome.observation)) {
      dispositions.push({
        taskId: run.taskId,
        pairIndex: run.pairIndex,
        arm: run.arm,
        disposition: 'unavailable-evidence',
        detail: `the task ${solved ? 'passed' : 'FAILED'} its own tests, and the host reported no token field, so no token comparison can be made`,
      });
    } else {
      dispositions.push({
        taskId: run.taskId,
        pairIndex: run.pairIndex,
        arm: run.arm,
        disposition: solved ? 'solved' : 'task-failed',
        detail: `the task ${solved ? 'passed' : 'FAILED'} its own tests (graded outside the session, against pristine tests)`,
      });
    }

    const decision = budget.observe(outcome.observation);
    if (!decision.allowed) {
      stoppedByBudget = decision.detail;
      failures += 1;
      process.stdout.write(`STOP  usage cap reached: ${decision.detail}\n`);
    }
  }

  // Runs the plan stopped before are still planned runs: they are published as `not-run`
  // rather than omitted, so the report accounts for every authorized session.
  for (const run of plan.runs.slice(runsStarted)) {
    dispositions.push({
      taskId: run.taskId,
      pairIndex: run.pairIndex,
      arm: run.arm,
      disposition: 'not-run',
      detail: 'the plan stopped before this run started',
    });
  }

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
  if (stoppedByBudget !== undefined) {
    process.stdout.write(`The run stopped early: ${stoppedByBudget}.\n`);
  }
  if (stoppedByModel) {
    process.stdout.write(
      'The run stopped early because the runtime refused the requested model; nothing was sent for those sessions.\n',
    );
  }
  if (stoppedByEngagement !== undefined) {
    process.stdout.write(
      'The run stopped early because a session did not engage the harness, so the live path is broken rather than the model being slow or wrong.\n',
    );
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
