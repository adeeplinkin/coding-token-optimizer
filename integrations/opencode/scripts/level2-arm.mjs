/**
 * Stage 1U **Level 2 arm driver** — one arm, one task, one session.
 *
 * It exists so the paired coding experiment in `benchmarks/` never has to touch a
 * runtime detail. The benchmark side owns the task pack, the repositories, the
 * grading and the comparison; this side owns exactly the three things that need a
 * real OpenCode process:
 *
 * 1. **Isolation.** The session runs in the task repository with a private config
 *    and data home, so nothing about the developer's own installation can change the
 *    result and nothing from the run can leak into it. See
 *    {@link isolationEnvironment}: the private homes are also what makes a private
 *    server carry no account, which is a fact the preflight mode reports rather than a
 *    detail any live run may discover on its own.
 * 2. **The arm's switch.** Both arms load the *same* shipped plugin; the only
 *    difference is `DR_TOKEN_SAFE_MODE` (`off` for the control arm, `apply` for the
 *    treatment arm).
 * 3. **Content-free evidence.** The session summary the shipped observer writes
 *    (token fields, tool counts, and the Safe Mode apply counters) plus a
 *    length-only view of the requests that left the process.
 *
 *    Where that view comes from is itself a measured fact. Stage 1U found that the
 *    runtime hands the outbound body to `session.hook("http.request")` as a
 *    **ReadableStream**, so a plugin cannot measure the request it is about to send;
 *    the probe therefore records only that the hook fired and how many times. Real
 *    request lengths and marker counts can only come from an endpoint the run was
 *    pointed at, which is why `--provider-capture` (a loopback provider's own record
 *    of what it received) is what produces wire evidence, and why a live run against
 *    a real provider reports `hook-unmeasurable` instead of a fake measurement.
 *
 * Two ways to run it:
 *
 * - `--mode live` uses the configured provider for `--model` (this is the billable
 *   path and is only ever invoked after the user authorized a run);
 * - `--mode rehearse` points the provider at a loopback scripted server, so the whole
 *   pipeline — plugin load, apply, wire observation, summary capture, artifact — is
 *   exercised end to end with **no model call, no credential and no cost**. A
 *   rehearsal cannot solve a coding task, and is asserted as such; it is a plumbing
 *   check.
 * - `--mode preflight` starts no session and spends nothing: it asks the arm's own
 *   isolated environment what it can see (`auth list --standalone`,
 *   `models --standalone`) and prints counts, so a caller can refuse to authorize a
 *   live run that could not start.
 *
 * Usage:
 *   node level2-arm.mjs --repo <dir> --prompt-file <file> --arm control|treatment
 *                       --out <dir> --model <id> --mode live|rehearse|preflight
 *                       [--cli <path>] [--base-url <loopback url>] [--read-path <path>]
 *                       [--timeout-ms <n>] [--plugin-module <path>]
 *                       [--provider-capture <jsonl>]
 *
 * Exit codes: 0 = the arm ran and an artifact was written; 2 = the driver could not
 * run (missing plugin module, spawn failure, unusable repository).
 */
import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER_PREFIX = '[dr-token/safe-mode/v1:';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The session title this driver supplies on the command line, for every arm.
 *
 * Passing `--title` is what stops the runtime from generating one: measured offline against the
 * pinned runtime, a session started without it composed **two** auxiliary requests (a
title request on the configured auxiliary model, and a second one on the session model),
 * while the same session with `--title` composed none (2 requests instead of 4, all primary).
 *
 * One constant for both arms, deliberately: the title never reaches a model, so it can carry no
 * measurement, and identical bytes keep the two arms' command lines comparable.
 */
const SESSION_TITLE = 'dr-token-level2';

/**
 * The hook name the runtime dispatches every model request to, and the kinds it reports.
 *
 * Read from the policy module rather than written here, because both sides of the harness depend
 * on the *same* name: the driver registers it, and the benchmark checks require the counts to have
 * come from it. `MODEL_REQUEST_HOOK` documents the measurement behind the name — including the
 * negative result (a synthetic per-kind name registers without error and is never called) that
 * makes a count taken any other way worthless.
 */
function requireRequestKindVocabulary() {
  const policy = requirePolicy();
  if (
    typeof policy.MODEL_REQUEST_HOOK !== 'string' ||
    !Array.isArray(policy.REQUEST_KINDS) ||
    policy.REQUEST_KINDS.length < 2
  ) {
    fail(
      'the free-only model policy does not export the request-kind vocabulary (MODEL_REQUEST_HOOK, REQUEST_KINDS), so the driver cannot register the one hook that makes an absent request measurable. Refusing to run.',
    );
  }
  return { hook: policy.MODEL_REQUEST_HOOK, kinds: [...policy.REQUEST_KINDS] };
}

/**
 * The free-only model policy, imported from the benchmark package's built output.
 *
 * The policy lives in `benchmarks/src/level2/free-model-policy.ts` — one implementation, used by
 * both sides of the harness: the driver applies it to the repository it is about to run, and the
 * benchmark side re-derives the same verdict from the artifact. Duplicating it here would let the
 * two drift, which is exactly how a paid model starts a session that everyone believes is free.
 *
 * The import is **required**: if it fails, every mode fails closed rather than running a session
 * whose envelope it cannot state.
 */
const policyModulePath =
  process.env.DR_TOKEN_FREE_POLICY_MODULE ??
  join(import.meta.dirname, '..', '..', '..', 'benchmarks', 'dist', 'level2', 'free-model-policy.js');
let policy;
let policyImportError;
try {
  policy = await import(pathToFileURL(policyModulePath).href);
} catch (error) {
  policy = undefined;
  policyImportError = error instanceof Error ? error.message : String(error);
}

/**
 * The policy module, or a refusal to run at all.
 *
 * A missing build is a configuration error, not a reason to proceed without the policy: the
 * checks that matter (approval list, price row, resolved configuration) all live in that module.
 */
function requirePolicy() {
  if (policy === undefined || typeof policy.freeOnlyModelConfig !== 'function') {
    fail(
      `the free-only model policy could not be imported from ${policyModulePath} (${String(policyImportError ?? 'the module does not export freeOnlyModelConfig')}); build the workspaces first (npm run build) or point DR_TOKEN_FREE_POLICY_MODULE at the built module. Refusing to run without the policy that decides whether a model may be used.`,
    );
  }
  return policy;
}

function parseArgs(argv) {
  const args = {
    repo: undefined,
    promptFile: undefined,
    arm: undefined,
    out: undefined,
    model: undefined,
    mode: 'live',
    // Which runtime a session talks to. `standalone` is the isolated private server;
    // `service` is the developer's already-running background service. Stage 1U
    // measured that only the service has an account model catalogue on this
    // installation, which is why the preflight reports both instead of assuming.
    runtime: 'standalone',
    cli: join(
      process.env.LOCALAPPDATA ?? '.',
      'Programs',
      '@opencodedesktop',
      'resources',
      'opencode-cli.exe',
    ),
    baseUrl: undefined,
    readPath: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pluginModule: undefined,
    // Identity supplied by the caller, so the artifact is complete as written and a
    // mislabelled run is caught by the caller's validation rather than patched here.
    taskId: undefined,
    runId: undefined,
    pairIndex: undefined,
    attempt: undefined,
    repositoryRevision: undefined,
    promptHash: undefined,
    optimizerRevision: undefined,
    providerCapture: undefined,
    // A per-run identity generated by the caller and stamped into the artifact. It is
    // what lets the caller tell this run's artifact from one an earlier run left at the
    // same path — Stage 1V read a previous run's artifact as a live measurement because
    // the workspace path is reused and nothing distinguished the two.
    runNonce: undefined,
    // In-session spending bound. When set on a live service session, the driver runs
    // a supervisor beside the session that calls the runtime's own `session.interrupt`
    // once the reported cost crosses it. The post-session caps in the benchmark side
    // remain the sequence bound; this one acts while the session is still running.
    sessionCostCapUsd: undefined,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--repo') args.repo = value;
    else if (key === '--prompt-file') args.promptFile = value;
    else if (key === '--arm') args.arm = value;
    else if (key === '--out') args.out = value;
    else if (key === '--model') args.model = value;
    else if (key === '--mode') args.mode = value;
    else if (key === '--runtime') args.runtime = value;
    else if (key === '--cli') args.cli = value;
    else if (key === '--base-url') args.baseUrl = value;
    else if (key === '--read-path') args.readPath = value;
    else if (key === '--timeout-ms') args.timeoutMs = Number(value);
    else if (key === '--plugin-module') args.pluginModule = value;
    else if (key === '--task-id') args.taskId = value;
    else if (key === '--run-id') args.runId = value;
    else if (key === '--pair-index') args.pairIndex = Number(value);
    else if (key === '--attempt') args.attempt = Number(value);
    else if (key === '--repository-revision') args.repositoryRevision = value;
    else if (key === '--prompt-hash') args.promptHash = value;
    else if (key === '--optimizer-revision') args.optimizerRevision = value;
    else if (key === '--provider-capture') args.providerCapture = value;
    else if (key === '--run-nonce') args.runNonce = value;
    else if (key === '--session-cost-cap-usd') args.sessionCostCapUsd = Number(value);
    if (value !== undefined && key.startsWith('--')) index += 1;
  }
  return args;
}

const args = parseArgs(process.argv);

function fail(message) {
  process.stderr.write(`level2-arm: ${message}\n`);
  process.exit(2);
}

if (args.mode !== 'live' && args.mode !== 'rehearse' && args.mode !== 'preflight') {
  fail('--mode must be live, rehearse or preflight');
}
if (args.runtime !== 'standalone' && args.runtime !== 'service') {
  fail('--runtime must be standalone or service');
}

/**
 * The isolation variables that make a session private.
 *
 * Verified against the pinned runtime on Windows and POSIX: `XDG_CONFIG_HOME` and
 * `XDG_DATA_HOME` are honoured on both, and `PWD` (not the child's real working
 * directory) is what the runtime resolves the session's project from.
 *
 * `--standalone` matters just as much as the variables. Without it the CLI proxies to
 * the developer's already-running background service, whose environment and account
 * state are **not** the ones below, so `auth list` and `models` would answer about the
 * developer's installation instead of about the arm. Stage 1U's pilot failed exactly
 * because a private server with a private data home had no account, and therefore no
 * model catalogue: the failure looked like a bad model id and was not one.
 */
function isolationEnvironment(configHome, dataHome, projectDirectory) {
  return {
    ...process.env,
    PWD: projectDirectory,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
  };
}

/* -------------------------------------------------------------------------- */
/* Preflight: what can the arm's own environment see?                          */
/* -------------------------------------------------------------------------- */

/**
 * Ask the arm's environment — not this shell's — what it can run.
 *
 * Read-only and free: `auth list` and `models` are the runtime's own listings, both
 * asked with `--standalone` under the same isolated homes a session would get. The
 * output is counts and booleans only; no credential value is ever read or printed.
 *
 * This exists because the cheaper check was wrong. Asking the *background service* (no
 * `--standalone`) reports the developer's catalogue, so a preflight could pass while
 * every live session failed. A live run is now refused on the facts below.
 */
