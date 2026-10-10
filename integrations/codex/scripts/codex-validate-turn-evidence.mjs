#!/usr/bin/env node
/**
 * Validate the evidence produced by one live Codex turn.
 *
 * This is a *validation tool*, not part of the product install. Stage 1N needs
 * assertions, not impressions: after a turn runs, this script decides whether
 * `PreToolUse`/`PostToolUse` were actually delivered, whether the tool identities
 * correlate, whether a repeated read was identified from real payloads, whether
 * the session's state was released, and whether anything leaked.
 *
 * It reads only files inside the disposable environment the caller names
 * (evidence + state + summary + project), prints a bounded, content-free JSON
 * report plus a human summary, and exits:
 *
 *   0 — every required assertion passed
 *   2 — at least one required assertion FAILED (a real defect)
 *   3 — tool hooks were BLOCKED/not exercised: inconclusive, not a pass
 *
 * "Inconclusive" is a first-class outcome. If Codex does not call a tool, or
 * calls one tool once, this script says so instead of inventing a repeat read.
 *
 * Usage:
 *   node codex-validate-turn-evidence.mjs \
 *     --evidence <dir>   # shapes.jsonl, live-events*.jsonl, turn-status*.txt
 *     --state <dir>      # DR_TOKEN_CODEX_STATE_DIR used by the turn
 *     --summary <file>   # DR_TOKEN_OBSERVER_SUMMARY_FILE used by the turn
 *     --project <dir>    # the synthetic project the turn edited
 *     [--events <file>]  # scope to ONE run's host event stream (recommended)
 *
 * Privacy scope matters: only files **Dr. Token wrote** are swept for content —
 * the summary, the tap's shape records, and the observer's state directory. Host
 * event streams are Codex's own output, and any hand-made fixture in the evidence
 * directory is test *input*, not adapter output.
 */

import { readFile, readdir } from 'node:fs/promises';
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
const evidenceDir = args.get('evidence');
const eventsArg = args.get('events');
const stateDir = args.get('state');
const summaryFile = args.get('summary');
const projectDir = args.get('project');

if ([evidenceDir, stateDir, summaryFile, projectDir].some((value) => typeof value !== 'string')) {
  console.error('--evidence, --state, --summary and --project are all required.');
  process.exit(2);
}

const checks = [];
function check(name, status, detail) {
  checks.push({ name, status, detail });
}

async function tryRead(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function listFiles(directory) {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  } catch {
    return [];
  }
}

/** Files that carry evidence, newest-compatible naming. */
const evidenceFiles = await listFiles(evidenceDir);
const shapesFile = evidenceFiles.find((file) => file.endsWith('shapes.jsonl'));
const hostEventFiles =
  typeof eventsArg === 'string'
    ? [eventsArg]
    : evidenceFiles.filter((file) => /live-events.*\.jsonl$/.test(file));
const statusFiles = evidenceFiles.filter((file) => /turn-status.*\.txt$/.test(file));

const tapText = shapesFile === undefined ? undefined : await tryRead(shapesFile);
const tapRecords = [];
for (const line of (tapText ?? '').split('\n')) {
  if (line.trim().length === 0) {
    continue;
  }
  try {
    tapRecords.push(JSON.parse(line));
  } catch {
    // A torn trailing line from a killed hook process is not evidence.
  }
}

/** Event name + the fields the adapter actually consumes, from the tap. */
const delivered = tapRecords.map((record) => {
  const keys = record.payload?.keys ?? {};
  const value = (field) => keys[field]?.value;
  return {
    event: value('hook_event_name'),
    sessionId: value('session_id'),
    turnId: value('turn_id'),
    toolName: value('tool_name'),
    toolUseId: value('tool_use_id'),
    // Structure only: which argument keys came with the call, and their kinds.
    toolInputKeys: keys.tool_input?.keys === undefined ? null : Object.keys(keys.tool_input.keys),
    toolInputType: keys.tool_input?.type ?? null,
    toolResponseKind: keys.tool_response?.type ?? null,
    permissionMode: value('permission_mode'),
    stdinBytes: record.stdinBytes,
  };
});

const preTool = delivered.filter((entry) => entry.event === 'PreToolUse');
const postTool = delivered.filter((entry) => entry.event === 'PostToolUse');

/** Host-side ground truth: how many items Codex reported, and of what types. */
const hostItems = [];
for (const file of hostEventFiles) {
  const text = (await tryRead(file)) ?? '';
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      hostItems.push(event);
    } catch {
      // A partial line from a killed process is not evidence.
    }
  }
}
const hostTypes = hostItems.map((event) => event.type ?? event.msg?.type ?? 'unknown');
const hostFailures = hostItems.filter((event) => event.type === 'error' || event.type === 'turn.failed');

