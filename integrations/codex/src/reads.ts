import { normalizePath } from './identity.js';
import type { ReadIdentification, ReadIdentificationReason } from './types.js';

/**
 * Read classification for Codex tool calls.
 *
 * Codex has no built-in `read` tool, so a "read" here means either
 *
 * - an **MCP or other function tool whose name is a read tool** (for example
 *   `mcp__filesystem__read_file`) with a path-like argument, or
 * - a **shell command that is unambiguously a single literal file read**
 *   (`cat notes.md`, `head report.txt`, `Get-Content log.txt`).
 *
 * Everything else refuses to be identified. That is deliberate: the alternative
 * is guessing a file identity from a command line, and a wrong identity would
 * produce a *false* repeated-read observation, which is worse than a missing one.
 * The refusals are counted and reported, never silently dropped.
 *
 * **Contract status:** the tool vocabulary above is source/contract-confirmed and
 * partially runtime-observed (Stage 1K observed `Bash` and MCP tool naming on the
 * hook path). Which read tools a given Codex session actually calls, and whether
 * any of them reports ranges, is **not runtime-verified** until a live turn is run
 * (see `docs/CODEX_OBSERVER.md`, live validation).
 *
 * This module is pure: it computes an identity, never reads a file, never caches
 * content, and never retains the raw path.
 */

/** Offset recorded when the host reports no range. */
export const DEFAULT_READ_OFFSET = 1;

/**
 * Limit recorded when the host reports no range.
 *
 * `0` means "the host did not report a limit" — it is **not** a claim that the
 * read was whole-file. Two requests that both omit a limit therefore share one
 * identity, while a request that names a limit never does.
 */
export const DEFAULT_READ_LIMIT = 0;

/** Tool names (case-insensitive) that Codex documents as shell execution. */
const SHELL_TOOL_NAMES: readonly string[] = ['bash', 'shell', 'exec_command'];

/**
 * Shell commands treated as single-file readers.
 *
 * Only commands whose meaning is "read this one file" qualify. Search tools
 * (`grep`, `rg`, `find`), stream editors (`sed`, `awk`) and anything with a pipe,
 * redirect, substitution, glob or environment expansion are refused, because
 * their output is not one file's content.
 */
const SHELL_READER_COMMANDS: readonly string[] = [
  'cat',
  'type',
  'head',
  'tail',
  'more',
  'less',
  'get-content',
  'gc',
];

/** Argument keys that name a file path, in priority order. */
const PATH_ARGUMENT_KEYS: readonly string[] = ['path', 'filePath', 'file_path', 'filename', 'file'];

/** Range keys this adapter understands. */
const RANGE_ARGUMENT_KEYS: readonly string[] = ['offset', 'limit'];

/**
 * Range-ish keys this adapter does **not** model.
 *
 * A request carrying one of these is refused rather than treated as a whole-file
 * read, because doing so could merge a partial read with a full read under one
 * identity.
 */
const UNSUPPORTED_RANGE_KEYS: readonly string[] = [
  'start_line',
  'startLine',
  'end_line',
  'endLine',
  'start',
  'end',
  'lines',
  'numLines',
  'line_range',
  'lineRange',
  'byteStart',
  'byteLength',
  'maxBytes',
  'max_bytes',
];

