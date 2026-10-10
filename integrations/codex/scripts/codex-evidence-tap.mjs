#!/usr/bin/env node
/**
 * Disposable **evidence tap** for live Codex hook validation.
 *
 * This is a *validation tool*, not part of the Dr. Token product install. It is
 * registered as an additional `command` hook handler, next to the real observer,
 * in a throwaway `CODEX_HOME` so that Stage 1M can inspect the *actual* payload
 * shapes Codex sends to a hook (the question "does a real file read arrive as
 * `tool_input.command`, as `tool_input.path`, or as something else?" cannot be
 * answered from documentation alone).
 *
 * It is deliberately built to the same privacy standard as the adapter itself:
 *
 * - **No content is ever written.** Prompt text, tool arguments' free text and
 *   tool responses are recorded as *type and length only*; a known content field
 *   is redacted by name, never described further.
 * - Path-like fields (`cwd`, `transcript_path`) are recorded as a one-way
 *   SHA-256[0:16] digest plus a length, never as the path.
 * - Short identifier-shaped strings (event names, tool names, tool ids, offsets)
 *   are recorded verbatim, because that is exactly what the observer already
 *   persists and it is what the shape question needs.
 * - Object/array structure is recorded as keys and JSON types, bounded in depth
 *   and in key count, so a hostile or huge payload cannot produce a large file.
 * - **Nothing is written to stdout** and the process always exits 0, so using it
 *   cannot influence Codex. Evidence goes to one JSON Lines file in a directory
 *   the caller names — and if no directory is given, nothing is written at all
 *   (a mistake therefore cannot litter the repository).
 *
 * Usage (as a hook command):
 *   node codex-evidence-tap.mjs "<evidence directory>"
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Largest payload the tap will read; anything larger is recorded as truncated. */
const MAX_STDIN_BYTES = 1024 * 1024;

/** Deepest object/array nesting described. */
const MAX_DEPTH = 4;

/** Most keys described per object. */
const MAX_KEYS = 40;

/** Longest instance of a value recorded verbatim, and its allowed alphabet. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/\\-]{1,128}$/;

/** Fields whose *content* is never described, only its kind and size. */
const CONTENT_FIELDS = new Set(['prompt', 'tool_response', 'last_assistant_message', 'message']);

/** Fields holding a filesystem location, recorded as a digest only. */
const PATH_FIELDS = new Set(['cwd', 'transcript_path', 'file_path', 'filePath', 'path']);

/** Keys that may wrap the documented payload in a future host shape. */
const ENVELOPE_KEYS = ['data', 'input', 'payload', 'event', 'hook'];

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Describe one value structurally, redacting anything that could carry content. */
function describe(value, key, depth) {
  if (key !== undefined && CONTENT_FIELDS.has(key)) {
    // The kind and size only: never the text itself.
    return { type: typeof value, length: typeof value === 'string' ? value.length : null };
  }
  if (key !== undefined && PATH_FIELDS.has(key) && typeof value === 'string') {
    return { type: 'string', digest: digest(value), length: value.length };
  }
  if (value === null) {
    return { type: 'null' };
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      items: value.length > 0 && depth < MAX_DEPTH ? describe(value[0], undefined, depth + 1) : null,
    };
  }
  switch (typeof value) {
    case 'boolean':
    case 'number':
      return { type: typeof value, value };
    case 'string': {
      if (IDENTIFIER_PATTERN.test(value)) {
        return { type: 'string', value };
      }
      return { type: 'string', length: value.length, lines: value.split('\n').length, verbatim: false };
    }
    case 'object': {
      if (depth >= MAX_DEPTH) {
        return { type: 'object', keys: Object.keys(value).length, truncated: true };
      }
      const keys = {};
      let described = 0;
      for (const [childKey, childValue] of Object.entries(value)) {
        if (described >= MAX_KEYS) {
          break;
        }
        described += 1;
        keys[childKey] = describe(childValue, childKey, depth + 1);
      }
      return { type: 'object', keys, omitted: Math.max(0, Object.keys(value).length - described) };
    }
    default:
      return { type: typeof value };
  }
}

/** Find the object that carries the event name, flat or wrapped. */
function locatePayload(raw) {
  if (!isRecord(raw)) {
    return { carrier: undefined, envelope: 'not-an-object' };
  }
  if (typeof raw['hook_event_name'] === 'string') {
    return { carrier: raw, envelope: 'flat' };
  }
  for (const key of ENVELOPE_KEYS) {
    const candidate = raw[key];
    if (isRecord(candidate) && typeof candidate['hook_event_name'] === 'string') {
      return { carrier: candidate, envelope: `wrapped:${key}` };
    }
  }
  return { carrier: raw, envelope: 'flat-no-event-name' };
}

/** Read all of stdin, bounded, without ever throwing. */
async function readStdin() {
  if (process.stdin.isTTY === true) {
    return { text: '', truncated: false };
  }
  try {
    let total = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buffer.length;
      if (total > MAX_STDIN_BYTES) {
        return { text: '', truncated: true };
      }
      chunks.push(buffer);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
  } catch {
    return { text: '', truncated: false };
  }
}

async function main() {
  const evidenceDirectory = process.argv[2];
  // No directory: write nothing at all and stay silent.
  if (typeof evidenceDirectory !== 'string' || evidenceDirectory.trim().length === 0) {
    return;
  }

  const { text, truncated } = await readStdin();
  let raw;
  let parseError = false;
  try {
    raw = text.trim().length === 0 ? undefined : JSON.parse(text);
  } catch {
    raw = undefined;
    parseError = true;
  }

  const { carrier, envelope } = locatePayload(raw);
  const record = {
    tap: 1,
    at: new Date().toISOString(),
    pid: process.pid,
    stdinBytes: text.length,
    stdinTruncated: truncated,
    parseError,
    envelope,
    // Bounded structural description of everything the host sent.
    payload: carrier === undefined ? { type: typeof raw } : describe(carrier, undefined, 0),
  };

  await mkdir(evidenceDirectory, { recursive: true });
  await appendFile(
    path.join(evidenceDirectory, 'shapes.jsonl'),
    `${JSON.stringify(record)}\n`,
    'utf8',
  );
}

// Never write to stdout, never fail the host: a validation tap must be invisible
// to Codex exactly like the observer it accompanies.
try {
  await main();
} catch {
  // Intentionally swallowed.
}
process.exitCode = 0;
