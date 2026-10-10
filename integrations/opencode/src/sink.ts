import type { ObservationSink, SessionObservationSummary } from './types.js';
import { OBSERVER_SUMMARY_FILE_ENV_VAR } from './types.js';

/**
 * Summary sinks.
 *
 * The observer writes nothing by default: no files, no network, no telemetry. A
 * sink is only created when the user explicitly asks for one, through the
 * documented `DR_TOKEN_OBSERVER_SUMMARY_FILE` environment variable or the
 * `summaryFile` plugin option. Any failure is contained and reported as a
 * content-free diagnostic.
 */

/** True when a value looks like a usable, non-empty path. */
export function isUsableSummaryPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * True when the file's last byte is not a newline, i.e. the previous write was
 * interrupted part-way through a record.
 *
 * A JSON Lines reader can only trust whole lines, so a torn fragment would
 * otherwise be glued to the next record and damage two observations at once.
 * Any failure to read (including the normal "no file yet") reports `false`: a
 * diagnostic must never become a reason to skip a write.
 */
async function hasTornTail(filePath: string): Promise<boolean> {
  try {
    const { open } = await import('node:fs/promises');
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
 * Create a sink that appends one JSON object per line (JSON Lines) to `filePath`.
 *
 * Appending keeps earlier sessions rather than overwriting them, and only the
 * configured path is ever touched. The file is created on first write.
 *
 * Reliability, on Windows as well as POSIX:
 * - each record is one `appendFile` call ending in `\n`, so a reader that takes
 *   the last complete line either sees a whole record or none of it;
 * - the observer serialises writes, so records land in the order they were
 *   produced and a stale summary can never follow a newer one;
 * - the first write of a process checks whether an earlier process was killed
 *   mid-record and, if so, closes that fragment with a newline first. That keeps
 *   one interrupted session from corrupting the next record, without rewriting
 *   or truncating history;
 * - a write error propagates to the observer, which reports `sink-failed` and
 *   carries on.
 *
 * This deliberately stays append-only rather than "write a temp file and rename":
 * renaming would discard earlier sessions and, on Windows, fails when another
 * process holds the destination open.
 */
export function createSummaryFileSink(filePath: string): ObservationSink {
  let tailChecked = false;
  return async (summary: SessionObservationSummary): Promise<void> => {
    const { appendFile } = await import('node:fs/promises');
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
 * Returns `undefined` when the summary-file switch is unset, which is the
 * default and the only configuration that guarantees no write path.
 */
export function resolveEnvironmentSink(
  env: Readonly<Record<string, string | undefined>>,
): ObservationSink | undefined {
  const configured = env[OBSERVER_SUMMARY_FILE_ENV_VAR];
  if (!isUsableSummaryPath(configured)) {
    return undefined;
  }
  return createSummaryFileSink(configured.trim());
}
