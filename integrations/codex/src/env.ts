import {
  CODEX_OBSERVER_DISABLE_ENV_VAR,
  CODEX_OBSERVER_DEBUG_ENV_VAR,
  CODEX_OBSERVER_STATE_DIR_ENV_VAR,
  CODEX_OBSERVER_SUMMARY_FILE_ENV_VAR,
} from './types.js';

/**
 * Environment switches.
 *
 * Every switch is read from the environment because Codex runs each command hook
 * as an independent process with no plugin options channel. All of them fail
 * towards "do less": an unusable value never enables a write.
 */

/** Values that disable observation. */
const DISABLE_VALUES: readonly string[] = ['off', 'false', '0', 'no', 'disabled'];

/** True when a value looks like a usable, non-empty path. */
export function isUsablePath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * True when the environment disables observation.
 *
 * Unset means enabled: the adapter is only active at all when a Codex hook is
 * configured to invoke it, which is itself the opt-in.
 */
export function isDisabledByEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = env[CODEX_OBSERVER_DISABLE_ENV_VAR];
  if (typeof raw !== 'string') {
    return false;
  }
  return DISABLE_VALUES.includes(raw.trim().toLowerCase());
}

/** The opt-in summary file path, or `undefined` when no sink was configured. */
export function summaryFilePathFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const configured = env[CODEX_OBSERVER_SUMMARY_FILE_ENV_VAR];
  return isUsablePath(configured) ? configured.trim() : undefined;
}

/** The cross-process state root override, or `undefined` when none was configured. */
export function stateDirFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const configured = env[CODEX_OBSERVER_STATE_DIR_ENV_VAR];
  return isUsablePath(configured) ? configured.trim() : undefined;
}

/** True when bounded, content-free diagnostics should reach stderr. */
export function isDebugEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = env[CODEX_OBSERVER_DEBUG_ENV_VAR];
  if (typeof raw !== 'string') {
    return false;
  }
  return ['1', 'on', 'true', 'yes', 'debug'].includes(raw.trim().toLowerCase());
}
