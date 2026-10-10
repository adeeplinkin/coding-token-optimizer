#!/usr/bin/env node
/**
 * Replay one documented Codex session through the **real** hook entry point.
 *
 * This is a *validation tool*, not part of the product install. It exists so the
 * observer's end-to-end behaviour can be reproduced and audited without a model
 * call: it spawns `dist/entry.js` once per event, exactly as Codex does (payload
 * on stdin, one process per event, observer switches in the environment), and
 * then prints the resulting summary.
 *
 * It never writes to a Codex home and never writes observation state outside the
 * directories the caller names. Payloads are generated in Node rather than
 * hand-written so Windows path escaping in `cwd` cannot be corrupted by a shell.
 *
 * Usage:
 *   node codex-simulate-hook-session.mjs \
 *     --package <absolute path of integrations/codex> \
 *     --state <isolated state directory> \
 *     --summary <isolated summary jsonl file> \
 *     --project <synthetic project directory>
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token === 'string' && token.startsWith('--')) {
      values.set(token.slice(2), argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

const args = parseArguments(process.argv.slice(2));
const packageRoot = args.get('package');
const stateDir = args.get('state');
const summaryFile = args.get('summary');
const projectDir = args.get('project');
const nodeCommand = args.get('node') ?? process.execPath;

if ([packageRoot, stateDir, summaryFile, projectDir].some((value) => typeof value !== 'string')) {
  console.error('--package, --state, --summary and --project are all required.');
  process.exit(2);
}

const entryPoint = path.join(packageRoot, 'dist', 'entry.js');
const sessionId = 'thr_simulated';

/** One documented event per step, mirroring a read-twice-and-edit turn. */
const steps = [
  { hook_event_name: 'SessionStart', session_id: sessionId, cwd: projectDir, source: 'startup' },
  {
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    cwd: projectDir,
    prompt: 'read notes.md twice, then add a multiply() helper to src/math.ts',
  },
  {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: 'Bash',
    tool_use_id: 'call_read_1',
    tool_input: { command: 'cat notes.md' },
  },
  {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: 'Bash',
    tool_use_id: 'call_read_1',
    tool_input: { command: 'cat notes.md' },
    tool_response: { output: '<file contents are never recorded>' },
  },
  {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: 'Bash',
    tool_use_id: 'call_read_2',
    tool_input: { command: 'cat notes.md' },
  },
  {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: 'Bash',
    tool_use_id: 'call_read_2',
    tool_input: { command: 'cat notes.md' },
    tool_response: { output: '<file contents are never recorded>' },
  },
  {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: 'apply_patch',
    tool_use_id: 'call_edit',
    tool_input: { patch: '<patch contents are never recorded>' },
  },
  {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: 'apply_patch',
    tool_use_id: 'call_edit',
    tool_input: { patch: '<patch contents are never recorded>' },
    tool_response: 'Done!',
  },
  { hook_event_name: 'Stop', session_id: sessionId, cwd: projectDir, stop_hook_active: false },
  // A payload the adapter does not implement: counted as ignored, never guessed.
  { hook_event_name: 'SomeFutureEvent', session_id: sessionId, cwd: projectDir },
  { hook_event_name: 'SessionEnd', session_id: sessionId, cwd: projectDir, reason: 'other' },
];

function runOnce(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeCommand, [entryPoint], {
      env: {
        ...process.env,
        DR_TOKEN_CODEX_STATE_DIR: stateDir,
        DR_TOKEN_OBSERVER_SUMMARY_FILE: summaryFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('hook entry did not exit in time'));
    }, 20_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) });
    });
    child.stdin.end(JSON.stringify(payload), 'utf8');
  });
}

const deliveries = [];
for (const step of steps) {
  const run = await runOnce(step);
  deliveries.push({ event: step.hook_event_name, ...run });
}

const summaryText = await readFile(summaryFile, 'utf8');
const summaries = summaryText
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

console.log(
  JSON.stringify(
    {
      deliveries,
      allExitedZero: deliveries.every((entry) => entry.status === 0),
      allStdoutEmpty: deliveries.every((entry) => entry.stdoutBytes === 0),
      summaries,
    },
    null,
    2,
  ),
);
