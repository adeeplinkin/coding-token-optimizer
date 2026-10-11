/**
 * Running one arm of one task.
 *
 * The runner owns everything the benchmark side must own — the repository, the
 * instruction file, the grading — and delegates exactly one thing to the arm
 * driver: starting a single real session in an isolated environment and recording
 * content-free evidence about it.
 *
 * After the session ends the repository is graded **in place**, against pristine
 * tests, and only then is the observation assembled. A run that crashed, timed out
 * or produced no artifact is reported with its problems; it is never silently
 * dropped, because a missing run would otherwise look like a run that passed.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeTask } from './grade.js';
import { checkArmArtifactProvenance, type ArmInvalidReason } from './intake.js';
import { readArmArtifact } from './observation.js';
import { provisionTaskRepo, repoRevision, snapshotRevision } from './repos.js';
import { digest } from './repos.js';
import { resolveLevel2Declaration } from './variants.js';
import type { Level2Arm, Level2ArmObservation, Level2Task } from './types.js';

/** The arm driver script, resolved for both `src` and `dist` builds. */
export const ARM_DRIVER_PATH = fileURLToPath(
  new URL('../../../integrations/opencode/scripts/level2-arm.mjs', import.meta.url),
);

/** Default location of the installed OpenCode CLI on this platform. */
export const DEFAULT_CLI_PATH = join(
  process.env['LOCALAPPDATA'] ?? '.',
  'Programs',
  '@opencodedesktop',
  'resources',
  'opencode-cli.exe',
);

/** Options for one arm run. */
export interface ArmRunOptions {
  readonly task: Level2Task;
  readonly arm: Level2Arm;
  readonly pairIndex: number;
  /** Root under which this arm's repository and artifacts are created. */
  readonly workspaceRoot: string;
  readonly mode: 'live' | 'rehearse';
  /** Which runtime carries the session; defaults to the isolated private server. */
  readonly runtime?: ArmRuntimeMode;
  readonly model: string;
  readonly attempt?: number;
  /** Loopback provider base URL, required for `--mode rehearse`. */
  readonly baseUrl?: string;
  /** File the scripted provider reads twice, for `--mode rehearse`. */
  readonly readPath?: string;
  /**
   * A loopback provider's own capture file, when one is in the request path.
   *
   * It is the only source of real request lengths and marker counts: the runtime
   * hands the outbound body to the `http.request` hook as a `ReadableStream`, so a
   * plugin cannot measure it (Stage 1U).
   */
  readonly providerCapture?: string;
  readonly cliPath?: string;
  readonly timeoutMs?: number;
  readonly pluginModule?: string;
  /**
   * In-session spending cap in reported USD, when one is configured.
   *
   * On the service runtime the driver runs a supervisor that polls the cost the
   * runtime reports and calls the runtime's native `session.interrupt` when this cap
   * is crossed. The post-session cap in the budget tracker remains the sequence
   * bound; this is the bound that acts while the session is still running.
   */
  readonly inSessionCostCapUsd?: number;
  /** Called with each progress line, so a long run stays observable. */
  readonly onProgress?: (line: string) => void;
}

/** Outcome of one arm run. */
export interface ArmRunOutcome {
  readonly observation: Level2ArmObservation | undefined;
  readonly problems: readonly string[];
  readonly artifactPath: string;
  /** Repository revision as it stood after the arm finished. */
  readonly outputRevision: string | undefined;
  /** Exit code reported by the driver, or `undefined` when it never ran. */
  readonly driverExitCode: number | undefined;
  /**
   * True only when this run produced a measurement that may be compared. A non-zero
   * driver exit, a missing, stale, partial or foreign artifact, or a refused model all
   * make it false, and the caller must never publish such a run as valid. Stage 1V
   * published a crashed, stale run as a successful canary because this did not exist.
   */
  readonly accepted: boolean;
  /** Why the run was not accepted; present exactly when {@link accepted} is false. */
  readonly invalidReason: ArmInvalidReason | undefined;
  /**
   * True when the runtime refused the requested model, so the session never composed
   * a request. The caller must stop the plan on this rather than repeat it.
   */
  readonly modelUnavailable: boolean;
}

