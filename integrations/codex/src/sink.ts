import { appendFile, open } from 'node:fs/promises';
import { isUsablePath } from './env.js';
import { CODEX_OBSERVER_SUMMARY_FILE_ENV_VAR } from './types.js';
import type { CodexSessionObservationSummary, ObservationSink } from './types.js';

/**
 * Summary sinks.
 *
 * The adapter writes nothing by default: no file, no network, no telemetry. A
 * sink exists only when the user configured `DR_TOKEN_OBSERVER_SUMMARY_FILE`,
 * and then only observation summaries are ever appended — never a prompt, a tool
 * argument, a tool response or a file path.
 */

/**
 * True when the file's last byte is not a newline, i.e. the previous write was
 * interrupted part-way through a record.
 *
 * A JSON Lines reader can only trust whole lines, so a torn fragment would
 * otherwise be glued to the next record and damage two observations at once. Any
 * failure to read (including the normal "no file yet") reports `false`: a
 * diagnostic must never become a reason to skip a write.
 */
async function hasTornTail(filePath: string): Promise<boolean> {
  try {
    const handle = await open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size === 0) {
        return false;
      }
      const lastByte = new Uint8Array(1);
      const { bytesRead } = await handle.read(lastByte, 0, 1, size - 1);
      return bytesRead === 1 && lastByte[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Create a sink that appends one JSON object per line to `filePath`.
 *
 * Appending keeps earlier sessions rather than overwriting them, matching the
 * OpenCode adapter so both adapters can feed one evidence stream. The first write
 * of a process closes a torn fragment left by a killed process before writing, so
 * one interrupted session cannot corrupt the next record.
 */
export function createSummaryFileSink(filePath: string): ObservationSink {
  let tailChecked = false;
  return async (summary: CodexSessionObservationSummary): Promise<void> => {
    if (!tailChecked) {
      // Claimed synchronously so concurrent first writes cannot each repair.
      tailChecked = true;
      if (await hasTornTail(filePath)) {
        await appendFile(filePath, '\n', 'utf8');
      }
    }
    await appendFile(filePath, `${JSON.stringify(summary)}\n`, 'utf8');
  };
}

/**
 * Resolve the sink implied by the environment.
 *
 * Returns `undefined` when the summary-file switch is unset, which is the default
 * and the only configuration that guarantees no write path.
 */
export function resolveEnvironmentSink(
  env: Readonly<Record<string, string | undefined>>,
): ObservationSink | undefined {
  const configured = env[CODEX_OBSERVER_SUMMARY_FILE_ENV_VAR];
  if (!isUsablePath(configured)) {
    return undefined;
  }
  return createSummaryFileSink(configured.trim());
}
