import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_OBSERVER_ADAPTER_REVISION,
  IMPLEMENTED_HOOK_EVENTS,
  type ObservationRecord,
} from '../src/index.js';
import { buildObservationRecord, handleHookPayload } from '../src/handler.js';
import { parseHookPayload } from '../src/hook-input.js';
import { DOCUMENTED_HOOK_EVENTS } from './fixtures/codex-hooks.contract.js';
import { PACKAGE_ROOT, temporaryDirectory } from './helpers.js';

const hash = (value: string): string => `h(${value})`;

/** Keys a record may carry. Nothing else is ever persisted for an event. */
const RECORD_KEYS: readonly string[] = [
  'v',
  'at',
  'kind',
  'sessionId',
  'cwdHash',
  'source',
  'trigger',
  'tool',
  'call',
  'read',
  'readBasis',
  'readReason',
  'malformedRange',
  'responseKind',
  'agentType',
  'permissionTool',
  'stopHookActive',
];

/** Keys a handle result may carry. None of them can influence Codex. */
const RESULT_KEYS: readonly string[] = [
  'recorded',
  'disabled',
  'eventName',
  'sessionKey',
  'diagnostics',
  'stdout',
];

describe('documented event set', () => {
  it('implements exactly the documented lifecycle events', () => {
    expect([...DOCUMENTED_HOOK_EVENTS].sort()).toEqual([...IMPLEMENTED_HOOK_EVENTS].sort());
    expect(IMPLEMENTED_HOOK_EVENTS).toHaveLength(12);
  });

  it('covers the events the adapter needs to observe tool execution and lifecycle', () => {
    for (const required of [
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'PreCompact',
      'PostCompact',
    ]) {
      expect(IMPLEMENTED_HOOK_EVENTS).toContain(required);
    }
  });

  it('keeps the recorded adapter revision in sync with package.json', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { version: string; name: string };
    expect(CODEX_OBSERVER_ADAPTER_REVISION).toBe(manifest.version);
  });
});

describe('records cannot influence Codex', () => {
  it('persists only the documented metadata keys', () => {
    const payloads: unknown[] = [
      { hook_event_name: 'SessionStart', session_id: 'thr_1', cwd: 'C:\\repo', source: 'startup' },
      { hook_event_name: 'PreToolUse', session_id: 'thr_1', tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'cat a.md' } },
      { hook_event_name: 'PostToolUse', session_id: 'thr_1', tool_name: 'Bash', tool_use_id: 'c1', tool_response: { output: 'SECRET' } },
      { hook_event_name: 'PermissionRequest', session_id: 'thr_1', tool_name: 'Bash' },
      { hook_event_name: 'PreCompact', session_id: 'thr_1', trigger: 'auto' },
      { hook_event_name: 'SubagentStart', session_id: 'thr_1', agent_type: 'general' },
      { hook_event_name: 'Stop', session_id: 'thr_1', stop_hook_active: true },
      { hook_event_name: 'Interrupt', session_id: 'thr_1' },
      { hook_event_name: 'SessionEnd', session_id: 'thr_1' },
    ];

    for (const payload of payloads) {
      const record: ObservationRecord = buildObservationRecord(
        parseHookPayload(payload),
        1_700_000_000_000,
        hash,
      );
      for (const key of Object.keys(record)) {
        expect(RECORD_KEYS, `${JSON.stringify(payload)} produced key ${key}`).toContain(key);
      }
    }
  });

  it('never returns a value the host could act on', async () => {
    // State goes to a temporary directory: a test must never write observation
    // state into the package (dist/ in particular), even briefly.
    const stateDir = await temporaryDirectory();
    const result = await handleHookPayload(
      { hook_event_name: 'PreToolUse', session_id: 'thr_1', tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'cat a.md' } },
      { env: {}, stateDir, now: () => 1 },
    );
    expect(result.stdout).toBe('');
    for (const key of Object.keys(result)) {
      expect(RESULT_KEYS, `handle result carried key ${key}`).toContain(key);
    }
  });

  it('asks for hook timeouts Codex does not have to clamp', async () => {
    const example = JSON.parse(
      await readFile(path.join(PACKAGE_ROOT, 'codex-hooks.example.json'), 'utf8'),
    ) as { hooks: Record<string, { hooks: { timeout?: number }[] }[]> };

    // Runtime-verified in Stage 1M: Codex clamps the `SessionEnd` and `Interrupt`
    // hook timeouts to 3 seconds and reports a diagnostic in the session for every
    // handler that asks for more (observed live, one message per handler). The
    // shipped configuration therefore asks for exactly 3 on those two events. The
    // 10-second ceiling elsewhere is Dr. Token's own conservative bound, not a
    // Codex limit: no other event was clamped at 10.
    for (const [event, groups] of Object.entries(example.hooks)) {
      const ceiling = event === 'SessionEnd' || event === 'Interrupt' ? 3 : 10;
      for (const group of groups) {
        for (const handler of group.hooks) {
          expect(typeof handler.timeout, `${event} handler timeout`).toBe('number');
          expect(handler.timeout, `${event} handler timeout`).toBeGreaterThan(0);
          expect(handler.timeout, `${event} handler timeout`).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  it('ships an example configuration that only observes', async () => {
    const example = JSON.parse(
      await readFile(path.join(PACKAGE_ROOT, 'codex-hooks.example.json'), 'utf8'),
    ) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };

    const events = Object.keys(example.hooks);
    expect(events.sort()).toEqual([...IMPLEMENTED_HOOK_EVENTS].sort());

    const handlerKeys = new Set(['type', 'command', 'commandWindows', 'timeout', 'statusMessage', 'async']);
    for (const [event, groups] of Object.entries(example.hooks)) {
      expect(groups.length, event).toBeGreaterThan(0);
      for (const group of groups) {
        for (const handler of group.hooks) {
          expect(handler['type'], event).toBe('command');
          expect(String(handler['command']), event).toContain('dist/entry.js');
          for (const key of Object.keys(handler)) {
            expect(handlerKeys, `${event} handler key ${key}`).toContain(key);
          }
        }
      }
    }
  });
});
