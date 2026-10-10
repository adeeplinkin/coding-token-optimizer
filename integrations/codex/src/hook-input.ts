import {
  IMPLEMENTED_HOOK_EVENTS,
  type CodexHookEventName,
  type CompactionTrigger,
  type HookEnvelope,
  type ParsedHookEvent,
  type SessionStartSource,
} from './types.js';

/**
 * Hook payload parsing.
 *
 * The documented contract is one flat JSON object on stdin whose
 * `hook_event_name` names the event (Stage 1K quoted the official example
 * payload). This module is defensive about everything else, because the host is
 * an `alpha` runtime: an unrecognized shape must degrade to "nothing recorded",
 * never to a guess.
 *
 * **What is deliberately not kept:** prompts, tool arguments and tool responses.
 * The parser reports only whether they were present (and, for a response, its JSON
 * kind). Tool arguments are handed on in memory so a one-way read identity can be
 * derived, then dropped; nothing here is written anywhere.
 */

/** Keys that may wrap the documented payload in a future host shape. */
const ENVELOPE_KEYS: readonly string[] = ['data', 'input', 'payload', 'event', 'hook'];

/** Longest identifier this adapter will retain (session id, tool name, call id). */
const MAX_IDENTIFIER_LENGTH = 128;

/** Longest directory string this adapter will retain in memory. */
const MAX_DIRECTORY_LENGTH = 4096;

/** Characters allowed in a retained session id. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Characters allowed in a retained tool name, call id or agent type. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/-]+$/;

const SESSION_START_SOURCES: readonly SessionStartSource[] = [
  'startup',
  'resume',
  'clear',
  'compact',
];

const COMPACTION_TRIGGERS: readonly CompactionTrigger[] = ['manual', 'auto'];

/** Canonical event names, keyed by their case-insensitive form. */
const EVENT_NAME_BY_LOWER_CASE: ReadonlyMap<string, CodexHookEventName> = new Map(
  IMPLEMENTED_HOOK_EVENTS.map((name) => [name.toLowerCase(), name]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keep only an identifier-shaped string.
 *
 * Returns `undefined` for anything that is not a plausible identifier, so a host
 * that puts arbitrary text (or a path, or a multi-line blob) in a field cannot
 * make it into a record.
 */
function sanitizeIdentifier(
  value: unknown,
  pattern: RegExp = IDENTIFIER_PATTERN,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IDENTIFIER_LENGTH) {
    return undefined;
  }
  return pattern.test(trimmed) ? trimmed : undefined;
}

/** Keep a directory string for in-memory comparison only; never persisted raw. */
function sanitizeDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DIRECTORY_LENGTH) {
    return undefined;
  }
  return /[\r\n\u0000]/.test(trimmed) ? undefined : trimmed;
}

/**
 * Map a host event name to a canonical one.
 *
 * Both the documented PascalCase spelling and a camelCase spelling are accepted,
 * so a host that reports `postToolUse` is understood. Anything else is `unknown`
 * and the raw text is discarded rather than persisted.
 */
export function normalizeEventName(value: unknown): CodexHookEventName | 'unknown' {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  return EVENT_NAME_BY_LOWER_CASE.get(value.trim().toLowerCase()) ?? 'unknown';
}

function readSessionStartSource(value: unknown): SessionStartSource | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const found = SESSION_START_SOURCES.find((candidate) => candidate === normalized);
  return found ?? 'unknown';
}

function readCompactionTrigger(value: unknown): CompactionTrigger | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const found = COMPACTION_TRIGGERS.find((candidate) => candidate === normalized);
  return found ?? 'unknown';
}

function responseKind(value: unknown): ParsedHookEvent['toolResponseKind'] {
  if (typeof value === 'string') {
    return 'string';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  if (value === undefined) {
    return undefined;
  }
  return 'other';
}

/**
 * Whether an object carries a plausible event name.
 *
 * This is deliberately separate from {@link normalizeEventName}: an event this
 * adapter does not implement is still a **usable** payload, counted as ignored.
 * Only a missing (or unusable) name makes a payload unusable.
 */
function carriesEventName(candidate: Record<string, unknown>): boolean {
  const value = candidate['hook_event_name'];
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\r\n\u0000]/.test(value)
  );
}

/** Find the object that actually carries the payload. */
function locatePayload(raw: unknown): { carrier: Record<string, unknown>; envelope: HookEnvelope } | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (carriesEventName(raw)) {
    return { carrier: raw, envelope: 'flat' };
  }
  for (const key of ENVELOPE_KEYS) {
    const candidate = raw[key];
    if (isRecord(candidate) && carriesEventName(candidate)) {
      return { carrier: candidate, envelope: 'wrapped' };
    }
  }
  return { carrier: raw, envelope: 'flat' };
}

/** An event that could not be used at all. */
function unusable(reason: 'not-an-object' | 'missing-event-name'): ParsedHookEvent {
  return {
    usable: false,
    unusableReason: reason,
    envelope: 'unusable',
    eventName: 'unknown',
    recognized: false,
    sessionId: undefined,
    sessionReported: false,
    cwd: undefined,
    turnId: undefined,
    model: undefined,
    permissionMode: undefined,
    toolName: undefined,
    toolUseId: undefined,
    toolInput: undefined,
    toolResponsePresent: false,
    toolResponseKind: undefined,
    promptPresent: false,
    sessionStartSource: undefined,
    compactionTrigger: undefined,
    agentType: undefined,
    stopHookActive: undefined,
  };
}

/**
 * Parse one hook payload.
 *
 * Never throws: any input, including `undefined`, a string, an array or a
 * half-written JSON value, produces a `usable: false` result with a static reason.
 */
export function parseHookPayload(raw: unknown): ParsedHookEvent {
  const located = locatePayload(raw);
  if (located === undefined) {
    return unusable('not-an-object');
  }

  const eventName = normalizeEventName(located.carrier['hook_event_name']);
  if (!carriesEventName(located.carrier)) {
    return { ...unusable('missing-event-name'), envelope: located.envelope };
  }

  const sessionId = sanitizeIdentifier(located.carrier['session_id'], SESSION_ID_PATTERN);
  const toolInput = located.carrier['tool_input'];
  const responsePresent = Object.hasOwn(located.carrier, 'tool_response');
  const promptValue = located.carrier['prompt'];
  const stopHookActive = located.carrier['stop_hook_active'];

  return {
    usable: true,
    unusableReason: undefined,
    envelope: located.envelope,
    eventName,
    recognized: eventName !== 'unknown',
    sessionId,
    sessionReported: sessionId !== undefined,
    cwd: sanitizeDirectory(located.carrier['cwd']),
    turnId: sanitizeIdentifier(located.carrier['turn_id']),
    model: sanitizeIdentifier(located.carrier['model']),
    permissionMode: sanitizeIdentifier(located.carrier['permission_mode']),
    toolName: sanitizeIdentifier(located.carrier['tool_name']),
    toolUseId: sanitizeIdentifier(located.carrier['tool_use_id']),
    toolInput,
    toolResponsePresent: responsePresent,
    toolResponseKind: responsePresent
      ? responseKind(located.carrier['tool_response'])
      : undefined,
    promptPresent: typeof promptValue === 'string',
    sessionStartSource: readSessionStartSource(located.carrier['source']),
    compactionTrigger: readCompactionTrigger(located.carrier['trigger']),
    agentType: sanitizeIdentifier(located.carrier['agent_type']),
    stopHookActive: typeof stopHookActive === 'boolean' ? stopHookActive : undefined,
  };
}