function environmentProbe() {
  const P = requirePolicy();
  const root =
    args.out === undefined
      ? join(tmpdir(), `dr-token-level2-preflight-${process.pid}`)
      : join(args.out, 'iso');
  const configHome = join(root, 'config');
  const dataHome = join(root, 'data');
  mkdirSync(configHome, { recursive: true });
  mkdirSync(dataHome, { recursive: true });
  const isolatedEnv = isolationEnvironment(configHome, dataHome, process.cwd());

  const ask = (cliArgs, env) => {
    const result = spawnSync(args.cli, cliArgs, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 240_000,
      ...(env === undefined ? {} : { env }),
    });
    return {
      status: typeof result.status === 'number' ? result.status : null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? '').trim().slice(0, 300),
    };
  };

  /**
   * The model catalogue one runtime reports, as `model.list` returns it.
   *
   * The catalogue is the authoritative answer to two questions this harness needs
   * before it may spend anything: can this runtime offer the requested model at all,
   * and what does the runtime itself say that model costs. Nothing here is a model
   * call; the endpoint is read-only.
   */
  const catalogue = (env, standalone) => {
    const response = ask(
      standalone ? ['api', 'model.list', '--standalone'] : ['api', 'model.list'],
      env,
    );
    let models = [];
    try {
      const parsed = JSON.parse(response.stdout);
      if (Array.isArray(parsed?.data)) models = parsed.data;
    } catch {
      models = [];
    }
    const ids = models.flatMap((model) =>
      typeof model?.modelID === 'string'
        ? [`${model.providerID ?? 'unknown'}/${model.modelID}`]
        : [],
    );
    const requested = args.model === undefined ? undefined : models.find(
      (model) => `${model?.providerID ?? 'unknown'}/${model?.modelID ?? ''}` === args.model,
    );
    const price = (requested?.cost ?? []).find((entry) => typeof entry === 'object') ?? null;
    return {
      models: ids.length,
      modelListed: args.model === undefined ? null : ids.includes(args.model),
      status: response.status,
      // Kept so a caller can tell "the runtime reported nothing" from "the request
      // itself failed"; the text is the runtime's own, truncated, and never a value.
      stdoutBytes: response.stdout.length,
      diagnostics: response.stderr,
      price:
        price === null
          ? null
          : {
              input: typeof price.input === 'number' ? price.input : null,
              output: typeof price.output === 'number' ? price.output : null,
              cacheRead:
                typeof price.cache?.read === 'number' ? price.cache.read : null,
              cacheWrite:
                typeof price.cache?.write === 'number' ? price.cache.write : null,
            },
      modelStatus: typeof requested?.status === 'string' ? requested.status : null,
      modelEnabled: typeof requested?.enabled === 'boolean' ? requested.enabled : null,
      contextLimit:
        typeof requested?.limit?.context === 'number' ? requested.limit.context : null,
    };
  };

  /**
   * What the runtime says its own directories are, per mode.
   *
   * `debug paths` is the runtime's own answer, so comparing it with the directories
   * this driver created is a *proof* that the overrides took effect rather than an
   * assumption that they were honoured. The negative control (the same question asked
   * without the overrides) is what makes the positive answer meaningful: a check that
   * passes whichever answer comes back is not a check.
   */
  const observedPaths = (withOverrides) => {
    // `debug paths` does not accept `--standalone` (it prints its help instead), and it does not need
    // it: the runtime computes these paths from the environment it is handed, which is exactly the
    // question being asked.
    const response = ask(['debug', 'paths'], withOverrides ? isolatedEnv : undefined);
    const line = (key) => {
      const match = new RegExp(`(?:^|\\n)\\s*${key}\\s+(.+?)\\r?$`, 'm').exec(response.stdout);
      return match === null ? null : match[1].trim();
    };
    return {
      config: line('config'),
      data: line('data'),
      status: response.status,
    };
  };

  /**
   * The configuration sources a server actually loads, asked of that server.
   *
   * `config.get` is a server operation, so with `--standalone` it is the private
   * server answering about itself — the strongest available form of "is this run
   * isolated": not where the variables point, but which files the session would obey.
   *
   * `opencode debug config` is deliberately **not** used for this. That subcommand takes
   * no `--standalone` flag, so the running background service answers it, and a probe
   * built on it reports the developer's config file even while the private server is
   * correctly isolated. That mistake is what made the old wire check say this platform
   * ignores XDG overrides.
   */
  const configSources = (env, standalone) => {
    const response = ask(
      standalone ? ['api', 'config.get', '--standalone'] : ['api', 'config.get'],
      env,
    );
    try {
      const parsed = JSON.parse(response.stdout);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => (entry && typeof entry.path === 'string' ? entry.path : undefined))
        .filter((path) => typeof path === 'string');
    } catch {
      return [];
    }
  };

  const version = ask(['--version']);
  const auth = ask(['auth', 'list', '--standalone'], isolatedEnv);
  const isolated = catalogue(isolatedEnv, true);
  const isolatedPaths = observedPaths(true);
  const unisolatedPaths = observedPaths(false);
  const isolatedConfigSources = configSources(isolatedEnv, true);
  const unisolatedConfigSources = configSources(undefined, false);
  // Server-side proof that the isolated home was really used: the runtime wrote its own store there.
  const isolatedStore = existsSync(join(dataHome, 'opencode', 'opencode.db'));
  // Asked without `--standalone`, so the answer comes from whichever background
  // service is running; it is compared with the isolated answer, never substituted
  // for it.
  const service = catalogue(undefined, false);

  const storedCredentials = auth.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /stored/i.test(line)).length;
  const versionMatch = /(\d+\.\d+\.\d+)/.exec(`${version.stdout}${version.stderr}`);

  // The free-only verdict, decided on the catalogue of the runtime the caller selected — the
  // same question the live guard asks before it spawns anything, reported here so an operator
  // sees the answer before authorizing rather than in a refusal afterwards.
  const selected = args.runtime === 'service' ? service : isolated;
  const priceFacts = {
    model: args.model ?? undefined,
    runtime: args.runtime,
    catalogueSize: selected.models,
    listed: selected.modelListed === null ? undefined : selected.modelListed,
    priceRow: selected.price ?? undefined,
  };
  const policyRefusals = P.freeOnlyRefusals(priceFacts);

  const report = {
    schemaVersion: 2,
    mode: 'preflight',
    cli: args.cli,
    runtimeVersion: versionMatch === null ? null : versionMatch[1],
    isolatedConfigHome: configHome,
    isolatedDataHome: dataHome,
    projectDirectory: process.cwd(),
    modelRequested: args.model ?? null,
    requestedRuntime: args.runtime,
    storedCredentials,
    isolatedPaths,
    unisolatedPaths,
    isolatedConfigSources,
    unisolatedConfigSources,
    isolatedStore,
    standaloneCatalogue: isolated.models,
    standaloneModelListed: isolated.modelListed,
    standaloneStatus: isolated.status,
    standaloneDiagnostics: isolated.diagnostics,
    serviceCatalogue: service.models,
    serviceModelListed: service.modelListed,
    serviceStatus: service.status,
    serviceStdoutBytes: service.stdoutBytes,
    serviceDiagnostics: service.diagnostics,
    pricing: service.price ?? isolated.price,
    modelStatus: service.modelStatus ?? isolated.modelStatus,
    modelEnabled: service.modelEnabled ?? isolated.modelEnabled,
    contextLimit: service.contextLimit ?? isolated.contextLimit,
    freeOnly: {
      primaryModel: P.FREE_ONLY_PRIMARY_MODEL,
      auxiliaryModel: P.FREE_ONLY_AUXILIARY_MODEL,
      approvedModels: [...P.FREE_ONLY_APPROVED_MODELS],
      priceFields: [...P.FREE_ONLY_PRICE_FIELDS],
      priceVerifiedFree: P.isZeroPriceRow(priceFacts.priceRow),
      refusals: [...policyRefusals],
      verdict: policyRefusals.length === 0 ? 'free' : 'refused',
      config: P.freeOnlyModelConfig(),
      configDigest: P.freeOnlyModelConfigDigest(P.freeOnlyModelConfig()),
      resolvedConfigText: P.freeOnlyModelConfigText(P.freeOnlyModelConfig()),
    },
    notes: [
      'Both catalogues were asked read-only through model.list: one with --standalone under the isolated config and data homes, one without so the running background service answers.',
      'The runtime was asked for its own directories with the overrides and without them: the isolated answer is only meaningful if the unisolated answer differs from it. The isolated data home is also checked for the runtime store the private server writes there.',
      'The private server was asked which configuration sources it loads (config.get over a server call, not the debug config subcommand, which no private server answers). Those paths are recorded so a caller can see that no source outside the isolated directory is in play.',
      isolated.models === 0
        ? 'The private server reports an empty catalogue on this installation, so a standalone session cannot resolve a model however the credential store is arranged.'
        : 'The private server reports a catalogue that can be checked against the requested model.',
      service.models === 0
        ? 'No running service reported a catalogue, so no runtime here can offer a model.'
        : 'The background service reports a catalogue, which is the account-scoped one.',
      storedCredentials === 0
        ? 'The isolated environment holds no stored credential; its value is never read either way.'
        : 'A stored credential is visible to the isolated environment; its value is never read or printed.',
      service.price === null
        ? 'No price row was reported for the requested model, so no cost estimate can be derived from the runtime.'
        : 'The price row is the runtime\u2019s own, in USD per million tokens, and it is what the reported session cost is derived from.',
      policyRefusals.length === 0
        ? `The free-only policy holds: \`${args.model ?? 'no model'}\` is approved and every applicable price tier (${P.FREE_ONLY_PRICE_FIELDS.join(', ')}) is explicitly zero on the ${args.runtime} runtime.`
        : `The free-only policy REFUSES this model: ${policyRefusals.join('; ')}.`,
      'The free-only configuration a session receives is recorded in freeOnly.config; the live guard refuses to spawn a session unless the runtime\u2019s own resolved configuration matches it.',
    ],
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(0);
}

if (args.mode === 'preflight') {
  environmentProbe();
}