/** Where one arm run's files live. */
export function armWorkspace(
  workspaceRoot: string,
  taskId: string,
  pairIndex: number,
  arm: Level2Arm,
  attempt: number,
): string {
  return join(workspaceRoot, taskId, `p${pairIndex}-${arm}${attempt > 1 ? `-a${attempt}` : ''}`);
}

/**
 * What the arm driver's preflight reports about the *arm's* environment.
 *
 * Every field is content-free: counts, booleans and paths. No credential value, no
 * model list, no prompt text.
 */
/** The runtime a session talks to. */
export type ArmRuntimeMode = 'standalone' | 'service';

/** The runtime's own answer about where its config and data live. */
export interface ArmObservedPaths {
  readonly config: string | undefined;
  readonly data: string | undefined;
}

/**
 * Whether the private server really used the isolated directories, proven rather than assumed.
 *
 * The runtime is asked about its own directories (`debug paths`) with the overrides in place and
 * without them. The overrides are only *shown* to work when the isolated answer points inside the
 * directories this harness created **and** the unisolated answer points somewhere else. Without the
 * second half the check would pass on a runtime that ignores the variables entirely — which is
 * exactly the error the previous check made, on a command answered by the background service rather
 * than by the private server the runs actually use. On top of that, the isolated data home must
 * contain the runtime's own store: a file the runtime wrote, not a variable an operator set.
 *
 * Isolation is not claimed at all for a session on the background service, so the verdict says so
 * instead of pretending to check something that does not apply.
 */
export function isolationVerdict(
  probe: ArmEnvironmentProbe,
  runtime: ArmRuntimeMode = 'standalone',
): {
  readonly applicable: boolean;
  readonly proven: boolean;
  readonly detail: string;
} {
  if (runtime === 'service') {
    return {
      applicable: false,
      proven: false,
      detail:
        'not applicable on the background service: the session runs on this installation\u2019s own runtime, so no private home is claimed. The repository, the instruction and the Safe Mode switch remain the only experimental differences, and both arms share the environment.',
    };
  }
  const { isolatedPaths, unisolatedPaths, isolatedConfigHome, isolatedDataHome } = probe;
  if (isolatedPaths.config === undefined || isolatedPaths.data === undefined) {
    return {
      applicable: true,
      proven: false,
      detail: 'the runtime did not report its own config and data directories, so isolation is unproven',
    };
  }
  const inside = (value: string | undefined, root: string): boolean =>
    value !== undefined && value.replace(/\\/g, '/').toLowerCase().startsWith(root.replace(/\\/g, '/').toLowerCase());
  const configInside = inside(isolatedPaths.config, isolatedConfigHome);
  const dataInside = inside(isolatedPaths.data, isolatedDataHome);
  if (!configInside || !dataInside) {
    return {
      applicable: true,
      proven: false,
      detail: `the runtime ignored the isolated home (config reported as ${isolatedPaths.config ?? 'unreported'}, data as ${isolatedPaths.data ?? 'unreported'})`,
    };
  }
  const differs =
    unisolatedPaths.config !== isolatedPaths.config || unisolatedPaths.data !== isolatedPaths.data;
  if (!differs) {
    return {
      applicable: true,
      proven: false,
      detail: 'the unisolated control reported the same directories as the isolated run, so the check cannot distinguish the two and proves nothing',
    };
  }
  // What the session would actually obey: every configuration source the private server reports must
  // live inside the isolated root. A single source outside it would mean the developer's own
  // configuration is part of the run, whatever the directory variables say.
  const outsiders = probe.isolatedConfigSources.filter(
    (source) => !inside(source, isolatedConfigHome) && !inside(source, isolatedDataHome),
  );
  if (probe.isolatedConfigSources.length === 0) {
    return {
      applicable: true,
      proven: false,
      detail: 'the private server reported no configuration source at all, so there is nothing to show it would not load the developer\u2019s own configuration',
    };
  }
  if (outsiders.length > 0) {
    return {
      applicable: true,
      proven: false,
      detail: `the private server loads ${outsiders.length} configuration source(s) outside the isolated directory (${outsiders.join(', ')})`,
    };
  }
  if (!probe.isolatedStore) {
    return {
      applicable: true,
      proven: false,
      detail: 'the isolated data home holds no runtime store, so no private server can have used it yet',
    };
  }
  return {
    applicable: true,
    proven: true,
    detail: `the runtime used the isolated config and data homes, the unisolated control reported different ones (${unisolatedPaths.config ?? 'unreported'}), the private server loads ${String(probe.isolatedConfigSources.length)} configuration source(s), all inside the isolated directory, and it left its store in the isolated data home`,
  };
}