/** Codex complaining about our *configuration* (e.g. a clamped timeout). */
const configDiagnostics = hostItems.filter((event) => /clamping|invalid hook|hook .*disabled|untrusted/i.test(JSON.stringify(event)));

/** Evidence that a hook *returned* something Codex acted on. */
const hookOutputEvidence = hostItems.filter((event) =>
  /additionalContext|hook_output|hookOutput|updatedInput|permissionDecision|hook returned/i.test(JSON.stringify(event)),
);

const summaryText = await tryRead(summaryFile);
const summaries = summaryText === undefined ? [] : summaryText.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
const summary = summaries[summaries.length - 1];

const leftovers = (await listFiles(stateDir)).filter((file) => /\.(jsonl|json|lock)$/.test(file));

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

check(
  'turn exit status recorded',
  statusFiles.length > 0 ? 'PASS' : 'INCONCLUSIVE',
  statusFiles.length === 0 ? 'no turn-status file found' : (await tryRead(statusFiles[statusFiles.length - 1]))?.trim(),
);

check(
  'session lifecycle delivered',
  delivered.some((entry) => entry.event === 'SessionStart') ? 'PASS' : 'FAIL',
  `events observed by the tap: ${delivered.map((entry) => entry.event).join(', ') || 'none'}`,
);

const toolHooksDelivered = preTool.length > 0 && postTool.length > 0;
check(
  'PreToolUse and PostToolUse delivered',
  toolHooksDelivered ? 'PASS' : 'INCONCLUSIVE',
  `PreToolUse=${preTool.length} PostToolUse=${postTool.length}`,
);

check(
  'tool identities present and correlated',
  toolHooksDelivered
    ? preTool.every((entry) => typeof entry.toolName === 'string' && entry.toolName.length > 0) &&
      preTool.some((entry) => postTool.some((end) => end.toolUseId !== undefined && end.toolUseId === entry.toolUseId))
      ? 'PASS'
      : 'FAIL'
    : 'INCONCLUSIVE',
  `start tools: ${JSON.stringify(preTool.map((entry) => entry.toolName))} · start ids: ${JSON.stringify(preTool.map((entry) => entry.toolUseId))} · completion ids: ${JSON.stringify(postTool.map((entry) => entry.toolUseId))}`,
);

if (summary !== undefined) {
  check(
    'summary counts match delivered tool events',
    summary.counts.toolStartsObserved === preTool.length && summary.counts.toolCompletionsObserved === postTool.length
      ? 'PASS'
      : 'FAIL',
    `summary starts=${summary.counts.toolStartsObserved} completions=${summary.counts.toolCompletionsObserved} · tap starts=${preTool.length} completions=${postTool.length}`,
  );
  check(
    'observed-event counter equals folded journal records',
    summary.counts.hookEventsObserved === summary.journal.records ? 'PASS' : 'FAIL',
    `hookEventsObserved=${summary.counts.hookEventsObserved} journal.records=${summary.journal.records}`,
  );
  check(
    'session attribution reported by the host',
    summary.sessionIdentity === 'reported' && typeof summary.sessionId === 'string' && summary.sessionId !== 'unknown'
      ? 'PASS'
      : 'FAIL',
    `sessionId=${summary.sessionId} identity=${summary.sessionIdentity}`,
  );

  const reads = summary.reads;
  const readRequests = reads.identifiedRequests + reads.unidentifiedRequests;
  // Exact invariant of the fold: for every identified target with count c it adds
  // c to identifiedRequests and c-1 to repeatedRequests, so the difference must be
  // the number of distinct targets. A mismatch would mean a fabricated repeat.
  const repeatedClaimOk =
    reads.repeatedRequests === reads.identifiedRequests - reads.distinctTargets &&
    reads.repeatedTargets <= reads.distinctTargets &&
    readRequests === reads.identifiedRequests + reads.unidentifiedRequests;
  check(
    'repeated-read count is arithmetically consistent',
    repeatedClaimOk ? 'PASS' : 'FAIL',
    `requests=${readRequests} identified=${reads.identifiedRequests} distinct=${reads.distinctTargets} repeatedTargets=${reads.repeatedTargets} repeatedRequests=${reads.repeatedRequests}`,
  );
  check(
    'a repeated read was actually observed',
    reads.repeatedRequests >= 1 ? 'PASS' : 'INCONCLUSIVE',
    reads.repeatedRequests >= 1
      ? `${reads.repeatedRequests} repeated request(s) across ${reads.distinctTargets} distinct target(s)`
      : 'no repeated read was identified; if Codex read a file only once this is inconclusive, not a pass',
  );
  check(
    'state released after SessionEnd',
    leftovers.length === 0 ? 'PASS' : 'FAIL',
    leftovers.length === 0 ? 'no session state left behind' : `left behind: ${leftovers.map((file) => path.basename(file)).join(', ')}`,
  );
} else {
  check('summary written at SessionEnd', 'FAIL', 'no summary file — SessionEnd was not observed or the sink was not configured');
}