if (args.repo === undefined || !existsSync(args.repo)) fail('--repo must name an existing directory');
if (args.arm !== 'control' && args.arm !== 'treatment') fail('--arm must be control or treatment');
if (args.out === undefined) fail('--out must name an artifact directory');
if (args.model === undefined) fail('--model is required');
if (args.promptFile === undefined || !existsSync(args.promptFile)) {
  fail('--prompt-file must name an existing file');
}
for (const required of ['taskId', 'runId', 'runNonce', 'repositoryRevision', 'promptHash']) {
  if (typeof args[required] !== 'string' || args[required].length === 0) {
    fail(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
}
if (!Number.isInteger(args.pairIndex) || !Number.isInteger(args.attempt)) {
  fail('--pair-index and --attempt must be whole numbers');
}

// The free-only policy, resolved before anything is written or spawned: it decides which model
// a session may use and what configuration the repository receives. `requirePolicy()` fails
// closed, so nothing below can run with an unstated envelope.
const P = requirePolicy();
const modelConfig = P.freeOnlyModelConfig();
const modelConfigDigest = P.freeOnlyModelConfigDigest(modelConfig);

/**
 * The envelope the **pre-transmission model guard** enforces inside the session.
 *
 * Derived here from the same policy module the price gate and the benchmark's checks read, and
 * passed to the generated guard plugin as a literal, so the guard's evidence names the digest of
 * the configuration it was given rather than a list the guard chose for itself. `undefined` means
 * the policy module cannot state an envelope at all, which is a refusal to run (see
 * `modelGuardRefusals` below) rather than a session with an unstated bound.
 */
const modelGuardEnvelope =
  typeof P.modelGuardPolicy === 'function'
    ? P.modelGuardPolicy(modelConfig.model, modelConfig.small_model)
    : undefined;
// The request-kind vocabulary the probe registers and the artifact reports, from the same module
// the benchmark checks read it from.
const requestKindVocabulary = requireRequestKindVocabulary();
// The primary the run was asked for and the primary the configuration pins must be the same
// model, or one of them is silently a different experiment. Checked before any file is written.
if (args.model !== modelConfig.model) {
  fail(
    `--model is \`${args.model}\` while the free-only policy pins the primary to \`${modelConfig.model}\`; a run whose command line and repository configuration name different models is not attributable to either. Refusing to start.`,
  );
}

const pluginPath = args.pluginModule ?? join(import.meta.dirname, '..', 'dist', 'index.js');
if (!existsSync(pluginPath)) {
  fail(`the built plugin module was not found at ${pluginPath} (run the package build first)`);
}
// The generated plugin file needs an import specifier, so the path is converted here
// rather than making every caller hand over a file URL.
const pluginModule = pathToFileURL(pluginPath).href;

/**
 * Pure helpers imported from the same built module the session loads.
 *
 * The governor's decision and the containment evidence summary live in the plugin
 * package as tested units; importing them from the module already passed to the arm
 * keeps one build as the only source of both, and a custom `--plugin-module` without
 * them degrades to a recorded "not armed" rather than a silent assumption.
 */
let helperBundle = {};
let importModule;
try {
  importModule = await import(pluginModule);
  const pick = (name) => (typeof importModule[name] === 'function' ? importModule[name] : undefined);
  helperBundle = {
    // `startCostGovernor` is the loop itself: picking the decision helper without it
    // armed the governor and then threw at the call, leaving a spending cap unenforced
    // (Stage 1V). Every helper the driver calls must be picked here.
    startCostGovernor: pick('startCostGovernor'),
    decideCostGovernor: pick('decideCostGovernor'),
    latestSessionCostUsd: pick('latestSessionCostUsd'),
    planGovernorArming: pick('planGovernorArming'),
    summarizeContainmentEvidence: pick('summarizeContainmentEvidence'),
    // The model guard: the factory the generated plugin loads and the summarizer the artifact
    // records. Picked here rather than looked up at the call site, so a build without them is a
    // refusal to run instead of a session that was silently started unbounded.
    createModelGuardPluginV2: pick('createModelGuardPluginV2'),
    summarizeModelGuardEvidence: pick('summarizeModelGuardEvidence'),
    deniedTools: Array.isArray(importModule.CONTAINMENT_DENIED_TOOLS)
      ? importModule.CONTAINMENT_DENIED_TOOLS.filter((entry) => typeof entry === 'string')
      : undefined,
  };
} catch {
  helperBundle = {};
}

const out = args.out;
mkdirSync(out, { recursive: true });
const wirePath = join(out, 'wire.jsonl');
const summaryPath = join(out, 'session-summary.jsonl');
// The request kinds the runtime composed, as its own model-request hooks reported them. This is
// the channel that works in every mode, including a live run against a real provider where no
// endpoint record exists.
const kindsPath = join(out, 'wire-kinds.jsonl');
const cliLogPath = join(out, 'arm-cli.log');
const artifactPath = join(out, 'arm-observation.json');
writeFileSync(wirePath, '');
writeFileSync(summaryPath, '');
writeFileSync(kindsPath, '');

const prompt = readFileSync(args.promptFile, 'utf8');

/* -------------------------------------------------------------------------- */
/* Isolation and arm switch                                                   */
/* -------------------------------------------------------------------------- */

const pluginsDir = join(args.repo, '.opencode', 'plugin');
mkdirSync(pluginsDir, { recursive: true });

// The shipped plugin, loaded exactly as the documented V2 install does.
//
// Two forms, because the two runtimes carry the arm's switch differently. The private
// server inherits this process's environment, so the documented environment switch is
// used and the file stays a one-line re-export. The background service does **not**
// inherit it, so in that mode the switch and the summary destination are passed as
// explicit plugin options instead — the arm is then decided by a file written for this
// run, never by whatever environment the service happens to have.
writeFileSync(
  join(pluginsDir, 'dr-token-level2.ts'),
  args.runtime === 'service'
    ? `import { createOpenCodeObserverPluginV2, createSummaryFileSink } from ${JSON.stringify(pluginModule)};\n\nexport default createOpenCodeObserverPluginV2({\n  safeMode: ${JSON.stringify(args.arm === 'treatment' ? 'apply' : 'off')},\n  sink: createSummaryFileSink(${JSON.stringify(summaryPath)}),\n});\n`
    : `export { default } from ${JSON.stringify(pluginModule)};\n`,
  'utf8',
);

/**
 * The wire probe: lengths and marker counts only.
 *
 * It registers `session.hook("http.request")` — the hook Stage 1T validated for the
 * outbound body — reads the body it is handed, and records its UTF-8 byte length,
 * its character length, and how many Safe Mode marker prefixes it contains. It
 * writes nothing else: no header, no URL, no content.
 */
writeFileSync(
  join(pluginsDir, 'zz-level2-wire.ts'),
  `import { appendFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const outPath = process.env.DR_TOKEN_LEVEL2_WIRE ?? ${JSON.stringify(wirePath)};
const kindsPath = process.env.DR_TOKEN_LEVEL2_KINDS ?? ${JSON.stringify(kindsPath)};
const requestHook = ${JSON.stringify(requestKindVocabulary.hook)};
const requestKinds = ${JSON.stringify(requestKindVocabulary.kinds)};
const prefix = ${JSON.stringify(MARKER_PREFIX)};
// Written explicitly so this generated file carries no escape-sequence ambiguity.
const NL = String.fromCharCode(10);

/**
 * A structural description of the body object.
 *
 * The hook hands over a body whose runtime shape is not part of any documented
 * contract, so the probe records what it actually received (constructor name and
 * the numeric size properties it exposes) instead of assuming a string. Only shape
 * and size are recorded: never content.
 */
function describeShape(value) {
  if (value === undefined || value === null) return 'absent';
  if (typeof value === 'string') return 'string';
  try {
    const name = value.constructor && value.constructor.name ? value.constructor.name : 'object';
    const byteLength = typeof value.byteLength === 'number' ? value.byteLength : null;
    const length = typeof value.length === 'number' ? value.length : null;
    const size = typeof value.size === 'number' ? value.size : null;
    const keys = Object.keys(value).slice(0, 12).sort();
    return name + '|byteLength=' + String(byteLength) + '|length=' + String(length) + '|size=' + String(size) + '|keys=' + keys.join(',');
  } catch {
    return 'unreadable';
  }
}

export default {
  id: 'dr-token-level2-wire',
  async setup(context) {
    let seq = 0;
    try {
      await context.session.hook('http.request', (payload) => {
        try {
          const request = payload && typeof payload === 'object' ? payload.request : undefined;
          const rawBody = request && typeof request === 'object' ? request.body : undefined;
          const body = typeof rawBody === 'string' ? rawBody : undefined;
          const entry = {
            seq: seq,
            // The runtime labels its own request: read here rather than inferred from the body, so
            // the endpoint-side view of the session carries the same kind vocabulary the model
            // hook reports.
            kind: typeof payload.kind === 'string' ? payload.kind : 'unclassified',
            bodyType: rawBody === undefined || rawBody === null ? 'absent' : typeof rawBody,
            bodyShape: describeShape(rawBody),
            bodyChars: body === undefined ? null : body.length,
            bodyBytes: body === undefined ? null : Buffer.byteLength(body, 'utf8'),
            markerCount: body === undefined ? 0 : body.split(prefix).length - 1,
          };
          seq += 1;
          if (outPath) appendFileSync(outPath, JSON.stringify(entry) + '\\n');
        } catch {
          // A probe failure must never disturb the session it measures.
        }
      });
    } catch {
      // A host without the hook is recorded as "no wire evidence", not as a failure.
    }

    // The request-kind probe.
    //
    // **One** registration, on the single hook name the runtime dispatches every model request
    // to, with the request's own kind read out of the payload. This is measured, and the negative
    // result is why it is written this way: registering a synthetic name per kind
    // ('model.request:title' and friends) is accepted by the runtime without error and **never
    // called**, so a per-kind count taken that way reads as a zero while real requests go out.
    // Hook registration proves nothing; only an invocation does.
    //
    // A payload whose kind is not one the runtime declares is recorded as "unclassified" rather
    // than dropped: an unrecognized request is exactly the case where guessing would hide work the
    // free-only policy does not allow. The payload's key names are recorded too, so the artifact
    // shows the reading came from a real payload.
    //
    // The model reference is recorded exactly as the runtime hands it over (an object or a
    // string); the driver normalizes it with the one policy implementation, so the probe and the
    // benchmark cannot disagree about what a model identifier is.
    const registered = [];
    const failures = [];
    try {
      await context.session.hook(requestHook, (payload) => {
        try {
          const detail = payload && typeof payload === 'object' ? payload : {};
          const reported = typeof detail.kind === 'string' ? detail.kind : undefined;
          const entry = {
            kind: reported !== undefined && requestKinds.indexOf(reported) >= 0 ? reported : 'unclassified',
            model: detail.model,
            payloadKeys: Object.keys(detail).slice(0, 12).sort(),
          };
          if (kindsPath) appendFileSync(kindsPath, JSON.stringify(entry) + NL);
        } catch {
          // A probe failure must never disturb the session it measures.
        }
      });
      registered.push(requestHook);
    } catch {
      failures.push(requestHook);
    }
    try {
      if (kindsPath) appendFileSync(kindsPath, JSON.stringify({ registered, failures }) + NL);
    } catch {
      // The absence is visible in the artifact rather than thrown into the session.
    }
    return () => {};
  },
};
`,
  'utf8',
);

/* -------------------------------------------------------------------------- */
/* Containment                                                                */
/* -------------------------------------------------------------------------- */

// Layer 1 — the runtime's own permission policy, enforced by the host before any
// tool runs. `--auto` auto-approves only permissions that are *not explicitly
// denied*, so an explicit deny survives it; that is exactly why containment does not
// rely on `--auto`. The rules are the same bytes for both arms (no path is embedded),
// and the digest is recorded so the pair's equivalence is checkable.
const containmentConfig = {
  permission: {
    external_directory: 'deny',
    bash: 'deny',
    task: 'deny',
    webfetch: 'deny',
  },
  agent: {
    build: { steps: 20 },
    general: { steps: 20 },
  },
};

/**
 * The native permission actions the canary policy requires, in the runtime's own vocabulary.
 *
 * The repository config declares `bash`/`task`; the runtime canonicalises those to `shell` and
 * `subagent` (observed 2026-10-11 through `api config.get`), so the requirement is stated in the
 * runtime's names, not in ours.
 */
const REQUIRED_NATIVE_DENIES = ['external_directory', 'shell', 'subagent', 'webfetch'];

/**
 * Ask the runtime what permission rules it resolved for this repository.
 *
 * Read-only, no session and no model: `api config.get --standalone` starts a private server in
 * the arm's own isolated environment and reports the resolved configuration, including the
 * canonical permission list. This is what makes the *second* containment layer evidenced rather
 * than assumed — the plugin event stream does not carry the session's permission rules in this
 * runtime shape (`permissionRules: null` in the guard's evidence is a gap in what the runtime
 * reports to a plugin, not a missing rule; a controlled run showed the same session leaking an
 * out-of-workspace read once this config was removed).
 *
 * Only the action, the effect and a resource *class* are recorded: never a path.
 */
function configurationProbe() {
  const policySource = 'api config.get --standalone (this repository\u2019s own document)';
  const unreadable = (error) => ({
    permissions: {
      observed: false,
      source: 'api config.get --standalone',
      rules: [],
      error,
    },
    policy: {
      source: policySource,
      found: false,
      model: undefined,
      titleModel: undefined,
      compactionAuto: undefined,
      providersAllowed: [],
      providersDeniedAll: false,
      update: undefined,
      share: undefined,
      error,
    },
  });

  let result;
  try {
    result = spawnSync(args.cli, ['api', 'config.get', '--standalone'], {
      cwd: args.repo,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
  } catch (error) {
    return unreadable(error instanceof Error ? error.message : String(error));
  }
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const lastLine = text.split(/\r?\n/).filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(lastLine ?? 'null');
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    return unreadable('the runtime did not report a readable configuration');
  }

  const foldedRepo = args.repo.replace(/\\/g, '/').toLowerCase();
  const rules = [];
  for (const entry of parsed) {
    const info = entry !== null && typeof entry === 'object' ? entry.info : undefined;
    if (info === undefined || info === null || !Array.isArray(info.permissions)) continue;
    for (const rule of info.permissions) {
      if (rule === null || typeof rule !== 'object') continue;
      if (typeof rule.action !== 'string' || typeof rule.effect !== 'string') continue;
      const resource =
        rule.resource === '*'
          ? 'any'
          : typeof rule.resource === 'string'
            ? rule.resource.replace(/\\/g, '/').toLowerCase().startsWith(foldedRepo)
              ? 'workspace'
              : 'other'
            : 'unclassified';
      rules.push({ action: rule.action, effect: rule.effect, resource });
    }
  }

  /**
   * The document the runtime resolved for *this repository's own config file*.
   *
   * Matching on the path is what makes the reading about the file the driver wrote rather than
   * about the merged configuration: a key the runtime does not recognize is omitted from the
   * document it reports, so its absence here is the signal that the setting did not take
   * effect. The suffix comparison is only for path spelling (the runtime may canonicalize
   * case or separators on this platform); it is still the project document and nothing else.
   */
  const normalized = (value) =>
    typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase() : '';
  const wanted = normalized(containmentConfigPath);
  const projectDocument = parsed.find((entry) => {
    const path = normalized(entry?.path);
    return path.length > 0 && (path === wanted || path.endsWith('/.opencode/opencode.json'));
  });
  const info =
    projectDocument !== null && typeof projectDocument === 'object'
      ? projectDocument.info
      : undefined;

  const modelRef = (value) => {
    if (typeof value === 'string') return value;
    if (value === null || typeof value !== 'object') return undefined;
    const provider = typeof value.providerID === 'string' ? value.providerID : undefined;
    const model =
      typeof value.model === 'string' ? value.model : typeof value.modelID === 'string' ? value.modelID : undefined;
    return provider === undefined || model === undefined ? undefined : `${provider}/${model}`;
  };
  const policies = Array.isArray(info?.experimental?.policies) ? info.experimental.policies : [];
  const providerUse = policies.filter(
    (rule) => rule !== null && typeof rule === 'object' && rule.action === 'provider.use',
  );
  const policy = {
    source: policySource,
    found: info !== undefined && info !== null,
    model: modelRef(info?.model),
    titleModel: modelRef(info?.agents?.title?.model),
    compactionAuto:
      info?.compaction !== undefined && typeof info.compaction.auto === 'boolean'
        ? info.compaction.auto
        : undefined,
    providersAllowed: providerUse
      .filter((rule) => rule.effect === 'allow' && typeof rule.resource === 'string')
      .map((rule) => rule.resource),
    providersDeniedAll: providerUse.some(
      (rule) => rule.effect === 'deny' && (rule.resource === '*' || rule.resource === 'any'),
    ),
    update: typeof info?.update === 'string' ? info.update : undefined,
    share: typeof info?.share === 'string' ? info.share : undefined,
    error: info === undefined || info === null ? 'the runtime reported no document for this repository configuration' : null,
  };

  return {
    permissions: {
      observed: rules.length > 0,
      source: 'api config.get --standalone',
      rules,
      error: rules.length > 0 ? null : 'the runtime resolved no permission rule for this repository',
    },
    policy,
  };
}
const containmentConfigText = `${JSON.stringify(containmentConfig, null, 2)}\n`;
const containmentConfigPath = join(args.repo, '.opencode', 'opencode.json');
// One repository configuration, two fragments: the free-only model policy (primary model,
// auxiliary model, provider restriction, disabled compaction) and the containment policy. The
// file's bytes are a function of these two fragments alone — no arm-specific value is in
// either — so the control and treatment repositories are byte-identical and their digests are
// the evidence for it.
const projectConfigText = `${JSON.stringify({ ...modelConfig, ...containmentConfig }, null, 2)}\n`;
writeFileSync(containmentConfigPath, projectConfigText, 'utf8');
const containmentConfigDigest = createHash('sha256').update(containmentConfigText, 'utf8').digest('hex');
const projectConfigDigest = createHash('sha256').update(projectConfigText, 'utf8').digest('hex');

// Layer 2 — the containment guard plugin, byte-identical in both arms like the
// observer: it loads the shipped factory, and the only per-arm content is the
// evidence file path (instrumentation, not experiment). The generated file does its
// own file I/O, so the shipped observation package keeps its filesystem rule intact.
const guardEvidencePath = join(out, 'containment-guard.jsonl');
writeFileSync(guardEvidencePath, '');
writeFileSync(
  join(pluginsDir, 'zz-level2-guard.ts'),
  `import { appendFileSync } from 'node:fs';\nimport { createContainmentGuardPluginV2 } from ${JSON.stringify(pluginModule)};\n\nconst evidencePath = ${JSON.stringify(guardEvidencePath)};\n\nexport default createContainmentGuardPluginV2({\n  onEvidence: (line) => {\n    appendFileSync(evidencePath, JSON.stringify(line) + '\\n', 'utf8');\n  },\n});\n`,
  'utf8',
);

// Layer 3 — the pre-transmission **model guard**, byte-identical in both arms for the same reason
// as the other two: it loads the shipped factory and the only per-arm content is the evidence file
// path. It is the one layer that acts *before* a provider request is dispatched, so a request the
// free-only envelope does not cover is refused instead of being measured and discarded afterwards.
const modelGuardEvidencePath = join(out, 'model-guard.jsonl');
writeFileSync(modelGuardEvidencePath, '');
writeFileSync(
  join(pluginsDir, 'zz-level2-model-guard.ts'),
  `import { appendFileSync } from 'node:fs';\nimport { createModelGuardPluginV2 } from ${JSON.stringify(pluginModule)};\n\nconst evidencePath = ${JSON.stringify(modelGuardEvidencePath)};\nconst policy = ${JSON.stringify(modelGuardEnvelope ?? null)};\n\nexport default createModelGuardPluginV2({\n  ...(policy === null ? {} : { policy }),\n  onEvidence: (line) => {\n    appendFileSync(evidencePath, JSON.stringify(line) + '\\n', 'utf8');\n  },\n});\n`,
  'utf8',
);

const isolatedConfig = join(out, 'iso', 'config');
const isolatedData = join(out, 'iso', 'data');
mkdirSync(isolatedConfig, { recursive: true });
mkdirSync(isolatedData, { recursive: true });

const env = {
  ...isolationEnvironment(isolatedConfig, isolatedData, args.repo),
  DR_TOKEN_SAFE_MODE: args.arm === 'treatment' ? 'apply' : 'off',
  DR_TOKEN_OBSERVER_SUMMARY_FILE: summaryPath,
  DR_TOKEN_LEVEL2_WIRE: wirePath,
};

if (args.mode === 'rehearse') {
  if (args.baseUrl === undefined) fail('--mode rehearse requires --base-url');
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    provider: { opencode: { options: { baseURL: args.baseUrl } } },
  });
}

/* -------------------------------------------------------------------------- */
/* One session                                                                */
/* -------------------------------------------------------------------------- */

// `--standalone` starts a private server: nothing the developer's service holds — its
// account, and with it the model catalogue — is visible to it. `service` instead asks
// the running service, which is the only runtime on this installation that reports a
// catalogue (measured, see the preflight mode).
/* -------------------------------------------------------------------------- */
/* In-session spending governor — armed before the session starts              */
/* -------------------------------------------------------------------------- */

/**
 * The governor's decision is made **before** the CLI is spawned.
 *
 * Stage 1V is why: the driver picked its governor helpers by name, the pick list omitted
 * `startCostGovernor`, and the armed branch therefore threw before the session started —
 * leaving a per-session spending cap that nothing enforced. The decision below runs while
 * no model process exists, and a live capped service session whose governor cannot arm is
 * refused outright instead of being run with an unenforceable bound.
 */
const costCap =
  typeof args.sessionCostCapUsd === 'number' &&
  Number.isFinite(args.sessionCostCapUsd) &&
  args.sessionCostCapUsd > 0
    ? args.sessionCostCapUsd
    : undefined;

const governor = {
  armed: false,
  reason: null,
  capUsd: null,
  /** The tested supervisor loop, once it is started. */
  supervisor: undefined,
};

/** The process the governor may kill when a native interrupt will not confirm. */
let cliHandle;

/** Set once the supervisor exists; a no-op until then and after it stops. */
let stopGovernor = () => {};

const governorHelpers = {
  decide: typeof helperBundle.decideCostGovernor === 'function',
  latest: typeof helperBundle.latestSessionCostUsd === 'function',
  start: typeof helperBundle.startCostGovernor === 'function',
};

const armingPlan =
  typeof helperBundle.planGovernorArming === 'function'
    ? helperBundle.planGovernorArming({
        mode: args.mode,
        runtime: args.runtime,
        capUsd: costCap,
        helpers: governorHelpers,
      })
    : {
        // A build without the planner: fall back to the same rule the planner encodes
        // rather than silently arming and hoping.
        required: args.mode === 'live' && args.runtime === 'service' && costCap !== undefined,
        armed: false,
        reason: 'the built plugin module does not export the governor arming planner',
      };

governor.armed = armingPlan.armed === true;
governor.reason = armingPlan.reason ?? null;

if (armingPlan.required === true && governor.armed !== true) {
  fail(
    `the in-session spending governor cannot arm (${String(governor.reason)}), so the per-session spending cap could not be enforced; refusing to start a live session rather than running one with an unenforceable bound`,
  );
}

/* -------------------------------------------------------------------------- */
/* Native permission policy — read from the runtime, before any session        */
/* -------------------------------------------------------------------------- */

/**
 * The second containment layer, asked of the runtime rather than assumed.
 *
 * This runs **before** the CLI is spawned: a live session whose runtime did not resolve the
 * required denies would run with only the plugin layer in force, and the plugin layer is the one
 * this harness proved; the native layer must be shown to be configured, or the run is refused
 * rather than started with half of containment unobserved.
 */
const configuration = configurationProbe();
const nativePermissions = configuration.permissions;
const resolvedPolicy = configuration.policy;
const missingNativeDenies = REQUIRED_NATIVE_DENIES.filter(
  (action) =>
    !nativePermissions.rules.some((rule) => rule.action === action && rule.effect === 'deny'),
);

const containmentRefusal =
  nativePermissions.observed !== true
    ? `the runtime did not resolve the required containment denies for this repository (${String(nativePermissions.error ?? 'no permission rule was reported')}); refusing to start a live session with the native permission layer unobserved`
    : missingNativeDenies.length > 0
      ? `the runtime did not resolve the required containment denies for this repository (missing: ${missingNativeDenies.join(', ')}); refusing to start a live session with the native permission layer unobserved`
      : undefined;

/**
 * The runtime's own answer about the free-only configuration, applied in **every** mode.
 *
 * A written configuration file is not evidence that a setting took effect: the runtime
 * validates and normalizes what it loads, and a key it does not recognize is *omitted* from what
 * it reports rather than rejected. So the question this asks is not "did the driver write the
 * keys" but "did the runtime resolve them", and a session is refused when the answer is no —
 * in a rehearsal as much as in a live run, because a rehearsal's whole purpose here is to prove
 * that this configuration is the one a session actually receives.
 */
const resolvedPolicyRefusals = P.resolvedPolicyRefusals(resolvedPolicy, modelConfig);
if (resolvedPolicyRefusals.length > 0) {
  fail(
    `the runtime did not apply the free-only model configuration to this repository: ${resolvedPolicyRefusals.join('; ')}. Refusing to start a session whose requests are not bounded to approved free models.`,
  );
}
const modelConfigAccepted = resolvedPolicy.found === true && resolvedPolicyRefusals.length === 0;

/**
 * The pre-spawn half of the model guard: can this run's requests be bounded **before** they are
 * sent?
 *
 * Every other refusal above is about whether a run may *start*; this one is about whether a request
 * assembled *during* the session can be stopped, which is the case neither the price gate nor the
 * resolved-configuration check can see. Two things have to hold, and both are checked here, before
 * anything is spawned:
 *
 * 1. the shipped plugin module actually exports the guard factory and the evidence summarizer — a
 *    build without them would start a session whose requests nothing refuses, and the artifact
 *    would carry a guard block that silently reported nothing;
 * 2. the policy module states an envelope, and it is *this* run's envelope: the same approved pair,
 *    the same configuration digest, and every request kind the runtime declares. An envelope that
 *    disagreed with the configuration would let the guard bound a different experiment than the
 *    one being configured.
 */
const modelGuardRefusals = [];
if (modelGuardEnvelope === undefined) {
  modelGuardRefusals.push(
    'the free-only model policy does not export `modelGuardPolicy()`, so no approved model envelope can be stated for the pre-transmission guard',
  );
} else {
  if (modelGuardEnvelope.primary !== modelConfig.model) {
    modelGuardRefusals.push(
      `the guard envelope pins the primary to \`${String(modelGuardEnvelope.primary)}\` while the configuration pins \`${modelConfig.model}\``,
    );
  }
  const approved = Array.isArray(modelGuardEnvelope.approved) ? modelGuardEnvelope.approved : [];
  const missingApproved = [modelConfig.model, modelConfig.small_model].filter(
    (id) => !approved.includes(id),
  );
  if (missingApproved.length > 0) {
    modelGuardRefusals.push(
      `the guard envelope does not approve ${missingApproved.map((id) => `\`${id}\``).join(', ')}`, 
    );
  }
  const extraApproved = approved.filter((id) => id !== modelConfig.model && id !== modelConfig.small_model);
  if (extraApproved.length > 0) {
    modelGuardRefusals.push(
      `the guard envelope approves ${extraApproved.map((id) => `\`${id}\``).join(', ')}, which this run's configuration does not`, 
    );
  }
  const allowedKinds = Array.isArray(modelGuardEnvelope.allowedKinds)
    ? modelGuardEnvelope.allowedKinds
    : [];
  const missingKinds = requestKindVocabulary.kinds.filter((kind) => !allowedKinds.includes(kind));
  if (missingKinds.length > 0) {
    modelGuardRefusals.push(
      `the guard envelope does not allow the request kind(s) ${missingKinds.join(', ')}, which the runtime declares and this run therefore expects to be able to classify`,
    );
  }
  if (modelGuardEnvelope.policyDigest !== modelConfigDigest) {
    modelGuardRefusals.push(
      `the guard envelope records policy digest \`${String(modelGuardEnvelope.policyDigest)}\` while this run's configuration digests to \`${modelConfigDigest}\`; the guard would bound a different policy than the one configured`,
    );
  }
}
if (typeof helperBundle.createModelGuardPluginV2 !== 'function') {
  modelGuardRefusals.push(
    `the plugin module at ${pluginPath} does not export \`createModelGuardPluginV2\`, so the session it starts would carry no pre-transmission model guard`,
  );
}
if (typeof helperBundle.summarizeModelGuardEvidence !== 'function') {
  modelGuardRefusals.push(
    `the plugin module at ${pluginPath} does not export \`summarizeModelGuardEvidence\`, so this driver could not read back what the guard enforced`,
  );
}
if (modelGuardRefusals.length > 0) {
  fail(
    `the pre-transmission model guard cannot be shown to be in force for this run: ${modelGuardRefusals.join('; ')}. Refusing to start a session whose model requests are not bounded before they are sent. Nothing was spawned, so this refusal costs nothing.`,
  );
}

