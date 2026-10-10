/**
 * Vended copy of the documented Codex hook contract.
 *
 * Sources (Stage 1K): the official hooks documentation
 * (<https://developers.openai.com/codex/hooks>) and the runtime-verified hook
 * definitions returned by `hooks/list` on the installed build
 * (`codex-cli 0.162.0-alpha.17.2`).
 *
 * These builders exist so tests exercise the documented payload shape rather than
 * a shape invented here. If the adapter's expectations drift from this file,
 * `npm run typecheck` fails.
 */

/** Event names the documentation defines, in the order the docs list them. */
export const DOCUMENTED_HOOK_EVENTS = [
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
] as const;

export type DocumentedHookEventName = (typeof DOCUMENTED_HOOK_EVENTS)[number];

/**
 * Documented common input fields, plus the documented per-event additions.
 *
 * Quoted from the documentation: "Every command hook receives one JSON object on
 * stdin" with `session_id`, `transcript_path`, `cwd`, `hook_event_name` and
 * `model`; turn-scoped events add `turn_id`, and several add `permission_mode`.
 */
export interface DocumentedHookInput {
  readonly session_id?: string;
  readonly transcript_path?: string | null;
  readonly cwd?: string;
  readonly hook_event_name: DocumentedHookEventName;
  readonly model?: string;
  readonly turn_id?: string;
  readonly permission_mode?: string;
  readonly tool_name?: string;
  readonly tool_use_id?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly prompt?: string;
  readonly source?: 'startup' | 'resume' | 'clear' | 'compact';
  readonly reason?: string;
  readonly trigger?: 'manual' | 'auto';
  readonly agent_id?: string;
  readonly agent_type?: string;
  readonly stop_hook_active?: boolean;
  readonly last_assistant_message?: string | null;
}

/** Documented example: `{ "session_id": "thr_123", ..., "reason": "other" }`. */
export function documentedSessionEnd(sessionId = 'thr_123'): DocumentedHookInput {
  return {
    session_id: sessionId,
    transcript_path: '/workspace/.codex/rollout.jsonl',
    cwd: '/workspace',
    hook_event_name: 'SessionEnd',
    reason: 'other',
  };
}

export function documentedSessionStart(
  source: DocumentedHookInput['source'] = 'startup',
  sessionId = 'thr_123',
): DocumentedHookInput {
  return {
    session_id: sessionId,
    transcript_path: '/workspace/.codex/rollout.jsonl',
    cwd: 'C:\\repo',
    hook_event_name: 'SessionStart',
    source,
    model: 'gpt-6.1-sol',
  };
}

export function documentedUserPromptSubmit(
  prompt: string,
  sessionId = 'thr_123',
): DocumentedHookInput {
  return {
    session_id: sessionId,
    cwd: 'C:\\repo',
    hook_event_name: 'UserPromptSubmit',
    turn_id: 'turn_1',
    prompt,
    permission_mode: 'default',
  };
}

export function documentedPreToolUse(
  toolName: string,
  toolInput: unknown,
  toolUseId = 'call_1',
  sessionId = 'thr_123',
): DocumentedHookInput {
  return {
    session_id: sessionId,
    cwd: 'C:\\repo',
    hook_event_name: 'PreToolUse',
    turn_id: 'turn_1',
    permission_mode: 'default',
    tool_name: toolName,
    tool_use_id: toolUseId,
    tool_input: toolInput,
  };
}

export function documentedPostToolUse(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  toolUseId = 'call_1',
  sessionId = 'thr_123',
): DocumentedHookInput {
  return {
    ...documentedPreToolUse(toolName, toolInput, toolUseId, sessionId),
    hook_event_name: 'PostToolUse',
    tool_response: toolResponse,
  };
}

export function documentedPermissionRequest(
  toolName: string,
  toolInput: unknown,
  sessionId = 'thr_123',
): DocumentedHookInput {
  return {
    session_id: sessionId,
    cwd: 'C:\\repo',
    hook_event_name: 'PermissionRequest',
    turn_id: 'turn_1',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

export function documentedCompaction(
  eventName: 'PreCompact' | 'PostCompact',
  trigger: 'manual' | 'auto',
  sessionId = 'thr_123',
): DocumentedHookInput {
  return {
    session_id: sessionId,
    cwd: 'C:\\repo',
    hook_event_name: eventName,
    turn_id: 'turn_1',
    trigger,
  };
}

export function documentedSubagent(
  eventName: 'SubagentStart' | 'SubagentStop',
  agentType = 'general',
  sessionId = 'thr_123',
): DocumentedHookInput {
  return {
    session_id: sessionId,
    cwd: 'C:\\repo',
    hook_event_name: eventName,
    turn_id: 'turn_1',
    agent_id: 'agent_1',
    agent_type: agentType,
    permission_mode: 'default',
  };
}

export function documentedStop(sessionId = 'thr_123'): DocumentedHookInput {
  return {
    session_id: sessionId,
    cwd: 'C:\\repo',
    hook_event_name: 'Stop',
    turn_id: 'turn_1',
    stop_hook_active: false,
    last_assistant_message: 'Done.',
  };
}

export function documentedInterrupt(sessionId = 'thr_123'): DocumentedHookInput {
  return {
    session_id: sessionId,
    cwd: 'C:\\repo',
    hook_event_name: 'Interrupt',
    turn_id: 'turn_1',
    permission_mode: 'default',
  };
}