/** The price row the runtime itself reports for one model, in USD per million tokens. */
export interface ArmModelPrice {
  readonly input: number | undefined;
  readonly output: number | undefined;
  readonly cacheRead: number | undefined;
  readonly cacheWrite: number | undefined;
}

export interface ArmEnvironmentProbe {
  readonly cli: string;
  readonly runtimeVersion: string | undefined;
  readonly isolatedConfigHome: string;
  readonly isolatedDataHome: string;
  readonly modelRequested: string | undefined;
  readonly requestedRuntime: ArmRuntimeMode | undefined;
  readonly storedCredentials: number;
  /** Models the private server reports; `0` means a standalone session cannot start. */
  /** Directories the private server reported for itself, with the overrides in place. */
  readonly isolatedPaths: ArmObservedPaths;
  /** The same question asked without the overrides: the negative control. */
  readonly unisolatedPaths: ArmObservedPaths;
  /**
   * Configuration sources the *private server* says it loads, as paths.
   *
   * Asked through a server operation (`config.get`), so this is what a session would actually obey —
   * not merely where a variable points. `debug config` is not usable for this: it accepts no
   * `--standalone`, so the background service answers it and reports the developer's own file.
   */
  readonly isolatedConfigSources: readonly string[];
  /** The same question answered by the background service, as the negative control. */
  readonly unisolatedConfigSources: readonly string[];
  /** Whether the runtime wrote its own store inside the isolated data home. */
  readonly isolatedStore: boolean;
  readonly standaloneCatalogue: number;
  readonly standaloneModelListed: boolean | undefined;
  /** Models the running background service reports. */
  readonly serviceCatalogue: number;
  readonly serviceModelListed: boolean | undefined;
  readonly pricing: ArmModelPrice | undefined;
  readonly modelStatus: string | undefined;
  readonly contextLimit: number | undefined;
  readonly notes: readonly string[];
}

/** Result of asking the arm's environment what it can run. */
export interface ArmEnvironmentProbeOutcome {
  readonly probe: ArmEnvironmentProbe | undefined;
  readonly problems: readonly string[];
}

/**
 * Ask both runtimes what they can run, without starting a session.
 *
 * The private server and the background service answer with different catalogues, and
 * only one of them is the one a session will use, so both are probed and reported. A
 * caller must refuse a live run when the runtime it selected cannot confirm the model.
 */