// The free-only verdict was asked first, above; the containment verdict follows. Both are
// pre-spawn refusals, and the one an operator can act on when a run is refused is "this model is
// not verifiably free" rather than "this repository's container is not in force".
if (args.mode === 'live' && containmentRefusal !== undefined) {
  fail(containmentRefusal);
}

/**
 * The price the runtime reports for the model this run would use.
 *
 * Asked read-only through the runtime's own `model.list`, and asked of the runtime the session
 * will use: the isolated private server and the running service can answer with different
 * catalogues, and the price that matters is the one behind the requests this run will make.
 *
 * Only a live run asks. A rehearsal spends nothing, holds no account in its isolated home, and
 * therefore cannot consult a price list at all; it records that reason rather than a verdict it
 * did not earn.
 */
function cataloguePriceProbe() {
  let models = [];
  let error;
  try {
    const response = spawnSync(
      args.cli,
      args.runtime === 'service' ? ['api', 'model.list'] : ['api', 'model.list', '--standalone'],
      { cwd: args.repo, env, encoding: 'utf8', windowsHide: true, timeout: 240_000 },
    );
    const line = String(response.stdout ?? '')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .reverse()
      .find((entry) => entry.startsWith('{'));
    const parsed = JSON.parse(line ?? 'null');
    if (Array.isArray(parsed?.data)) models = parsed.data;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const requested = models.find(
    (model) => `${model?.providerID ?? 'unknown'}/${model?.modelID ?? ''}` === args.model,
  );
  const tier =
    requested !== undefined && Array.isArray(requested.cost)
      ? (requested.cost.find((entry) => entry !== null && typeof entry === 'object') ?? null)
      : null;
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return {
    facts: {
      model: args.model,
      runtime: args.runtime,
      catalogueSize: models.length,
      listed: requested !== undefined,
      priceRow:
        tier === null
          ? undefined
          : {
              input: number(tier.input),
              output: number(tier.output),
              cacheRead: number(tier.cache?.read),
              cacheWrite: number(tier.cache?.write),
            },
    },
    error,
  };
}

const priceProbe = args.mode === 'live' ? cataloguePriceProbe() : undefined;
const priceFacts = priceProbe?.facts ?? {
  model: args.model,
  runtime: args.runtime,
  catalogueSize: 0,
  listed: undefined,
  priceRow: undefined,
};
const priceRefusals =
  priceProbe === undefined ? [] : P.freeOnlyRefusals(priceProbe.facts);
if (args.mode === 'live' && priceRefusals.length > 0) {
  fail(
    `refusing to start a live session: ${priceRefusals.join('; ')}. Nothing was spawned, so this refusal costs nothing.`,
  );
}
const priceVerification =
  priceProbe === undefined
    ? {
        catalogueSource: 'not-checked',
        verified: false,
        skippedReason:
          'a rehearsal spends nothing and its isolated environment holds no account catalogue, so no price row exists to verify; only the configuration, the resolved policy and the composed requests are checked here',
      }
    : {
        catalogueSource: args.runtime,
        verified: P.isZeroPriceRow(priceFacts.priceRow),
        skippedReason: undefined,
      };

if (args.mode === 'live' && priceVerification.verified !== true) {
  fail(
    `refusing to start a live session: the runtime reported no price row that is zero in every applicable tier for \`${args.model}\`, so this model is not verified free.`,
  );
}

// `--title` is what removes the auxiliary requests, measured: the pinned runtime composes a
// title request (and, when the title call does not settle, a second one on the session model)
// when no title is supplied, and none when one is. The same literal is used in both arms.
const cliArgs = [
  'run',
  ...(args.runtime === 'service' ? [] : ['--standalone']),
  '--auto',
  '--model',
  args.model,
  '--title',
  SESSION_TITLE,
  prompt,
];
const startedAt = new Date();
const startedHr = process.hrtime.bigint();

const cli = spawn(args.cli, cliArgs, { cwd: args.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
cliHandle = cli;
let stdout = '';
let stderr = '';
cli.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});
cli.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  cli.kill();
}, Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS);