/** Shell characters that make a command ambiguous for identity purposes. */
const SHELL_META_CHARACTERS = /[|&;<>$`*?(){}[\]\r\n#!]/;

/** Whether a classified tool call was a read attempt at all. */
export type ReadClassification =
  | { readonly attempt: false }
  | { readonly attempt: true; readonly result: ReadIdentification };

const NOT_A_READ: ReadClassification = { attempt: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unidentified(reason: ReadIdentificationReason): ReadClassification {
  return { attempt: true, result: { identified: false, reason } };
}

/** Lower-cased leaf name of a tool: `mcp__fs__read_file` → `read_file`. */
function toolLeafName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed.toLowerCase().startsWith('mcp__')) {
    return trimmed;
  }
  const parts = trimmed.split('__');
  return parts[parts.length - 1] ?? trimmed;
}

/** Whether a tool name looks like a file-reading tool. */
export function isReadLikeToolName(toolName: string): boolean {
  const leaf = toolLeafName(toolName);
  return /(^|[_.-])(read|read_file|readfile|read_text_file|view|cat|get_file_contents)([_.-]|$)/i.test(
    leaf,
  );
}

/** Whether a tool name is a shell execution tool. */
export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOL_NAMES.includes(toolName.trim().toLowerCase());
}

/**
 * Split a shell command into tokens, or refuse.
 *
 * Quotes are honoured so `cat "my file.txt"` yields one operand. Backslashes are
 * **not** treated as escapes, because Windows paths use them literally. Any shell
 * metacharacter, an unterminated quote, or an empty command refuses the command.
 */
function tokenizeShellCommand(command: string): readonly string[] | undefined {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const character of command) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if (SHELL_META_CHARACTERS.test(character)) {
      return undefined;
    }
    current += character;
    started = true;
  }

  if (quote !== undefined) {
    return undefined;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

function readRangeValue(value: unknown, fallback: number): { value: number; malformed: boolean } {
  if (value === undefined || value === null) {
    return { value: fallback, malformed: false };
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return { value, malformed: false };
  }
  return { value: fallback, malformed: true };
}

/**
 * Classify a shell command as a single-file read, or refuse it.
 *
 * `cat a.txt b.txt`, `cat a.txt | head`, `grep x a.txt` and `cat *.ts` all refuse.
 */
function classifyShellRead(command: unknown, hash: (value: string) => string): ReadClassification {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return unidentified('missing-path');
  }

  const tokens = tokenizeShellCommand(command);
  if (tokens === undefined || tokens.length < 2) {
    return unidentified('ambiguous-shell-read');
  }

  const reader = (tokens[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  if (!SHELL_READER_COMMANDS.includes(reader)) {
    return unidentified('ambiguous-shell-read');
  }

  const operands = tokens.slice(1).filter((token) => !token.startsWith('-'));
  if (operands.length !== 1) {
    return unidentified('ambiguous-shell-read');
  }

  const path = operands[0] ?? '';
  if (path.trim().length === 0 || path.startsWith('~') || path.includes('=')) {
    return unidentified('ambiguous-shell-read');
  }

  return {
    attempt: true,
    result: {
      identified: true,
      targetId: hash(normalizePath(path)),
      offset: DEFAULT_READ_OFFSET,
      limit: DEFAULT_READ_LIMIT,
      key: `${hash(normalizePath(path))}:${DEFAULT_READ_OFFSET}:${DEFAULT_READ_LIMIT}`,
      basis: 'shell-command',
      malformed: false,
    },
  };
}

/** Classify a function or MCP tool call with a path-like argument. */
function classifyToolRead(args: unknown, hash: (value: string) => string): ReadClassification {
  if (!isRecord(args)) {
    return unidentified('unusable-input');
  }

  for (const unsupported of UNSUPPORTED_RANGE_KEYS) {
    if (args[unsupported] !== undefined && args[unsupported] !== null) {
      return unidentified('unusable-input');
    }
  }

  let rawPath: string | undefined;
  for (const key of PATH_ARGUMENT_KEYS) {
    const candidate = args[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      rawPath = candidate;
      break;
    }
  }
  if (rawPath === undefined) {
    return unidentified('missing-path');
  }

  const offset = readRangeValue(args['offset'], DEFAULT_READ_OFFSET);
  const limit = readRangeValue(args['limit'], DEFAULT_READ_LIMIT);
  const targetId = hash(normalizePath(rawPath));

  return {
    attempt: true,
    result: {
      identified: true,
      targetId,
      offset: offset.value,
      limit: limit.value,
      key: `${targetId}:${offset.value}:${limit.value}`,
      basis: 'tool-argument',
      malformed: offset.malformed || limit.malformed,
    },
  };
}

/**
 * Classify one tool call for read observation.
 *
 * Returns `{ attempt: false }` for a call that is not a read attempt at all (a
 * patch, a plan update, a search tool name we do not recognize): those stay in the
 * tool-frequency counts and are deliberately *not* counted as read requests, so a
 * summary never inflates the read numbers with unrelated tools.
 *
 * Never throws: any unusable input degrades to an unidentified attempt.
 */
export function classifyReadAttempt(
  toolName: string,
  toolInput: unknown,
  hash: (value: string) => string,
): ReadClassification {
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    return NOT_A_READ;
  }

  if (isShellToolName(toolName)) {
    const command = isRecord(toolInput) ? toolInput['command'] : undefined;
    return classifyShellRead(command, hash);
  }

  if (isReadLikeToolName(toolName)) {
    return classifyToolRead(toolInput, hash);
  }

  return NOT_A_READ;
}

/** Documented keys the adapter reads from a tool input, for tests and documentation. */
export const SUPPORTED_TOOL_INPUT_KEYS: readonly string[] = [
  'command',
  ...RANGE_ARGUMENT_KEYS,
  ...PATH_ARGUMENT_KEYS,
];