/* -------------------------------------------------------------------------- */
/* Privacy and neutrality                                                      */
/* -------------------------------------------------------------------------- */

/** Sentinels that must never appear in anything Dr. Token writes. */
const sentinels = ['SECRET-RESPONSE-BODY', 'sk-live-DEADBEEF', 'notes.md content marker'];
// Only files the adapter itself writes: the summary, the tap's shape records and
// the observer's state. Hand-made fixtures and Codex's own streams are excluded.
const written = [
  ...(typeof summaryFile === 'string' ? [summaryFile] : []),
  ...(shapesFile === undefined ? [] : [shapesFile]),
  ...leftovers,
];
let leak = undefined;
for (const file of written) {
  if (file.includes('live-events')) {
    // Host-side event streams are Codex's own output, not Dr. Token's.
    continue;
  }
  const text = (await tryRead(file)) ?? '';
  for (const sentinel of sentinels) {
    if (text.includes(sentinel)) {
      leak = `${path.basename(file)} contains ${sentinel}`;
    }
  }
  if (text.includes(projectDir)) {
    leak = `${path.basename(file)} contains the absolute project path`;
  }
}
check('no content or absolute path in Dr. Token output', leak === undefined ? 'PASS' : 'FAIL', leak ?? 'swept every file the adapter wrote');

check(
  'no hook configuration diagnostics in this run',
  configDiagnostics.length === 0 ? 'PASS' : 'FAIL',
  configDiagnostics.length === 0
    ? 'Codex raised no diagnostic about the hook configuration'
    : `Codex reported: ${configDiagnostics.map((event) => JSON.stringify(event).slice(0, 180)).join(' | ')}`,
);

check(
  'output neutrality (no hook output reached Codex)',
  // Direct stdout capture would require changing the trusted command, so this is
  // asserted from the host side: nothing in Codex's own stream shows a hook
  // injecting context, rewriting arguments or returning a decision — on top of the
  // construction proof (the entry point writes no stdout on any path, asserted by
  // tests that spawn it) .
  hookOutputEvidence.length === 0 ? 'PASS' : 'FAIL',
  hookOutputEvidence.length === 0
    ? 'no injected context, no rewritten arguments and no hook decision appeared in Codex\'s stream'
    : `possible hook output: ${hookOutputEvidence.map((event) => JSON.stringify(event).slice(0, 180)).join(' | ')}`,
);

check(
  'the turn actually completed (not a quota/refused turn)',
  hostFailures.length === 0 ? 'PASS' : 'INCONCLUSIVE',
  hostFailures.length === 0
    ? 'Codex reported no turn failure'
    : `turn failed: ${hostFailures.map((event) => event.message ?? event.error?.message ?? 'error').join(' | ').slice(0, 200)}`,
);

/* -------------------------------------------------------------------------- */

const failed = checks.filter((entry) => entry.status === 'FAIL');
const blocked = checks.filter((entry) => entry.status === 'INCONCLUSIVE');

console.log(
  JSON.stringify(
    {
      evidence: {
        tapEvents: delivered.map((entry) => entry.event),
        toolCalls: preTool.map((entry) => ({
          tool: entry.toolName,
          id: entry.toolUseId,
          toolInputType: entry.toolInputType,
          toolInputKeys: entry.toolInputKeys,
          responseKind: postTool.find((end) => end.toolUseId === entry.toolUseId)?.toolResponseKind ?? null,
        })),
        hostEventTypes: hostTypes,
        hostFailureMessages: hostFailures.map((event) => event.message ?? event.error?.message ?? 'error'),
        permissionModes: [...new Set(delivered.map((entry) => entry.permissionMode))],
        summary: summary === undefined ? null : {
          sessionId: summary.sessionId,
          sessionIdentity: summary.sessionIdentity,
          counts: summary.counts,
          reads: summary.reads,
          toolFrequency: summary.toolFrequency,
          journal: summary.journal,
          project: summary.project,
        },
      },
      checks,
      verdict: failed.length > 0 ? 'FAIL' : blocked.length > 0 ? 'BLOCKED/INCONCLUSIVE' : 'PASS',
    },
    null,
    2,
  ),
);

for (const entry of checks) {
  console.log(`${entry.status.padEnd(13)} ${entry.name} — ${entry.detail}`);
}
console.log(failed.length > 0 ? '\nVERDICT: FAIL' : blocked.length > 0 ? '\nVERDICT: BLOCKED/INCONCLUSIVE' : '\nVERDICT: PASS');

process.exit(failed.length > 0 ? 2 : blocked.length > 0 ? 3 : 0);
