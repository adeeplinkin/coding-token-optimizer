import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleHookPayload, shouldWriteDiagnosticsToStderr } from './handler.js';
import type { HandleResult, ObserverDiagnostic } from './types.js';

/**
 * The Codex hook entry point.
 *
 * Codex invokes this once per matching lifecycle event with the payload on stdin.
 * The contract this file guarantees, in order of importance:
 *
 * 1. **Nothing is written to stdout.** stdout is the channel through which a hook
 *    can influence Codex (`additionalContext`, `updatedInput`, `decision`,
 *    `continue`). This adapter never writes to it, so it cannot change a prompt, a
 *    tool call, a tool result or a turn — by construction, not by discipline.
 * 2. **The exit code is always 0.** A non-zero exit — especially exit code 2 — is
 *    a documented way to block a tool call or reject a prompt. The adapter never
 *    signals an error to Codex, even when its own work fails.
 * 3. **Nothing throws out of the process.** Every path is wrapped; an internal
 *    failure produces a content-free diagnostic (only with `DR_TOKEN_CODEX_DEBUG`)
 *    and nothing else.
 *
 * With `DR_TOKEN_CODEX_DEBUG` set, bounded content-free diagnostics are written to
 * stderr, which Codex surfaces but does not act on.
 */

/** Largest payload this entry point will read. A larger one is treated as unusable. */
export const MAX_STDIN_BYTES = 1024 * 1024;

/** Read stdin up to {@link MAX_STDIN_BYTES}. Never throws. */
export async function readStdinText(
  stream: NodeJS.ReadableStream & { readonly isTTY?: boolean },
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (stream.isTTY === true) {
    return { text: '', truncated: false };
  }
  try {
    let total = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
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

/**
 * Parse a payload from stdin text.
 *
 * Returns `undefined` for empty, oversized or malformed text, which the handler
 * records as an unusable payload rather than guessing what the host meant.
 */
export function parseStdinPayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Run the entry point once, for the given streams and environment.
 *
 * Returns the exit code (always 0) so a caller — including a test — can assert it.
 */
export async function runEntry(
  streams: {
    readonly stdin?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
    readonly stdout?: { write(chunk: string): unknown };
    readonly stderr?: { write(chunk: string): unknown };
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<number> {
  const env = streams.env ?? process.env;
  const stdin = streams.stdin ?? process.stdin;
  const debug = shouldWriteDiagnosticsToStderr(env);
  const stderr = streams.stderr ?? process.stderr;

  let result: HandleResult | undefined;
  try {
    const { text } = await readStdinText(stdin);
    result = await handleHookPayload(parseStdinPayload(text), {
      env,
      onDiagnostic: debug
        ? (diagnostic: ObserverDiagnostic) => {
            try {
              stderr.write(`dr-token-codex-observer ${diagnostic.level} ${diagnostic.code}\n`);
            } catch {
              // Ignored: stderr is best effort.
            }
          }
        : undefined,
    });
  } catch {
    // Nothing to do: the adapter never reports failure to Codex.
    result = undefined;
  }

  // stdout is intentionally never written to, on every path.
  void result;
  return 0;
}

/** True when this module was executed directly rather than imported. */
export function isDirectEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (typeof argv1 !== 'string' || argv1.length === 0) {
    return false;
  }
  try {
    return path.resolve(argv1) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (isDirectEntry(process.argv[1], import.meta.url)) {
  runEntry()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 0;
    });
}
