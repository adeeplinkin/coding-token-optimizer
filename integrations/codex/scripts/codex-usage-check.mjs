#!/usr/bin/env node
/**
 * Read the account's Codex rate-limit status **without making a model call**.
 *
 * This is a *validation tool*, not part of the product install. Stage 1N needs to
 * know whether the account's usage allowance has recovered before asking the user
 * to authorize another turn — asking by *submitting a turn that gets rejected*
 * would be exactly the wrong way to find out.
 *
 * It performs the documented `initialize` / `initialized` handshake against a
 * local app-server using the caller's `CODEX_HOME` and then calls the account
 * rate-limit method. It never calls `turn/start`, so nothing is spent and no
 * session is created.
 *
 * Privacy: account identifiers are never printed. Any field whose name looks like
 * an account, installation, user, email or token identifier is replaced with a
 * digest-free marker before output, so the report can be pasted into evidence
 * without leaking account data.
 *
 * Usage:
 *   CODEX_BIN=<path to codex.exe> CODEX_HOME=<home> \
 *     node integrations/codex/scripts/codex-usage-check.mjs
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const CODEX_BIN = process.env.CODEX_BIN;
const CODEX_HOME = process.env.CODEX_HOME;

if (!CODEX_BIN || !CODEX_HOME) {
  console.error('CODEX_BIN and CODEX_HOME must both be set.');
  process.exit(2);
}

/** Field names whose values are account or credential identifiers. */
const SENSITIVE_KEY = /(account|user|email|installation|token|auth|session|id)$/i;

/** Replace identifier-looking fields with a marker, recursively. */
function redact(value, key) {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, undefined));
  }
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = SENSITIVE_KEY.test(childKey) && typeof childValue !== 'object'
        ? '<redacted>'
        : redact(childValue, childKey);
    }
    return output;
  }
  return value;
}

const received = [];
const child = spawn(CODEX_BIN, ['app-server', '--listen', 'stdio://'], {
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
child.stderr.on('data', (chunk) => received.push({ stderr: String(chunk).slice(0, 200) }));
child.on('exit', (code) => received.push({ exit: code }));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

send({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: { name: 'dr_token_usage_check', title: 'Dr. Token', version: '0.0.1' },
  },
});
send({ method: 'initialized', params: {} });
await sleep(2500);
send({ method: 'account/rateLimits/read', id: 1, params: {} });
await sleep(2500);

const handshake = received.find((message) => message.id === 0);
const limits = received.find((message) => message.id === 1);

console.log(
  JSON.stringify(
    {
      handshake: handshake?.result ?? handshake?.error ?? null,
      rateLimitsError: limits?.error ?? null,
      rateLimits: limits?.result === undefined ? null : redact(limits.result, undefined),
      otherMessages: received
        .filter((message) => message.id === undefined && !message.raw && !message.stderr)
        .map((message) => message.method),
    },
    null,
    2,
  ),
);

child.kill();
setTimeout(() => process.exit(0), 400);