export async function probeArmEnvironment(options: {
  readonly model: string;
  readonly workspaceRoot: string;
  readonly cliPath?: string;
  readonly runtime?: ArmRuntimeMode;
}): Promise<ArmEnvironmentProbeOutcome> {
  const out = join(options.workspaceRoot, 'preflight');
  const driverArgs = [
    ARM_DRIVER_PATH,
    '--mode',
    'preflight',
    '--model',
    options.model,
    '--out',
    out,
  ];
  if (options.runtime !== undefined) driverArgs.push('--runtime', options.runtime);
  if (options.cliPath !== undefined) driverArgs.push('--cli', options.cliPath);

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, driverArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

  const line = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  if (line === undefined) {
    return {
      probe: undefined,
      problems: [
        `The arm environment probe produced no report (exit ${String(result.code)}): ${result.stderr.trim().slice(0, 300) || 'no diagnostics'}`,
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { probe: undefined, problems: ['The arm environment report is not valid JSON.'] };
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const number = (key: string): number =>
    typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : 0;
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined;
  const boolean = (key: string): boolean | undefined =>
    typeof record[key] === 'boolean' ? (record[key] as boolean) : undefined;
  const optionalNumber = (key: string): number | undefined =>
    typeof record[key] === 'number' && Number.isFinite(record[key])
      ? (record[key] as number)
      : undefined;
  const priceRecord =
    typeof record['pricing'] === 'object' && record['pricing'] !== null
      ? (record['pricing'] as Record<string, unknown>)
      : undefined;
  const runtime = text('requestedRuntime');
  const stringList = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const paths = (key: string): ArmObservedPaths => {
    const value = record[key];
    const entry =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    return {
      config: typeof entry['config'] === 'string' ? (entry['config'] as string) : undefined,
      data: typeof entry['data'] === 'string' ? (entry['data'] as string) : undefined,
    };
  };

  return {
    probe: {
      cli: text('cli') ?? 'unknown',
      runtimeVersion: text('runtimeVersion'),
      isolatedConfigHome: text('isolatedConfigHome') ?? 'unknown',
      isolatedDataHome: text('isolatedDataHome') ?? 'unknown',
      modelRequested: text('modelRequested'),
      requestedRuntime: runtime === 'standalone' || runtime === 'service' ? runtime : undefined,
      storedCredentials: number('storedCredentials'),
      isolatedPaths: paths('isolatedPaths'),
      unisolatedPaths: paths('unisolatedPaths'),
      isolatedConfigSources: stringList(record['isolatedConfigSources']),
      unisolatedConfigSources: stringList(record['unisolatedConfigSources']),
      isolatedStore: record['isolatedStore'] === true,
      standaloneCatalogue: number('standaloneCatalogue'),
      standaloneModelListed: boolean('standaloneModelListed'),
      serviceCatalogue: number('serviceCatalogue'),
      serviceModelListed: boolean('serviceModelListed'),
      pricing:
        priceRecord === undefined
          ? undefined
          : {
              input: typeof priceRecord['input'] === 'number' ? priceRecord['input'] : undefined,
              output: typeof priceRecord['output'] === 'number' ? priceRecord['output'] : undefined,
              cacheRead:
                typeof priceRecord['cacheRead'] === 'number' ? priceRecord['cacheRead'] : undefined,
              cacheWrite:
                typeof priceRecord['cacheWrite'] === 'number' ? priceRecord['cacheWrite'] : undefined,
            },
      modelStatus: text('modelStatus'),
      contextLimit: optionalNumber('contextLimit'),
      notes: Array.isArray(record['notes'])
        ? record['notes'].filter((entry): entry is string => typeof entry === 'string')
        : [],
    },
    problems: [],
  };
}

/**
 * Whether the runtime a caller selected can offer the model, as the probe reported it.
 *
 * `standalone` asks about the private server; `service` asks about the background
 * service. A caller uses this to refuse a live run that could not start, rather than
 * discovering it as a run that spent authorization and measured nothing.
 */
/**
 * Why a runtime can or cannot run the requested model.
 *
 * The distinction matters because the two failures look identical in a session log and need
 * opposite responses: `no-catalogue` means this runtime holds no account/credential state, so a
 * session can never resolve *any* model, while `model-not-listed` means the catalogue is present and
 * the identifier (or the provider behind it) is the problem. Stage 1U's pilot reported the second
 * error text for the first cause, which is exactly the confusion this removes.
 */
export type ModelAvailabilityReason =
  | 'ok'
  | 'no-catalogue'
  | 'model-not-listed';

/** Verdict on whether one runtime can run the requested model. */
export interface ModelAvailabilityVerdict {
  readonly ok: boolean;
  readonly reason: ModelAvailabilityReason;
  readonly detail: string;
}

export function probeCanRunModel(
  probe: ArmEnvironmentProbe,
  runtime: ArmRuntimeMode,
): ModelAvailabilityVerdict {
  const catalogue = runtime === 'service' ? probe.serviceCatalogue : probe.standaloneCatalogue;
  const listed = runtime === 'service' ? probe.serviceModelListed : probe.standaloneModelListed;
  if (catalogue === 0) {
    return {
      ok: false,
      reason: 'no-catalogue',
      detail:
        runtime === 'service'
          ? 'no running service reported a model catalogue, so no session could resolve a model (this is the missing-account case, not a bad model identifier)'
          : 'the private server reports an empty model catalogue on this installation, so a standalone session could not resolve a model however the credential store is arranged (this is the missing-account case, not a bad model identifier)',
    };
  }
  if (listed !== true) {
    return {
      ok: false,
      reason: 'model-not-listed',
      detail: `the ${runtime} runtime reports ${catalogue} model(s) and does not offer \`${probe.modelRequested ?? 'the requested model'}\`, so the identifier or its provider is the problem`,
    };
  }
  return {
    ok: true,
    reason: 'ok',
    detail: `the ${runtime} runtime offers the requested model (${catalogue} model(s) reported)`,
  };
}

/**
 * Run one arm and grade it.
 *
 * The repository is provisioned fresh, so the arm cannot inherit anything from a
 * previous run — not files, not a build cache, not a session.
 */
export async function runArm(options: ArmRunOptions): Promise<ArmRunOutcome> {
  const attempt = options.attempt ?? 1;
  const workspace = armWorkspace(options.workspaceRoot, options.task.id, options.pairIndex, options.arm, attempt);
  const repo = join(workspace, 'repo');
  const artifacts = join(workspace, 'artifacts');
  const promptPath = join(workspace, 'prompt.txt');
  const artifactPath = join(artifacts, 'arm-observation.json');
  const problems: string[] = [];

  await provisionTaskRepo(repo, options.task);
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(promptPath, options.task.prompt, 'utf8');

  const declaration = resolveLevel2Declaration();
  const repositoryRevision = repoRevision(options.task.files);
  const promptHash = digest(options.task.prompt);
  const runId = `${options.task.id}:p${options.pairIndex}:${options.arm}`;
  // A fresh identity for this run, passed to the driver and required back in its artifact.
  // The workspace path is reused between runs, so without it an artifact an earlier run
  // left at this path would be read as this run's measurement.
  const runNonce = randomUUID();

  const driverArgs = [
    ARM_DRIVER_PATH,
    '--repo',
    repo,
    '--prompt-file',
    promptPath,
    '--arm',
    options.arm,
    '--out',
    artifacts,
    '--model',
    options.model,
    '--mode',
    options.mode,
    '--task-id',
    options.task.id,
    '--run-id',
    runId,
    '--run-nonce',
    runNonce,
    '--pair-index',
    String(options.pairIndex),
    '--attempt',
    String(attempt),
    '--repository-revision',
    repositoryRevision,
    '--prompt-hash',
    promptHash,
    '--plugin-module',
    options.pluginModule ??
      fileURLToPath(new URL('../../../integrations/opencode/dist/index.js', import.meta.url)),
  ];
  if (options.cliPath !== undefined) driverArgs.push('--cli', options.cliPath);
  if (options.runtime !== undefined) driverArgs.push('--runtime', options.runtime);
  if (options.baseUrl !== undefined) driverArgs.push('--base-url', options.baseUrl);
  if (options.readPath !== undefined) driverArgs.push('--read-path', options.readPath);
  if (options.providerCapture !== undefined) {
    driverArgs.push('--provider-capture', options.providerCapture);
  }
  if (options.timeoutMs !== undefined) driverArgs.push('--timeout-ms', String(options.timeoutMs));
  if (options.inSessionCostCapUsd !== undefined) {
    driverArgs.push('--session-cost-cap-usd', String(options.inSessionCostCapUsd));
  }

  // Freshness, enforced rather than assumed: any artifact already at this path belongs to
  // an earlier run and is removed before the driver starts.
  const artifactPreexisting = existsSync(artifactPath);
  if (artifactPreexisting) {
    rmSync(artifactPath, { force: true });
  }

  options.onProgress?.(`${runId}: starting ${options.mode} session`);

  const driverExitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, driverArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => {
      if ((code ?? -1) !== 0) {
        problems.push(
          `The arm driver exited with code ${String(code)}: ${stderr.trim().slice(0, 400) || 'no diagnostics'}`,
        );
      }
      resolve(code ?? -1);
    });
  });

  // Provenance first, before anything is graded: a run that did not exit cleanly, or whose
  // artifact is not this run's own whole output, is not a measurement and nothing else about
  // it should be published. This is where Stage 1V's crashed canary stops now.
  const artifactText = existsSync(artifactPath) ? readFileSync(artifactPath, 'utf8') : undefined;
  const provenance = checkArmArtifactProvenance({
    driverExitCode,
    artifactPreexisting,
    artifactText,
    expectedRunNonce: runNonce,
  });
  problems.push(...provenance.problems);
  if (!provenance.ok || provenance.parsed === undefined) {
    return {
      observation: undefined,
      accepted: false,
      invalidReason: provenance.invalidReason,
      problems,
      artifactPath,
      outputRevision: undefined,
      driverExitCode,
      modelUnavailable: false,
    };
  }
  const artifact = provenance.parsed;

  // Grade before assembling: the grading outcome is part of the observation, and a
  // failed grade is information the run must carry (not something to retry away).
  const grading = await gradeTask(options.task, repo, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onRestored: (changed) => {
      if (changed.length > 0) {
        problems.push(
          `The agent edited ${changed.length} graded file(s) (${changed.join(', ')}); grading used the pristine copies.`,
        );
      }
    },
  });
  const outputRevision = await snapshotRevision(repo);

  const merged = {
    ...artifact,
    grading: {
      passed: grading.passed,
      command: grading.command,
      exitCode: grading.exitCode,
      timedOut: grading.timedOut,
      durationMs: grading.durationMs,
      outputDigest: grading.outputDigest,
      outputExcerpt: grading.outputExcerpt,
      checks: grading.checks,
    },
  };

  const read = readArmArtifact(merged, {
    taskId: options.task.id,
    arm: options.arm,
    pairIndex: options.pairIndex,
  });
  problems.push(...read.problems);

  // The declaration is recorded with the run: a pair whose arms disagree about the
  // experiment is refused by the comparison contract, and this is where that
  // disagreement would first appear.
  if (read.observation !== undefined && declaration.fingerprint.length !== 64) {
    problems.push('The declared variant could not be fingerprinted.');
  }

  // The artifact is this run's own and whole, but its contents can still fail the
  // observation contract — that is a rejected measurement, not a degraded one.
  if (read.observation === undefined) {
    return {
      observation: undefined,
      accepted: false,
      invalidReason: read.modelUnavailable ? 'model-unavailable' : 'artifact-invalid',
      problems,
      artifactPath,
      outputRevision,
      driverExitCode,
      modelUnavailable: read.modelUnavailable,
    };
  }

  if (read.modelUnavailable) {
    problems.push(
      `The runtime refused the model \`${options.model}\`, so this session never composed a request. It is not a zero-token measurement: nothing was sent.`,
    );
    return {
      observation: undefined,
      accepted: false,
      invalidReason: 'model-unavailable',
      problems,
      artifactPath,
      outputRevision,
      driverExitCode,
      modelUnavailable: true,
    };
  }

  return {
    observation: read.observation,
    accepted: true,
    invalidReason: undefined,
    problems,
    artifactPath,
    outputRevision,
    driverExitCode,
    modelUnavailable: false,
  };
}