/* -------------------------------------------------------------------------- */
/* In-session spending governor                                               */
/* -------------------------------------------------------------------------- */

/**
 * The supervisor that makes a per-session spending cap an **in-session** stop.
 *
 * The post-session caps in the benchmark side can only stop the next session; they
 * cannot stop the session that is spending. The runtime's own `session.interrupt`
 * operation can, so while a live service session runs, this loop reads the cost the
 * runtime reports (through the observer's per-step summary), and when the reported
 * cost crosses the per-session cap it calls that operation through the CLI.
 *
 * Two honest limits, both recorded in the artifact rather than smoothed over:
 *
 * - between the crossing and the interrupt landing, at most one more model step is
 *   billed, so the overshoot is bounded by a step and not by the cap;
 * - if the runtime never reports a cost, the governor has nothing to act on (an
 *   unreported cost is not a zero). The post-session tracker fails closed on that,
 *   and `reportedCostUsd` in the artifact shows what the governor actually saw.
 *
 * Purely a supervisor: it never touches the session's content, and a failure inside
 * it is recorded, never thrown into the run.
 */
// The decision was already made, before the CLI was spawned. Only the supervisor start
// remains here, and it runs the tested loop from the shipped module.
if (governor.armed) {
  // A rehearsal is armed on the same initialisation path, with a cap it cannot reach:
  // the scripted provider reports no cost, and a rehearsal has no real bound to enforce.
  // The recorded `capUsd` stays honest (it is the cap that was configured, not the sentinel).
  governor.capUsd = costCap ?? null;

  const currentSessionId = () => {
    const lines = readJsonLines(summaryPath);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const id = lines[index]?.sessionId;
      if (typeof id === 'string' && id.length > 0) {
        return id;
      }
    }
    return undefined;
  };

  /** Ask the runtime to stop the session, natively. Returns whether it confirmed. */
  const interruptSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return false;
    }    const result = spawnSync(
      args.cli,
      [
        'api',
        'session.interrupt',
        '--param',
        `sessionID=${sessionId}`,
        // A live service session belongs to the background service; a rehearsal's session
        // belongs to its own private server, which only `--standalone` addresses. Calling
        // the wrong one would interrupt an unrelated session on the developer's machine.
        ...(args.runtime === 'service' ? [] : ['--standalone']),
      ],
      { cwd: args.repo, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    const text = String(result.stdout ?? '').trim();
    const lastLine = text.split(/\r?\n/).filter(Boolean).pop();
    try {
      const parsed = JSON.parse(lastLine ?? '{}');
      return parsed?.interrupted === true;
    } catch {
      return false;
    }
  };

  // The loop itself lives in the tested module: this call site only supplies the
  // three impure pieces — read the summary, call the runtime, stop the client — and
  // the policy is the unit-tested `decideCostGovernor`.
  try {
    governor.supervisor = helperBundle.startCostGovernor({
      // The loop needs a number; an unconfigured cap (the rehearsal case) gets a bound it
      // can never reach, so the initialisation path runs without pretending a real cap.
      capUsd: typeof governor.capUsd === 'number' ? governor.capUsd : Number.MAX_SAFE_INTEGER,
      intervalMs: 1500,
      readCostUsd: () =>
        helperBundle.latestSessionCostUsd(readJsonLines(summaryPath), currentSessionId()),
      interrupt: () => interruptSession(currentSessionId()),
      abandon: () => {
        // The native stop did not confirm twice: stop the client process instead, and
        // record that this session had to be killed rather than interrupted.
        try {
          cliHandle?.kill();
        } catch {
          // Best effort; the wall-clock timeout still applies.
        }
      },
    });
    stopGovernor = () => {
      governor.supervisor?.stop();
    };
  } catch (error) {
    // The decision above said this build could arm, so a throw here is a wiring fault and
    // not a reason to continue: the session is stopped and the artifact records that no
    // in-session bound was in force, rather than reporting an armed governor that never ran.
    governor.armed = false;
    governor.reason = `the governor failed to start (${error instanceof Error ? error.message : String(error)})`;
    try {
      cliHandle?.kill();
    } catch {
      // Best effort; the wall-clock timeout still applies.
    }
    if (armingPlan.required === true) {
      fail(
        `the in-session spending governor failed to start (${String(governor.reason)}); the session was stopped rather than run with an unenforceable spending cap`,
      );
    }
  }
}

