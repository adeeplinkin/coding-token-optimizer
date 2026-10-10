import { describe, expect, it } from 'vitest';
import { normalizeEventName, parseHookPayload } from '../src/hook-input.js';
import { buildObservationRecord } from '../src/handler.js';
import {
  documentedPostToolUse,
  documentedPreToolUse,
  documentedSessionEnd,
  documentedSessionStart,
  documentedStop,
  documentedUserPromptSubmit,
} from './fixtures/codex-hooks.contract.js';

const hash = (value: string): string => `h(${value})`;

describe('documented payloads', () => {
  it('parses a documented SessionStart payload', () => {
    const parsed = parseHookPayload(documentedSessionStart('startup'));
    expect(parsed.usable).toBe(true);
    expect(parsed.envelope).toBe('flat');
    expect(parsed.eventName).toBe('SessionStart');
    expect(parsed.recognized).toBe(true);
    expect(parsed.sessionId).toBe('thr_123');
    expect(parsed.sessionReported).toBe(true);
    expect(parsed.cwd).toBe('C:\\repo');
    expect(parsed.sessionStartSource).toBe('startup');
    expect(parsed.model).toBe('gpt-6.1-sol');
  });

  it('parses tool input and response presence without keeping content', () => {
    const parsed = parseHookPayload(
      documentedPostToolUse('Bash', { command: 'cat notes.md' }, { output: 'SECRET' }),
    );
    expect(parsed.toolName).toBe('Bash');
    expect(parsed.toolUseId).toBe('call_1');
    expect(parsed.toolResponsePresent).toBe(true);
    expect(parsed.toolResponseKind).toBe('object');
    expect(Object.keys(parsed)).not.toContain('toolResponse');
  });

  it('records only that a prompt was present', () => {
    const parsed = parseHookPayload(documentedUserPromptSubmit('delete the prod database'));
    expect(parsed.promptPresent).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('prod database');
  });

  it('treats a documented SessionEnd as usable', () => {
    const parsed = parseHookPayload(documentedSessionEnd());
    expect(parsed.eventName).toBe('SessionEnd');
    expect(parsed.recognized).toBe(true);
  });

  it('reads stop_hook_active when the host reports it', () => {
    expect(parseHookPayload(documentedStop()).stopHookActive).toBe(false);
  });
});

describe('defensive parsing', () => {
  it('accepts a camelCase event name', () => {
    expect(normalizeEventName('postToolUse')).toBe('PostToolUse');
    expect(normalizeEventName('precompact')).toBe('PreCompact');
    expect(normalizeEventName('SESSIONEND')).toBe('SessionEnd');
  });

  it('tolerates a payload nested under a wrapper key', () => {
    const parsed = parseHookPayload({ data: documentedSessionStart() });
    expect(parsed.envelope).toBe('wrapped');
    expect(parsed.eventName).toBe('SessionStart');
  });

  it('refuses anything that is not an object with an event name', () => {
    for (const value of [undefined, null, 'a string', 42, [], true]) {
      const parsed = parseHookPayload(value);
      expect(parsed.usable).toBe(false);
      expect(parsed.unusableReason).toBe('not-an-object');
      expect(parsed.eventName).toBe('unknown');
      expect(parsed.sessionId).toBeUndefined();
    }
  });

  it('refuses an object without a usable event name', () => {
    const parsed = parseHookPayload({ session_id: 'thr_1', cwd: '/repo' });
    expect(parsed.usable).toBe(false);
    expect(parsed.unusableReason).toBe('missing-event-name');
  });

  it('marks an event it does not observe as unrecognized instead of guessing', () => {
    const parsed = parseHookPayload({ hook_event_name: 'SomeFutureEvent', session_id: 'thr_1' });
    expect(parsed.usable).toBe(true);
    expect(parsed.recognized).toBe(false);
    expect(parsed.eventName).toBe('unknown');
  });

  it('treats a missing session id as unreported', () => {
    const parsed = parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    expect(parsed.sessionReported).toBe(false);
    expect(parsed.sessionId).toBeUndefined();

    const record = buildObservationRecord(parsed, 1_700_000_000_000, hash);
    expect(record.sessionId).toBeUndefined();
  });

  it('refuses identifiers that are not identifier-shaped', () => {
    const hostile = [
      { session_id: '../../etc/passwd' },
      { session_id: 'thr with spaces' },
      { session_id: 'x'.repeat(200) },
      { session_id: 'thr_1\nsecond line' },
      { session_id: 42 as unknown as string },
    ];
    for (const candidate of hostile) {
      const parsed = parseHookPayload({ hook_event_name: 'SessionEnd', ...candidate });
      expect(parsed.sessionId).toBeUndefined();
    }
  });

  it('refuses a multi-line or oversized working directory', () => {
    expect(
      parseHookPayload({ hook_event_name: 'SessionStart', cwd: '/repo\nrm -rf' }).cwd,
    ).toBeUndefined();
    expect(
      parseHookPayload({ hook_event_name: 'SessionStart', cwd: 'x'.repeat(5000) }).cwd,
    ).toBeUndefined();
  });

  it('never throws on arbitrary junk', () => {
    const junk: unknown[] = [
      { hook_event_name: 'PreToolUse', tool_input: { nested: { deep: [1, 2, 3] } } },
      { hook_event_name: Symbol('x') as unknown as string },
      Object.create(null) as Record<string, unknown>,
      { hook_event_name: 'PostToolUse', tool_response: undefined },
    ];
    for (const value of junk) {
      expect(() => parseHookPayload(value)).not.toThrow();
    }
  });
});

describe('record construction', () => {
  it('hashes the working directory instead of keeping it', () => {
    const parsed = parseHookPayload(documentedSessionStart('resume'));
    const record = buildObservationRecord(parsed, 1_700_000_000_000, hash);
    expect(record.kind).toBe('session-start');
    expect(record.source).toBe('resume');
    expect(record.cwdHash).toBe('h(C:/repo)');
    expect(JSON.stringify(record)).not.toContain('C:\\\\repo');
  });

  it('records an unusable payload as an unusable observation', () => {
    const record = buildObservationRecord(parseHookPayload('not json'), 5, hash);
    expect(record.kind).toBe('unusable');
    expect(record.sessionId).toBeUndefined();
  });

  it('records an unobserved event as ignored', () => {
    const record = buildObservationRecord(
      parseHookPayload({ hook_event_name: 'SomeFutureEvent', session_id: 'thr_1' }),
      5,
      hash,
    );
    expect(record.kind).toBe('ignored');
    expect(record.sessionId).toBe('thr_1');
  });

  it('keeps a non-read tool out of the read counters', () => {
    const record = buildObservationRecord(
      parseHookPayload(documentedPreToolUse('apply_patch', { command: '*** Begin Patch' })),
      5,
      hash,
    );
    expect(record.kind).toBe('tool-start');
    expect(record.tool).toBe('apply_patch');
    expect(record.read).toBeUndefined();
    expect(record.readReason).toBeUndefined();
  });
});
