/**
 * Stage 1T experiment runner — drives the **real** OpenCode runtime once, against the loopback capture
 * server, and summarizes what happened without printing request content.
 *
 * It starts `stage1r-capture-server.mjs`, waits for its `LISTENING` line, runs the pinned CLI in the
 * disposable project created by `stage1t-setup.mjs` with the provider pointed at the server, then stops
 * the server and prints a bounded, content-free summary:
 *
 *   - which session hooks fired, with the payload key names and the `kind` when the payload carries one;
 *   - what the shipped elision module recorded for each `context` invocation (counts and booleans only);
 *   - how many requests the server received, their byte lengths, and whether each body contained the
 *     elision marker.
 *
 * Usage:
 *   node stage1t-run.mjs --base <dir> --name <run> [--mode scripted|probe] [--tool-calls 1]
 *                        [--read-path fixtures/big-content.json] [--hooks all|primary]
 *                        [--elision off|plan-only|apply] [--kind context-hook|unknown]
 *                        [--prompt "…"] [--title "…"] [--context-limit <n>]
 *
 * Nothing here is shipped: it is the experiment's own harness, and the product code it exercises is the
 * built package under `integrations/opencode/dist`.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {
    base: join(process.env.LOCALAPPDATA ?? '.', 'Temp', 'dr-token-stage1t'),
    name: 'run',
    mode: 'scripted',
    toolCalls: 1,
    readPath: 'fixtures/big-content.json',
    hooks: 'all',
    elision: 'off',
    // How the harness established the request kind. `context-hook` is the fact under test: the
    // harness registers on `session.hook("context")`, the primary-request hook.
    kind: 'context-hook',
    prompt: 'Read fixtures/big-content.json twice and report the note field.',
    title: undefined,
    continueSession: false,
    // When set, the synthetic provider's model declares this token context limit, which is how the
    // request-kind experiment asks the runtime to consider its conversation overflowing and compact.
    contextLimit: undefined,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--base') args.base = value;
    else if (key === '--name') args.name = value;
    else if (key === '--mode') args.mode = value;
    else if (key === '--tool-calls') args.toolCalls = Number(value);
    else if (key === '--read-path') args.readPath = value;
    else if (key === '--hooks') args.hooks = value;
    else if (key === '--elision') args.elision = value;
    else if (key === '--kind') args.kind = value;
    else if (key === '--prompt') args.prompt = value;
    else if (key === '--title') args.title = value;
    else if (key === '--context-limit') args.contextLimit = Number(value);
    else if (key === '--no-title') args.title = undefined;
    else if (key === '--continue') args.continueSession = value !== 'false';
    if (value !== undefined && key.startsWith('--')) index += 1;
  }
  return args;
}

const args = parseArgs(process.argv);
const CLI = join(process.env.LOCALAPPDATA ?? '.', 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe');
const captureServer = join(import.meta.dirname, 'stage1r-capture-server.mjs');
const distModule = join(import.meta.dirname, '..', 'dist', 'safe-mode-elision.js');

const project = join(args.base, 'project');
const evidenceDir = join(args.base, 'evidence');
const capturePath = join(evidenceDir, `${args.name}-capture.jsonl`);
const probePath = join(evidenceDir, `${args.name}-probe.jsonl`);
writeFileSync(probePath, '');

const server = spawn(
  process.execPath,
  [
    captureServer,
    '--capture',
    capturePath,
    '--port',
    '0',
    '--mode',
    args.mode,
    '--read-path',
    args.readPath,
    '--tool-calls',
    String(args.toolCalls),
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const port = await new Promise((resolve, reject) => {
  let buffered = '';
  const timer = setTimeout(() => reject(new Error('capture server did not report LISTENING')), 15_000);
  server.stdout.on('data', (chunk) => {
    buffered += String(chunk);
    const match = /LISTENING (\d+)/.exec(buffered);
    if (match) {
      clearTimeout(timer);
      resolve(Number(match[1]));
    }
  });
  server.on('error', reject);
});

// Prove the harness was discovered before running anything: a silently unloaded plugin would
// otherwise look like a plugin that observed nothing.
const discovery = await new Promise((resolve) => {
  const list = spawn(CLI, ['plugin', 'list'], {
    cwd: project,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(args.base, 'iso', 'config'),
      XDG_DATA_HOME: join(args.base, 'iso', 'data'),
      PWD: project,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  list.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  list.on('close', () => resolve(out.trim()));
  list.on('error', () => resolve('plugin list failed'));
});

const baseURL = `http://127.0.0.1:${port}/v1`;
const provider = { options: { baseURL } };
if (args.contextLimit !== undefined && Number.isFinite(args.contextLimit)) {
  provider.models = { 'big-pickle': { limit: { context: args.contextLimit, output: args.contextLimit } } };
}
const configContent = JSON.stringify({ provider: { opencode: provider } });

const cliArgs = ['run', '--standalone', '--auto', '--model', 'opencode/big-pickle'];
if (args.continueSession) {
  cliArgs.push('--continue');
}
if (args.title !== undefined) {
  cliArgs.push('--title', args.title);
}
cliArgs.push(args.prompt);

const cli = spawn(CLI, cliArgs, {
  cwd: project,
  env: {
    ...process.env,
    // The runtime resolves the session's project from `PWD`, not from the child's real working
    // directory: without this the disposable project is ignored and the plugin under test is never
    // loaded (observed in this stage as a discovered-but-never-set-up plugin).
    PWD: project,
    XDG_CONFIG_HOME: join(args.base, 'iso', 'config'),
    XDG_DATA_HOME: join(args.base, 'iso', 'data'),
    OPENCODE_CONFIG_CONTENT: configContent,
    DR_TOKEN_1T_EVIDENCE: probePath,
    DR_TOKEN_1T_HOOKS: args.hooks,
    DR_TOKEN_1T_ELISION: args.elision,
    DR_TOKEN_1T_KIND: args.kind,
    DR_TOKEN_1T_MODULE: pathToFileURL(distModule).href,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let cliStdout = '';
let cliStderr = '';
cli.stdout.on('data', (chunk) => {
  cliStdout += String(chunk);
});
cli.stderr.on('data', (chunk) => {
  cliStderr += String(chunk);
});

const cliExit = await new Promise((resolve) => {
  cli.on('close', (code) => resolve(code ?? -1));
  cli.on('error', () => resolve(-1));
});

server.kill();
writeFileSync(join(evidenceDir, `${args.name}-cli.log`), `${cliStdout}\n--- stderr ---\n${cliStderr}\n`, 'utf8');

const marker = '[dr-token/safe-mode/v1:';
const captures = existsSync(capturePath)
  ? readFileSync(capturePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];

const probes = readFileSync(probePath, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const summary = {
  run: args.name,
  cliExit,
  port,
  harnessDiscovered: discovery.includes('dr-token-1t-harness'),
  contextLimit: args.contextLimit ?? null,
  requests: captures.map((capture) => ({
    seq: capture.seq,
    url: capture.url,
    bodyLength: capture.bodyLength,
    hasMarker: capture.body.includes(marker),
    markerCount: capture.body.split(marker).length - 1,
    roles: (JSON.parse(capture.body).messages ?? []).map((message) => message.role).join(','),
  })),
  hooks: {},
  hookKeySets: {},
  hookOrder: [],
  elisions: [],
  other: [],
};

for (const probe of probes) {
  if (probe.event === 'session-hook') {
    const key = `${probe.hook}${probe.kind === undefined ? '' : `:${probe.kind}`}`;
    summary.hooks[key] = (summary.hooks[key] ?? 0) + 1;
    summary.hookOrder.push(key);
    const keySet = [...(probe.keys ?? [])].sort().join(',');
    summary.hookKeySets[key] = summary.hookKeySets[key] ?? [];
    if (!summary.hookKeySets[key].includes(keySet)) {
      summary.hookKeySets[key].push(keySet);
    }
    if (probe.elision !== undefined) {
      summary.elisions.push(probe.elision);
    }
  } else {
    summary.other.push(probe);
  }
}

appendFileSync(join(evidenceDir, `${args.name}-summary.json`), `${JSON.stringify(summary)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
