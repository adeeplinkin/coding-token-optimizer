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
 * Create a sink that appends one JSON object per line (JSON Lines) to `filePath`.
 *
 * Appending keeps earlier sessions rather than overwriting them, and only the
 * configured path is ever touched. The file is created on first write.
 */
export function createSummaryFileSink(filePath: string): ObservationSink {
  return async (summary: SessionObservationSummary): Promise<void> => {
    const { appendFile } = await import('node:fs/promises');
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
