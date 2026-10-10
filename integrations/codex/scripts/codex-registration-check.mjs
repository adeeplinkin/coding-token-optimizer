#!/usr/bin/env node
/**
 * Verify that a Codex runtime *discovers* the Dr. Token Codex observer's hooks.
 *
 * This is the registration step of the live-validation ladder, and it needs no
 * model call, no account and no user configuration:
 *
 *   1. it starts `codex app-server` against an **isolated `CODEX_HOME`** that the
 *      caller prepared (never the user's `~/.codex`),
 *   2. it performs the documented `initialize` / `initialized` handshake,
 *   3. it calls `hooks/list` for a scratch project directory, and
 *   4. it prints a JSON report of what Codex reported about each discovered hook.
 *
 * It sends no `turn/start`, so no model request is made and nothing is spent, and
 * it writes no configuration. What it proves is *registration/discovery*; whether
 * a hook actually fires during a turn requires a real turn and is therefore out of
 * scope here (see `docs/CODEX_OBSERVER.md`).
 *
 * Usage:
 *   CODEX_BIN=<path to codex.exe> \
 *   CODEX_HOME=<isolated home> \
 *   PROJECT_DIR=<scratch project> \
 *   node integrations/codex/scripts/codex-registration-check.mjs
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const CODEX_BIN = process.env.CODEX_BIN;
const CODEX_HOME = process.env.CODEX_HOME;
const PROJECT_DIR = process.env.PROJECT_DIR;

if (!CODEX_BIN || !CODEX_HOME || !PROJECT_DIR) {
  console.error('CODEX_BIN, CODEX_HOME and PROJECT_DIR must all be set.');
  process.exit(2);
}

const received = [];
const child = spawn(CODEX_BIN, ['app-server', '--listen', 'stdio://'], {
  cwd: PROJECT_DIR,
  env: { ...process.env, CODEX_HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    received.push(JSON.parse(line));
  } catch {
    received.push({ raw: line });
  }
});
child.stderr.on('data', (chunk) => received.push({ stderr: String(chunk).slice(0, 300) }));
child.on('exit', (code) => received.push({ exit: code }));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

send({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: { name: 'dr_token_codex_registration_check', title: 'Dr. Token', version: '0.0.1' },
  },
});
send({ method: 'initialized', params: {} });
await sleep(2500);
send({ method: 'hooks/list', id: 1, params: { cwds: [PROJECT_DIR] } });
await sleep(3000);

const handshake = received.find((message) => message.id === 0);
const hooksReply = received.find((message) => message.id === 1);

const report = {
  codexHome: CODEX_HOME,
  projectDir: PROJECT_DIR,
  handshake: handshake?.result ?? handshake?.error ?? null,
  hooksListError: hooksReply?.error ?? null,
  discoveredHookCount: Array.isArray(hooksReply?.result?.data?.[0]?.hooks)
    ? hooksReply.result.data[0].hooks.length
    : 0,
  hooks: (hooksReply?.result?.data?.[0]?.hooks ?? []).map((hook) => ({
    eventName: hook.eventName,
    handlerType: hook.handlerType,
    command: hook.command,
    enabled: hook.enabled,
    trustStatus: hook.trustStatus,
    isManaged: hook.isManaged,
    source: hook.source,
    matcher: hook.matcher,
  })),
  otherMessages: received
    .filter((message) => message.id === undefined && !message.raw && !message.stderr)
    .map((message) => message.method),
  stderr: received.filter((message) => message.stderr).map((message) => message.stderr),
};

console.log(JSON.stringify(report, null, 2));
child.kill();
setTimeout(() => process.exit(0), 400);
