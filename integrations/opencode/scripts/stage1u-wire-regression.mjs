/**
 * Stage 1U **Safe Mode wire regression** — the Stage 1T experiment, turned into a repeatable gate.
 *
 * It answers one question per run: *does the elision still reach the real outbound request?* — and it
 * answers it the same way every time, against the same pinned runtime, with no model call and no
 * credential.
 *
 * Structure:
 *
 * 1. **Pin first, fail closed.** The installed runtime's version, size and SHA-256 must match the pin
 *    recorded in `src/runtime-pin.ts`. Missing, unreadable or different → print why and exit 1 without
 *    running anything. A check that quietly passed on a different runtime would be worse than no check.
 * 2. **Six real runs** through the installed CLI against a loopback capture server: the eligible
 *    treatment and its repeat, the disabled control, the ineligible pair and the unverified-kind
 *    control. Each run must show the hooks the harness recorded (a session that never interacted with
 *    the runtime fails here) and must have composed at least two requests.
 * 3. **Judge the wire**: the Stage 1T verifier's checks, plus this script's own determinism check
 *    (the repeated treatment must produce the same body) and a locality check (every captured request
 *    went to loopback, so no provider was contacted).
 * 4. **Prove isolation**: the runtime is asked for its own directories with the overrides and without
 *    them, and both answers are judged. A check that passes on either answer is not a gate, so the
 *    negative control is a check in its own right.
 *
 * "Rollback" and "bypass" are the refusal paths: the disabled and unverified-kind runs must leave the
 * body byte-identical to the control, and the ineligible pair must not carry a marker. Those are the
 * same guarantees a bypass switch relies on.
 *
 * Usage:
 *   npm run verify:wire                     (from the repository root, or the opencode workspace)
 *   node scripts/stage1u-wire-regression.mjs [--base <dir>]
 *
 * Exit codes: 0 = every check passed; 1 = a check failed or the runtime is unverified; 2 = the harness
 * itself could not run (missing scripts, spawn failure).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scriptsDir = import.meta.dirname;
const packageDir = join(scriptsDir, '..');
const CLI = join(
  process.env.LOCALAPPDATA ?? '.',
  'Programs',
  '@opencodedesktop',
  'resources',
  'opencode-cli.exe',
);
const VERSION_FILE = join(
  process.env.LOCALAPPDATA ?? '.',
  'Programs',
  '@opencodedesktop',
  'resources',
  'opencode-cli.version',
);

function parseArgs(argv) {
  const args = { base: join(process.env.LOCALAPPDATA ?? '.', 'Temp', 'dr-token-stage1u') };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--base') {
      args.base = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const failures = [];

function report(ok, name, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures.push(name);
  }
}

/** Run a node script in this package and return `{ status, stdout, stderr }`. */
function runNode(script, scriptArgs, extraEnv = {}) {
  const result = spawnSync(process.execPath, [join(scriptsDir, script), ...scriptArgs], {
    cwd: packageDir,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readJsonLines(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function lastSummary(path) {
  const lines = readJsonLines(path);
  return lines.length === 0 ? undefined : lines[lines.length - 1];
}

/* -------------------------------------------------------------------------- */
/* 1. Fail closed before doing anything                                       */
/* -------------------------------------------------------------------------- */

console.log('Safe Mode wire regression (Stage 1U)');
console.log('');

const { verifyPinnedRuntime, describeRuntimeRefusal, isPinnedRuntimeVerified } = await import(
  pathToFileURL(join(packageDir, 'dist', 'runtime-pin.js')).href
);

function probeRuntime() {
  if (!existsSync(CLI)) {
    return { exists: false, version: undefined, sha256: undefined, bytes: undefined };
  }
  let version;
  try {
    version = existsSync(VERSION_FILE)
      ? readFileSync(VERSION_FILE, 'utf8').trim()
      : undefined;
  } catch {
    version = undefined;
  }
  let sha256;
  let bytes;
  try {
    bytes = statSync(CLI).size;
    sha256 = createHash('sha256').update(readFileSync(CLI)).digest('hex');
  } catch {
    sha256 = undefined;
    bytes = undefined;
  }
  return { exists: true, version, sha256, bytes };
}

const verdict = verifyPinnedRuntime(probeRuntime());
report(isPinnedRuntimeVerified(verdict), 'the installed runtime matches the pinned revision', describeRuntimeRefusal(verdict));
if (!isPinnedRuntimeVerified(verdict)) {
  console.log('');
  console.log('Refusing to run the wire experiment: the evidence in this repository covers only the pinned runtime.');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* 2. Run the six real experiments                                            */
/* -------------------------------------------------------------------------- */

const setup = runNode('stage1t-setup.mjs', ['--base', args.base]);
if (setup.status !== 0) {
  console.error(setup.stderr || setup.stdout);
  console.error('The disposable project could not be created.');
  process.exit(2);
}

/** The five judged runs plus a second, independent execution of the treatment. */
const runs = [
  { name: 'wire-disabled', elision: 'off', readPath: 'fixtures/big-content.json', kind: 'context-hook' },
  { name: 'wire-eligible', elision: 'apply', readPath: 'fixtures/big-content.json', kind: 'context-hook' },
  { name: 'wire-eligible-repeat', elision: 'apply', readPath: 'fixtures/big-content.json', kind: 'context-hook' },
  { name: 'wire-ineligible-off', elision: 'off', readPath: 'fixtures/small-content.json', kind: 'context-hook' },
  { name: 'wire-ineligible-apply', elision: 'apply', readPath: 'fixtures/small-content.json', kind: 'context-hook' },
  { name: 'wire-kind-unverified', elision: 'apply', readPath: 'fixtures/big-content.json', kind: 'unknown' },
];

/** Hook names the harness must have observed for a run to count as a real session. */
const REQUIRED_HOOKS = ['prompt', 'context', 'model.request', 'http.request'];

for (const run of runs) {
  const result = runNode('stage1t-run.mjs', [
    '--base',
    args.base,
    '--name',
    run.name,
    '--mode',
    'scripted',
    '--tool-calls',
    '2',
    '--read-path',
    run.readPath,
    '--hooks',
    'all',
    '--elision',
    run.elision,
    '--kind',
    run.kind,
  ]);
  const summary = lastSummary(join(args.base, 'evidence', `${run.name}-summary.json`));
  // `opencode plugin list` reports an empty table until the runtime has built its index, so the
  // harness's own per-invocation records are the evidence that the plugin was really loaded and its
  // callbacks really ran. That is stronger than a discovery listing: it is the observed session.
  const records = readJsonLines(join(args.base, 'evidence', `${run.name}-probe.jsonl`));
  const hooks = new Set(
    records.filter((record) => record.event === 'session-hook').map((record) => record.hook),
  );
  const missingHooks = REQUIRED_HOOKS.filter((hook) => !hooks.has(hook));
  report(
    result.status === 0 && summary?.cliExit === 0 && missingHooks.length === 0,
    `run ${run.name} ran a real session through the harness`,
    `cliExit=${summary?.cliExit ?? 'unknown'} hooks=${hooks.size} missing=${missingHooks.join(',') || 'none'}`,
  );

  const elisionRecords = records.filter((record) => record.elision !== undefined);
  if (run.elision === 'apply') {
    const attempted = elisionRecords.length > 0;
    report(
      attempted,
      `run ${run.name} recorded the pass's own outcome`,
      `${elisionRecords.length} decision record(s)`,
    );
  } else {
    report(
      elisionRecords.length === 0,
      `run ${run.name} (bypassed) never invoked the pass`,
      'no decision record, as expected when the pass is off',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Judge the wire                                                          */
/* -------------------------------------------------------------------------- */

const verify = runNode('stage1t-verify-wire.mjs', ['--base', args.base]);
const verifyLines = verify.stdout.trim().split('\n');
const failedVerifyChecks = verifyLines.filter((line) => line.startsWith('FAIL'));
report(
  verify.status === 0,
  'the Stage 1T wire checks still pass',
  `${verifyLines.filter((line) => line.startsWith('PASS')).length} passed, ${failedVerifyChecks.length} failed`,
);
for (const line of failedVerifyChecks) {
  console.log(`      ${line}`);
}

const capture = (name) =>
  join(args.base, 'evidence', `${name}-capture.jsonl`);
const lastBody = (name) => {
  const rows = readJsonLines(capture(name));
  return rows.length === 0 ? undefined : rows[rows.length - 1];
};

const eligible = lastBody('wire-eligible');
const repeat = lastBody('wire-eligible-repeat');
const disabled = lastBody('wire-disabled');

report(
  eligible !== undefined && repeat !== undefined && eligible.body === repeat.body,
  'a repeated execution produces the identical outbound request (no drift, no double edit)',
  `bytes=${eligible?.bodyLength ?? 'none'}/${repeat?.bodyLength ?? 'none'}`,
);

report(
  disabled !== undefined && eligible !== undefined && eligible.body.length < disabled.body.length,
  'the treatment body is shorter than the disabled control',
  `disabled=${disabled?.bodyLength ?? 'none'} treatment=${eligible?.bodyLength ?? 'none'}`,
);

const requests = runs.flatMap((run) => readJsonLines(capture(run.name)));
const requestPaths = requests.map((row) => `${String(row.method ?? '')} ${String(row.url ?? '')}`);
const perRunCounts = runs.map((run) => readJsonLines(capture(run.name)).length);
report(
  requests.length > 0 &&
    perRunCounts.every((count) => count > 0) &&
    requestPaths.every((entry) => entry.startsWith('POST /v1')),
  'every request of every run reached the loopback provider base path',
  `${requests.length} request(s) over ${runs.length} run(s)`,
);

// "No provider was contacted" is asserted from the request path, not from a directory: the runs
// override the provider's baseURL with `OPENCODE_CONFIG_CONTENT` to point at the loopback capture
// server, so any request the runtime composed landed here. That is the property the check defends.
//
// This spot used to repeat the predicate above, so it could never fail on its own. It now asserts the
// volume a real session must produce: each run drives two scripted tool calls, so a run that composed
// fewer than two requests did not actually hold the session the checks below reason about.
const minimumRequestsPerRun = 2;
report(
  perRunCounts.every((count) => count >= minimumRequestsPerRun),
  `every run composed at least ${minimumRequestsPerRun} requests, so each session really ran its tool calls`,
  `per-run requests: ${perRunCounts.join(', ')}`,
);/* -------------------------------------------------------------------------- */
/* 3b. Isolation, proven rather than assumed                                   */
/* -------------------------------------------------------------------------- */

// The runtime is asked about its own directories through `debug paths`, twice: once with the
// overrides the runs use, and once without them. Two rules make this a check rather than a note:
//
//   * the isolated answer must point inside the directories this script created, so the overrides did
//     take effect;
//   * the unisolated answer must *differ*, so the first rule cannot be satisfied by an answer that
//     never depended on the overrides at all.
//
// `debug paths` is the runtime's own answer, computed from the environment it is given. It is asked
// **without** `--standalone` because this subcommand does not accept that flag (it prints its help
// instead), which is what made an earlier version of this check quietly unmeasurable. An earlier
// version still *did* consult the background service by accident, and concluded from that answer that
// this platform ignores the overrides — a conclusion the isolated answer below contradicts.
const isolatedEnv = {
  ...process.env,
  XDG_CONFIG_HOME: join(args.base, 'iso', 'config'),
  XDG_DATA_HOME: join(args.base, 'iso', 'data'),
  PWD: args.base,
};

function observedPaths(env) {
  const result = spawnSync(CLI, ['debug', 'paths'], {
    cwd: args.base,
    ...(env === undefined ? {} : { env }),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const line = (key) => {
    const match = new RegExp(`(?:^|\\n)\\s*${key}\\s+(.+?)\\r?$`, 'm').exec(text);
    return match === null ? undefined : match[1].trim();
  };
  return { config: line('config'), data: line('data'), status: result.status ?? -1 };
}

const isolatedPaths = observedPaths(isolatedEnv);
const unisolatedPaths = observedPaths(undefined);
const within = (value, root) =>
  typeof value === 'string' &&
  value.replace(/\\/g, '/').toLowerCase().startsWith(root.replace(/\\/g, '/').toLowerCase());
const configInside = within(isolatedPaths.config, join(args.base, 'iso', 'config'));
const dataInside = within(isolatedPaths.data, join(args.base, 'iso', 'data'));
console.log(
  `      isolated private server paths: config=${isolatedPaths.config ?? 'unreported'} data=${isolatedPaths.data ?? 'unreported'}`,
);
console.log(
  `      unisolated control paths:      config=${unisolatedPaths.config ?? 'unreported'} data=${unisolatedPaths.data ?? 'unreported'}`,
);
report(
  configInside && dataInside,
  'the runtime resolved its config and data inside the isolated homes when the overrides were set',
  'asked of the runtime itself (debug paths) with the same overrides the runs use',
);
report(
  unisolatedPaths.status === 0 &&
    (unisolatedPaths.config !== isolatedPaths.config ||
      unisolatedPaths.data !== isolatedPaths.data),
  'the isolation check can fail: without the overrides the runtime reports other directories',
  'the negative control that keeps the check above from passing vacuously',
);

// The strongest form of the same claim is server-side: the private server the runs used must have left
// its own store inside the isolated data home. That is a file the runtime wrote, not a variable an
// operator set, so it cannot be true of a run that used the machine's own store.
const isolatedStore = join(args.base, 'iso', 'data', 'opencode', 'opencode.db');
report(
  existsSync(isolatedStore),
  'the private server kept its own database inside the isolated data home',
  `looking for ${isolatedStore}`,
);

// The strongest form of the claim is not where a variable points but which files a session would
// obey. `config.get` is a server operation, so with `--standalone` the private server answers about
// itself. (`debug config` cannot be used for this: it takes no `--standalone`, so the background
// service answers it and reports the developer's own file — the trap that produced the old, wrong
// "this platform ignores XDG overrides" conclusion.)
function configSources(env, standalone) {
  const result = spawnSync(CLI, standalone ? ['api', 'config.get', '--standalone'] : ['api', 'config.get'], {
    cwd: args.base,
    ...(env === undefined ? {} : { env }),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  try {
    const parsed = JSON.parse(result.stdout ?? '');
    return Array.isArray(parsed)
      ? parsed.map((entry) => entry?.path).filter((entry) => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

const isolatedRoot = join(args.base, 'iso');
const isolatedSources = configSources(isolatedEnv, true);
const serviceSources = configSources(undefined, false);
console.log(`      private server configuration sources: ${isolatedSources.join(', ') || 'none reported'}`);
console.log(`      background service configuration sources: ${serviceSources.join(', ') || 'none reported'}`);
report(
  isolatedSources.length > 0 && isolatedSources.every((source) => within(source, isolatedRoot)),
  'every configuration source the private server loads is inside the isolated directory',
  `${isolatedSources.length} source(s) reported by the server the runs used`,
);
report(
  serviceSources.some((source) => !within(source, isolatedRoot)),
  'the configuration-source check can fail: the background service reports sources outside it',
  'the negative control for the check above',
);


const markerCount = (body) =>
  (body === undefined ? -1 : body.split('[dr-token/safe-mode/v1:').length - 1);
report(
  markerCount(eligible?.body) === 1 && markerCount(repeat?.body) === 1,
  'the marker appears exactly once in each treatment request',
  `eligible=${markerCount(eligible?.body)} repeat=${markerCount(repeat?.body)}`,
);

console.log('');
if (failures.length === 0) {
  console.log('ALL WIRE REGRESSION CHECKS PASSED');
  process.exit(0);
}
console.log(`${failures.length} WIRE REGRESSION CHECK(S) FAILED: ${failures.join('; ')}`);
process.exit(1);
