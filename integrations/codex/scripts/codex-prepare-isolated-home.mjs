#!/usr/bin/env node
/**
 * Prepare a disposable, isolated Codex home for the Stage 1M live validation.
 *
 * This is a *validation tool*, not part of the product install. It writes nothing
 * outside the directories the caller names, and it never touches the user's own
 * `~/.codex`.
 *
 * It generates `<home>/hooks.json` containing, for each of the 12 documented
 * lifecycle events, **two** `command` handlers:
 *
 *   1. the real Dr. Token observer entry point, and
 *   2. the shape-only evidence tap, so the live payload shapes can be recorded
 *      without persisting any content.
 *
 * Both handler commands are plain `node <script>` invocations with a quoted
 * argument — no shell tricks, no environment indirection, no wrapper that could
 * change what Codex sees. Environment switches for the observer
 * (`DR_TOKEN_CODEX_STATE_DIR`, `DR_TOKEN_OBSERVER_SUMMARY_FILE`, …) are *not*
 * configured here: Codex spawns hook processes with its own environment, so the
 * caller sets them on the process that launches the turn.
 *
 * Usage:
 *   node codex-prepare-isolated-home.mjs \
 *     --package <absolute path of integrations/codex> \
 *     --home <isolated CODEX_HOME> \
 *     --evidence <evidence directory for the tap> \
 *     [--command-node <node executable>]
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const IMPLEMENTED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
  'SessionEnd',
];

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token === 'string' && token.startsWith('--')) {
      const next = argv[index + 1];
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  return values;
}

const args = parseArguments(process.argv.slice(2));
const packageRoot = args.get('package');
const home = args.get('home');
const evidence = args.get('evidence');
const nodeCommand = args.get('command-node') ?? 'node';

if (typeof packageRoot !== 'string' || typeof home !== 'string' || typeof evidence !== 'string') {
  console.error('--package, --home and --evidence are all required.');
  process.exit(2);
}

const entryPoint = path.join(packageRoot, 'dist', 'entry.js');
const tapScript = path.join(packageRoot, 'scripts', 'codex-evidence-tap.mjs');

await access(entryPoint);
await access(tapScript);
await mkdir(home, { recursive: true });
await mkdir(evidence, { recursive: true });

/** Quote a path for a hook command line (only if it needs it). */
function quote(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

const observerCommand = `${quote(nodeCommand)} ${quote(entryPoint)}`;
const tapCommand = `${quote(nodeCommand)} ${quote(tapScript)} ${quote(evidence)}`;

/**
 * Timeout per event.
 *
 * Codex clamps the `SessionEnd` and `Interrupt` timeouts to 3 seconds and emits a
 * diagnostic for every handler that asks for more (runtime-verified in Stage 1M),
 * so this disposable configuration asks for exactly 3 there and 10 elsewhere.
 */
function timeoutForEvent(event) {
  return event === 'SessionEnd' || event === 'Interrupt' ? 3 : 10;
}

const hooks = {};
for (const event of IMPLEMENTED_HOOK_EVENTS) {
  const timeout = timeoutForEvent(event);
  hooks[event] = [
    {
      hooks: [
        {
          type: 'command',
          command: observerCommand,
          timeout,
          statusMessage: `Dr. Token observing ${event}`,
        },
        {
          type: 'command',
          command: tapCommand,
          timeout,
        },
      ],
    },
  ];
}

const configuration = {
  description:
    'Disposable Dr. Token Stage 1M validation configuration. Observation-only: no handler returns a decision, permission decision, updated input, additional context or continuation.',
  hooks,
};

const configurationPath = path.join(home, 'hooks.json');
await writeFile(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8');

// Round-trip the file so a quoting mistake is caught here rather than by Codex.
const reloaded = JSON.parse(await readFile(configurationPath, 'utf8'));
const handlerCount = Object.values(reloaded.hooks).reduce(
  (total, groups) => total + groups.reduce((inner, group) => inner + group.hooks.length, 0),
  0,
);

console.log(
  JSON.stringify(
    {
      configurationPath,
      entryPoint,
      tapScript,
      evidence,
      events: Object.keys(reloaded.hooks).length,
      handlers: handlerCount,
      observerCommand,
      tapCommand,
    },
    null,
    2,
  ),
);