const exitCode = await new Promise((resolve) => {
  cli.on('close', (code) => resolve(code ?? -1));
  cli.on('error', () => resolve(-1));
});
clearTimeout(timer);
stopGovernor();
const governorState =
  governor.supervisor === undefined ? undefined : governor.supervisor.state();

const durationMs = Number(process.hrtime.bigint() - startedHr) / 1e6;
writeFileSync(cliLogPath, `${stdout}\n--- stderr ---\n${stderr}\n`, 'utf8');

/**
 * The runtime's own refusal text when it will not run the requested model.
 *
 * Recorded as a distinct outcome rather than as a failed run: a plan that keeps
 * starting sessions against an unavailable model would burn authorization without
 * producing a single measurement, so the caller needs to be able to stop on it.
 */
const modelUnavailable = /model unavailable/i.test(`${stdout}\n${stderr}`);

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** The runtime's own version string, recorded beside the run. Absent if unreportable. */
function runtimeVersion() {
  try {
    const result = spawnSync(args.cli, ['--version'], { encoding: 'utf8', windowsHide: true });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    const match = /(\d+\.\d+\.\d+)/.exec(text);
    return match === null ? undefined : match[1];
  } catch {
    return undefined;
  }
}

const wireLog = readJsonLines(wirePath);
// A request whose body the hook did not hand over as text is counted, so silence from
// the probe can never be mistaken for "the request was small".
const unmeasurableRequests = wireLog.length;

/**
 * Wire evidence from a loopback provider's own capture file.
 *
 * Only two things are extracted per request: its UTF-8 byte length and how many Safe
 * Mode marker prefixes it contains. The capture file itself is the *experiment's*
 * file, written by a provider the run was deliberately pointed at, and it holds only
 * synthetic repository content; nothing from it is copied into the artifact except
 * these two numbers.
 */
function wireFromProviderCapture(path) {
  return readJsonLines(path).flatMap((entry, index) => {
    const body = typeof entry.body === 'string' ? entry.body : undefined;
    if (body === undefined) return [];
    // Two identifiers are read out of the captured body, and neither is content: the model the
    // request named, and whether it carried a tool registry. The runtime's agent-loop request
    // carries one and its title request does not, so the endpoint's own record is what shows an
    // auxiliary request did or did not happen, and which model each request went to.
    let model;
    let hasTools;
    try {
      const parsed = JSON.parse(body);
      if (parsed !== null && typeof parsed === 'object') {
        hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        if (typeof parsed.model === 'string') model = parsed.model;
      }
    } catch {
      // An unreadable body still contributes its length and marker count.
    }
    return [
      {
        seq: typeof entry.seq === 'number' ? entry.seq : index,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        markerCount: body.split(MARKER_PREFIX).length - 1,
        ...(model === undefined ? {} : { model }),
        ...(hasTools === undefined ? {} : { hasTools }),
      },
    ];
  });
}

/**
 * What the loopback endpoint itself received, independent of the hook.
 *
 * The runtime's agent-loop request declares a tool registry and an auxiliary one does not, so the
 * endpoint's own body capture is a second, independent reading of "how many requests were
 * composed, and did any of them lack the agent loop". It cannot name the kind (a compaction
 * request looks like a title request), which is exactly why it is recorded *beside* the hook
 * counts instead of replacing them: agreement between the two is the evidence, and a disagreement
 * is a finding rather than something to average away.
 */
function endpointKindCounts(requests) {
  let withToolRegistry = 0;
  let withoutToolRegistry = 0;
  for (const request of requests) {
    if (request.hasTools === true) withToolRegistry += 1;
    else withoutToolRegistry += 1;
  }
  return { requests: requests.length, withToolRegistry, withoutToolRegistry };
}

/**
 * What kinds of model request the runtime composed, and which models it named.
 *
 * The counts come from the runtime's own hook invocations — the only channel that names a request
 * kind — and what the loopback endpoint received is recorded beside them as an independent
 * reading. `kindsRegistered` keeps the hook *name*, because the registration is what has to be the
 * measured one: a count of zero from a hook that never fires is a silence, not an absence.
 *
 * A source of `none` is an absence of evidence, not a zero, and the caller must treat it as such.
 */
function requestKindEvidence() {
  const lines = readJsonLines(kindsPath);
  const registration = lines.find((line) => Array.isArray(line?.registered));
  const kinds = {};
  const modelsNamed = {};
  const payloadKeys = new Set();
  const bump = (target, key) => {
    target[key] = (target[key] ?? 0) + 1;
  };
  if (registration !== undefined) {
    for (const line of lines) {
      if (typeof line?.kind !== 'string') continue;
      bump(kinds, line.kind);
      const id = P.modelRefToId(line.model);
      bump(modelsNamed, id ?? 'unidentified');
      if (Array.isArray(line.payloadKeys)) {
        for (const key of line.payloadKeys) {
          if (typeof key === 'string') payloadKeys.add(key);
        }
      }
    }
    return {
      source: 'model-request-hooks',
      kindsRegistered: registration.registered.filter((kind) => typeof kind === 'string'),
      kinds,
      modelsNamed,
      registrationFailures: registration.failures.filter((kind) => typeof kind === 'string'),
      payloadKeys: [...payloadKeys].sort(),
      endpointKinds: endpointKindCounts(providerRequests),
    };
  }
  if (providerRequests.length > 0) {
    for (const request of providerRequests) {
      bump(kinds, request.hasTools === true ? 'primary' : 'auxiliary');
      bump(modelsNamed, request.model ?? 'unidentified');
    }
    return {
      source: 'loopback-endpoint',
      kindsRegistered: [],
      kinds,
      modelsNamed,
      registrationFailures: [],
      payloadKeys: [],
      endpointKinds: endpointKindCounts(providerRequests),
    };
  }
  return {
    source: 'none',
    kindsRegistered: [],
    kinds,
    modelsNamed,
    registrationFailures: [],
    payloadKeys: [],
    endpointKinds: undefined,
  };
}

const providerRequests =
  args.providerCapture !== undefined && existsSync(args.providerCapture)
    ? wireFromProviderCapture(args.providerCapture)
    : [];
const wireSource =
  providerRequests.length > 0 ? 'loopback-endpoint' : wireLog.length > 0 ? 'hook-unmeasurable' : 'none';
const wireRecords = wireSource === 'loopback-endpoint' ? providerRequests : [];
/**
 * The latest summary per session.
 *
 * The observer's summary file is append-only and includes periodic checkpoints, so
 * every line is a *cumulative* snapshot of one session. Summing the lines would
 * multiply every count by the number of checkpoints written; the last line per
 * session is the one that describes the session.
 */
function latestPerSession(lines) {
  const bySession = new Map();
  for (const summary of lines) {
    const id = typeof summary?.sessionId === 'string' ? summary.sessionId : `unidentified-${bySession.size}`;
    bySession.set(id, summary);
  }
  return [...bySession.values()];
}

const summaryLines = readJsonLines(summaryPath);
const summaries = latestPerSession(summaryLines);

/** A reported value, or `undefined`: an `unavailable` measurement is never a zero. */
function reportedValue(measurement) {
  if (measurement === undefined || measurement === null) return undefined;
  if (typeof measurement !== 'object') return undefined;
  if (measurement.evidence === 'unavailable') return undefined;
  return typeof measurement.value === 'number' && Number.isFinite(measurement.value)
    ? measurement.value
    : undefined;
}

function sumDefined(values) {
  const present = values.filter((value) => typeof value === 'number');
  return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0);
}

/** Host-reported per-field values, read from the newest usable snapshot per session. */
function hostReportedUsage() {
  let source = 'unavailable';
  const input = [];
  const output = [];
  const reasoning = [];
  const cacheRead = [];
  const cacheWrite = [];
  const cost = [];
  let appliedViaSource = false;

  for (const summary of summaries) {
    const sourceReported = summary?.usage?.sourceReported;
    if (sourceReported && typeof sourceReported.usableEvents === 'number' && sourceReported.usableEvents > 0) {
      const latest = sourceReported.latest ?? {};
      if (typeof latest.input === 'number') input.push(latest.input);
      if (typeof latest.output === 'number') output.push(latest.output);
      if (typeof latest.reasoning === 'number') reasoning.push(latest.reasoning);
      if (typeof latest.cacheRead === 'number') cacheRead.push(latest.cacheRead);
      if (typeof latest.cacheWrite === 'number') cacheWrite.push(latest.cacheWrite);
      if (typeof latest.cost === 'number') cost.push(latest.cost);
      appliedViaSource = true;
      source = 'session.usage.updated';
      continue;
    }
    // Fall back to the per-field aggregate the observer derives from assistant
    // message records; `calculated` is kept as a label in the artifact so the
    // benchmark side can refuse to treat it as a direct measurement.
    const measurements = summary?.measurements ?? {};
    const fieldValue = (key) => {
      const measurement = measurements[key];
      if (measurement === undefined) return undefined;
      if (measurement.evidence !== 'measured' && measurement.evidence !== 'calculated') return undefined;
      return reportedValue(measurement);
    };
    const values = {
      input: fieldValue('inputTokens'),
      output: fieldValue('outputTokens'),
      reasoning: fieldValue('reasoningTokens'),
      cacheRead: fieldValue('cacheReadTokens'),
      cacheWrite: fieldValue('cacheWriteTokens'),
      cost: fieldValue('cost'),
    };
    if (Object.values(values).some((value) => typeof value === 'number')) {
      source = source === 'unavailable' ? 'assistant-message-aggregate' : source;
      if (typeof values.input === 'number') input.push(values.input);
      if (typeof values.output === 'number') output.push(values.output);
      if (typeof values.reasoning === 'number') reasoning.push(values.reasoning);
      if (typeof values.cacheRead === 'number') cacheRead.push(values.cacheRead);
      if (typeof values.cacheWrite === 'number') cacheWrite.push(values.cacheWrite);
      if (typeof values.cost === 'number') cost.push(values.cost);
    }
  }

  return {
    source,
    inputTokens: sumDefined(input),
    outputTokens: sumDefined(output),
    reasoningTokens: sumDefined(reasoning),
    cacheReadTokens: sumDefined(cacheRead),
    cacheWriteTokens: sumDefined(cacheWrite),
    costUsd: sumDefined(cost),
    aggregatedAcrossSessions: summaries.length > 1,
    usesDerivedAggregate: source === 'assistant-message-aggregate',
    appliedViaSource,
  };
}

const usage = hostReportedUsage();

const counts = summaries.reduce(
  (totals, summary) => ({
    toolCompletions: totals.toolCompletions + (summary?.counts?.toolCompletionsObserved ?? 0),
    toolStarts: totals.toolStarts + (summary?.counts?.toolStartsObserved ?? 0),
    assistantMessages:
      totals.assistantMessages + (summary?.usage?.messagesWithUsage ?? 0) + (summary?.usage?.messagesWithoutUsage ?? 0),
    repeatedFileReads:
      totals.repeatedFileReads + ((summary?.measurements?.repeatedFileReads?.value ?? 0) || 0),
  }),
  { toolCompletions: 0, toolStarts: 0, assistantMessages: 0, repeatedFileReads: 0 },
);

/** Safe Mode apply counters, summed across the session summaries of this arm. */
function applyEvidence() {
  const present = summaries.filter((summary) => summary?.safeModeApply !== undefined);
  if (present.length === 0) return null;
  return present.reduce(
    (totals, summary) => {
      const apply = summary.safeModeApply;
      return {
        requestsAttempted: totals.requestsAttempted + (apply.requestsAttempted ?? 0),
        requestsApplied: totals.requestsApplied + (apply.requestsApplied ?? 0),
        elidedOccurrences: totals.elidedOccurrences + (apply.elidedOccurrences ?? 0),
        elidedBytes: totals.elidedBytes + (apply.elidedBytes ?? 0),
        markerBytes: totals.markerBytes + (apply.markerBytes ?? 0),
      };
    },
    { requestsAttempted: 0, requestsApplied: 0, elidedOccurrences: 0, elidedBytes: 0, markerBytes: 0 },
  );
}

const apply = applyEvidence();

/**
 * What the containment guard recorded, reduced to counters.
 *
 * Read from the guard's own evidence file, so it describes this session's tool calls
 * rather than what the configuration was supposed to do. `guard: 'missing'` or
 * `'capability-missing'` is the signal that this session must not be treated as a
 * valid measurement, and the benchmark side refuses it for exactly that reason.
 */
const guardEvidenceLines = readJsonLines(guardEvidencePath);
const containmentSummary =
  typeof helperBundle.summarizeContainmentEvidence === 'function'
    ? helperBundle.summarizeContainmentEvidence(guardEvidenceLines)
    : {
        guardLoaded: false,
        rootKnown: false,
        blockedCalls: 0,
        allowedCalls: 0,
        blockedByTool: {},
        permissionRules: undefined,
        capabilityMissing: true,
      };

const containment = {
  guard:
    containmentSummary.guardLoaded === true
      ? 'loaded'
      : containmentSummary.capabilityMissing === true
        ? 'capability-missing'
        : 'missing',
  rootKnown: containmentSummary.rootKnown === true,
  blockedCalls: containmentSummary.blockedCalls ?? 0,
  allowedCalls: containmentSummary.allowedCalls ?? 0,
  blockedByTool: containmentSummary.blockedByTool ?? {},
  permissionRules: containmentSummary.permissionRules ?? null,
  deniedTools: helperBundle.deniedTools ?? null,
  configDigest: containmentConfigDigest,
  evidenceLines: guardEvidenceLines.length,
};

/**
 * What the **pre-transmission model guard** recorded, reduced to counters.
 *
 * The block is what makes "no unapproved model was requested" a checked fact rather than an
 * assumption: `hookRegistered` says the runtime accepted the one hook that refuses a request, and
 * `refused` is the count of requests that were stopped *before* being sent. A session whose guard
 * did not register, or that refused a request at all, is refused as a measurement rather than
 * compared — a refused request means the session left the declared envelope, whatever the endpoint
 * saw afterwards.
 */
const modelGuardEvidenceLines = readJsonLines(modelGuardEvidencePath);
const modelGuardSummary =
  typeof helperBundle.summarizeModelGuardEvidence === 'function'
    ? helperBundle.summarizeModelGuardEvidence(modelGuardEvidenceLines)
    : {
        loaded: false,
        hookRegistered: false,
        capabilityMissing: true,
        invocations: 0,
        allowed: 0,
        refused: 0,
        refusals: [],
        policyDigest: '',
        misconfigured: true,
      };

const modelGuard = {
  // `loaded` and `hookRegistered` are separate facts: the plugin ran, and the runtime accepted the
  // hook that refuses a request. Only the second one bounds anything.
  guard:
    modelGuardSummary.loaded === true && modelGuardSummary.hookRegistered === true
      ? 'loaded'
      : modelGuardSummary.capabilityMissing === true
        ? 'capability-missing'
        : 'missing',
  hook: requestKindVocabulary.hook,
  loaded: modelGuardSummary.loaded === true,
  hookRegistered: modelGuardSummary.hookRegistered === true,
  invocations: modelGuardSummary.invocations ?? 0,
  allowed: modelGuardSummary.allowed ?? 0,
  refused: modelGuardSummary.refused ?? 0,
  refusals: Array.isArray(modelGuardSummary.refusals) ? modelGuardSummary.refusals : [],
  misconfigured: modelGuardSummary.misconfigured === true,
  policyDigest: modelGuardSummary.policyDigest ?? '',
  envelope: modelGuardEnvelope ?? null,
  evidenceLines: modelGuardEvidenceLines.length,
};

const inSessionGovernor = {
  armed: governor.armed,
  reason: governor.reason,
  capUsd: governor.capUsd,
  polls: governorState?.polls ?? 0,
  reportedCostUsd: governorState?.reportedCostUsd ?? null,
  interrupted: governorState?.interrupted ?? false,
  interruptAttempts: governorState?.interruptAttempts ?? 0,
  killedAfterFailedInterrupt: governorState?.killedAfterFailedInterrupt ?? false,
};

const observerInternalErrors = summaries.reduce(
  (total, summary) => total + (summary?.adapter?.internalErrors ?? 0),
  0,
);

/** What the runtime was observed to compose, from its own hooks or from the endpoint. */
const requestKinds = requestKindEvidence();
// Every kind that is not the primary loop is auxiliary, including a kind the runtime reports and
// this harness has never heard of: an unrecognized request is the case where guessing would hide
// work the free-only policy does not allow. The rule lives in the policy module so both sides use
// the same one.
const auxiliaryKinds = P.auxiliaryRequestKinds(requestKinds.kinds);
const auxiliaryRequests = auxiliaryKinds.reduce(
  (total, kind) => total + (requestKinds.kinds[kind] ?? 0),
  0,
);
const endpointKinds = requestKinds.endpointKinds;

const artifact = {
  schemaVersion: 1,
  taskId: args.taskId,
  arm: args.arm,
  runId: args.runId,
  // This run's identity, echoed back from the caller's own value, and a completion flag
  // written only in this final statement. Together they let the caller prove the artifact
  // it reads was produced by *this* run and is whole.
  runNonce: args.runNonce,
  complete: true,
  pairIndex: args.pairIndex,
  attempt: args.attempt,
  startedAt: startedAt.toISOString(),
  durationMs,
  harness: 'opencode-coding-task',
  optimizerRevision: args.optimizerRevision ?? '0.0.0',
  repositoryRevision: args.repositoryRevision,
  promptHash: args.promptHash,
  model: args.model,
  mode: args.mode,
  runtime: args.runtime,
  runtimeVersion: runtimeVersion() ?? null,
  exitCode,
  timedOut,
  modelUnavailable,
  cliInvocation: { executable: 'opencode-cli', args: cliArgs.slice(0, -1), promptChars: prompt.length },
  // Which runtime carried the session, because it decides what the isolation claim
  // means: a private server shares nothing with the developer's installation, while the
  // background service carries that installation's config and plugins for both arms.
  runtimeMode: args.runtime,
  sessionCleanExit: exitCode === 0 && !timedOut,
  sessionsObserved: summaries.length,
  summaryLinesWritten: summaryLines.length,
  usage: {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
  },
  usageSource: usage.source,
  usageNotes: [
    usage.source === 'unavailable'
      ? 'The host reported no token field for this run, so every token field stays unavailable rather than being estimated.'
      : `Token fields come from ${usage.source}; the semantics of that series are not established by the harness, and the fields are never summed.`,
    ...(usage.usesDerivedAggregate
      ? [
          'The token fields are calculated aggregates of per-message reported values; the benchmark side records them as unavailable rather than as direct measurements, matching the documented adapter rule.',
        ]
      : []),
    ...(usage.aggregatedAcrossSessions
      ? [`Values were summed across ${summaries.length} sessions observed by this arm.`]
      : []),
  ],
  behaviour: {
    toolCalls: counts.toolCompletions,
    repeatedFileReads: counts.repeatedFileReads,
    assistantMessages: counts.assistantMessages,
    observerInternalErrors,
    optimizerErrors: summaries.reduce(
      (total, summary) => total + (summary?.safeModeApply?.refused?.['plan-mismatch'] ?? 0),
      0,
    ),
    recoveryAttempts: summaries.reduce(
      (total, summary) =>
        total + (typeof summary?.usage?.usageRegressionsObserved === 'number' ? summary.usage.usageRegressionsObserved : 0),
      0,
    ),
  },
  apply,
  containment,
  modelGuard,
  nativePermissions: {
    observed: nativePermissions.observed === true,
    source: nativePermissions.source,
    rules: nativePermissions.rules,
    requiredDenies: REQUIRED_NATIVE_DENIES,
    missingRequiredDenies: missingNativeDenies,
    allRequiredPresent: nativePermissions.observed === true && missingNativeDenies.length === 0,
    error: nativePermissions.error ?? null,
  },
  inSessionGovernor,
  // The free-only envelope this run was supposed to stay inside, as *this run* exercised it:
  // the exact configuration written into the repository, the runtime's own resolved reading of
  // it, the price row behind the model, and the request kinds the runtime then composed. The
  // intake re-derives its verdict from these fields, so a run that drifted out of the policy is
  // refused as a measurement rather than compared.
  modelPolicy: {
    primaryModel: P.FREE_ONLY_PRIMARY_MODEL,
    auxiliaryModel: P.FREE_ONLY_AUXILIARY_MODEL,
    approvedModels: [...P.FREE_ONLY_APPROVED_MODELS],
    config: modelConfig,
    configDigest: modelConfigDigest,
    configAccepted: modelConfigAccepted,
    catalogueSource: priceVerification.catalogueSource,
    priceVerifiedFree: priceVerification.verified,
    priceRow: priceFacts.priceRow ?? null,
    priceCheckSkippedReason: priceVerification.skippedReason ?? null,
    refusals: [...priceRefusals],
    resolved: resolvedPolicy,
    requests: requestKinds,
    titleGenerationSuppressed: cliArgs.includes('--title'),
  },
  wire: {
    source: wireSource,
    requests: wireRecords,
    hookInvocations: wireLog.length,
    // Requests the probe saw but could not measure; reported rather than dropped.
    unmeasurableRequests,
    allRequestsToProvider: true,
  },
  notes: [
    'This artifact contains counts and lengths only: no prompt, tool text, file path, header or body content was recorded by the driver or the probe.',
    args.runtime === 'service'
      ? 'The session ran on the developer\u2019s background service, so that installation\u2019s global configuration and plugins applied to it. Both arms saw the same environment; the repository, the prompt and the switch were the only experimental differences.'
      : 'The session ran on a private server with an isolated config and data home, so nothing outside the run could influence it.',
    'Exactly one session is started per arm run, in a fresh copy of the task repository, so no session state is shared between the arms.',
    wireSource === 'loopback-endpoint'
      ? 'Request lengths and marker counts come from the loopback endpoint the run was pointed at, so they describe the bytes the runtime actually sent in this arm.'
      : wireSource === 'hook-unmeasurable'
        ? `${unmeasurableRequests} outbound request callback(s) reached the http.request hook, each one a request the runtime composed and was about to send (the body arrived as a ReadableStream, so no wire length or marker count is claimed for this mode). What this count is not: it is not a count of provider attempts and not a count of completed requests — this hook cannot see a retry the runtime may make internally, nor whether the provider accepted the request, and the harness does not infer either. A session that received no response reports no usage for that reason, not because the request count was zero.`
        : 'No outbound request was observed, so the artifact states no wire evidence at all rather than a zero.',
    ...(modelUnavailable
      ? [
          'The runtime refused the requested model (`model unavailable`), so this session never composed a request. It is not a measurement of zero tokens: nothing was sent.',
        ]
      : []),
    containment.guard === 'loaded'
      ? `Containment: the guard plugin registered its tool hook and enforced the policy for this session (${containment.blockedCalls} call(s) refused, ${containment.allowedCalls} path-checked call(s) allowed). The native permission policy written into the repository is byte-identical in both arms; its digest is ${containmentConfigDigest}.`
      : `Containment: the guard plugin did not register its tool hook (${containment.guard}), so this session did not carry the enforcement layer and must not be treated as a valid measurement.`,
    modelGuard.guard === 'loaded'
      ? `Pre-transmission model guard: the hook that refuses a model request was registered before the session dispatched anything, and bounded ${modelGuard.invocations} request(s) against the approved envelope (${modelGuard.allowed} allowed, ${modelGuard.refused} refused)${modelGuard.refused > 0 ? ` — refusals: ${modelGuard.refusals.map((entry) => `${entry.reason}${entry.requestKind === undefined ? '' : `@${entry.requestKind}`}${entry.model === undefined ? '' : `[${entry.model}]`}`).join(', ')}` : ''}. The envelope is ${String(modelGuard.policyDigest)} — the digest of the same configuration both arms receive — and it approves only \`${P.FREE_ONLY_PRIMARY_MODEL}\` and \`${P.FREE_ONLY_AUXILIARY_MODEL}\`. Every request the runtime dispatches for any provider passes this hook; there is no provider filter, because a filter would let a request from an unnamed provider skip the guard.`
      : `Pre-transmission model guard: the hook that refuses an unapproved model request did NOT register for this session (${modelGuard.guard}${modelGuard.misconfigured ? ', and the guard was constructed without a usable envelope' : ''}), so nothing shows an unapproved model was stopped before it was sent, and this session must not be treated as a valid measurement.`,
    modelGuard.refused > 0
      ? `An unapproved model request was refused before transmission during this session (${modelGuard.refusals.map((entry) => `${entry.reason}${entry.requestKind === undefined ? '' : `@${entry.requestKind}`}${entry.model === undefined ? '' : `[${entry.model}]`}`).join(', ')}). The request was never sent, and this run is refused as a measurement: a session that tried to step outside the approved envelope is not the free-only session the experiment declares.`
      : `No unapproved model request was attempted during this session: none of the ${modelGuard.invocations} request(s) the guard saw named a model outside the approved pair. This is a count of refusals from the hook that would have made them, not an inference from the absence of an error.`,
    nativePermissions.observed === true
      ? `Native permission layer: the runtime resolved ${nativePermissions.rules.length} rule(s) for this repository (${nativePermissions.rules.map((rule) => `${rule.action}=${rule.effect}`).join(', ')})${missingNativeDenies.length === 0 ? ', including every deny the canary policy requires' : `, MISSING the required denies: ${missingNativeDenies.join(', ')}`}.`
      : `Native permission layer: the runtime did not report its resolved permission rules (${String(nativePermissions.error ?? 'no reason reported')}), so only the plugin layer is evidenced for this session and it must not be treated as a fully contained run.`,
    inSessionGovernor.armed
      ? `In-session spending governor: armed at $${String(inSessionGovernor.capUsd)} per session, polled ${inSessionGovernor.polls} time(s) and saw ${inSessionGovernor.reportedCostUsd === null ? 'no reported cost' : `$${Number(inSessionGovernor.reportedCostUsd).toFixed(4)}`}${inSessionGovernor.interrupted ? '; the runtime confirmed the interrupt' : ''}${inSessionGovernor.killedAfterFailedInterrupt ? '; the native stop never confirmed, so the client process was killed instead' : ''}. The overshoot this bound allows is limited to the steps that complete between a poll and the interrupt landing; the post-session caps remain the sequence bound.`
      : `In-session spending governor: not armed (${String(inSessionGovernor.reason)}).`,
    `Free-only model policy: primary \`${P.FREE_ONLY_PRIMARY_MODEL}\`, auxiliary \`${P.FREE_ONLY_AUXILIARY_MODEL}\` (${P.FREE_ONLY_APPROVED_MODELS.length} approved model(s)); the repository received the same configuration in both arms (model fragment digest ${modelConfigDigest}, containment fragment digest ${containmentConfigDigest}, written document digest ${projectConfigDigest}).`,
    priceProbe === undefined
      ? `Model price: not checked in this mode (${String(priceVerification.skippedReason)}).`
      : priceVerification.verified
        ? `Model price: the ${priceFacts.runtime} runtime prices \`${args.model}\` at zero in every applicable tier (${P.FREE_ONLY_PRICE_FIELDS.map((field) => `${field}=0`).join(', ')}), read before any session was spawned.`
        : `Model price: NOT VERIFIED FREE (${priceRefusals.join('; ')}).`,
    `Resolved configuration: ${P.describeResolvedPolicy(resolvedPolicy)} — read from the runtime\u2019s own \`config.get\` for this repository before the session started, so a key the runtime dropped would be visible here rather than assumed.`,
    `Request kinds: ${requestKinds.source === 'none' ? 'none observed (this is an absence of evidence, not a zero)' : `${Object.entries(requestKinds.kinds).map(([kind, count]) => `${kind}=${count}`).join(', ') || 'no request counted'} via ${requestKinds.source}${requestKinds.kindsRegistered.length > 0 ? `, hook ${requestKinds.kindsRegistered.join(', ')} with payload keys [${requestKinds.payloadKeys.join(',') || 'none recorded'}]` : ''}${requestKinds.registrationFailures.length > 0 ? `; the runtime refused the registration: ${requestKinds.registrationFailures.join(', ')}` : ''}`}. Models named on the wire: ${Object.entries(requestKinds.modelsNamed).map(([id, count]) => `${id}×${count}`).join(', ') || 'none recorded'}. The endpoint\u2019s own record: ${endpointKinds === undefined ? 'no endpoint capture for this mode' : `${endpointKinds.requests} request(s), ${endpointKinds.withToolRegistry} carrying the agent-loop tool registry and ${endpointKinds.withoutToolRegistry} without`}. ${auxiliaryRequests === 0 ? 'No auxiliary (title, compaction or generate) request was composed, and the session title was supplied on the command line so none was needed.' : `${auxiliaryRequests} auxiliary request(s) were composed (${auxiliaryKinds.join(', ')}), which the free-only policy does not permit.`}`,
  ],
};

writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ artifact: artifactPath, exitCode, timedOut, sessions: summaries.length, wire: wireRecords.length })}\n`);
process.exit(0);
