/**
 * The loopback **scripted provider**, started as a child process.
 *
 * Every offline session in this harness — the rehearsal's arms and the containment probe — is a
 * *real* runtime session pointed at this server. It answers the OpenAI-shaped chat-completions
 * request the runtime sends, in one of two scripts:
 *
 * - the fixed script (`readPath` + `toolCalls`), which asks for one or more in-workspace reads
 *   and then answers with text, and is what the rehearsal's arms use;
 * - a **tool plan** (`toolPlanPath`), one scripted tool call per turn, which is what lets the
 *   containment probe ask a session for a call the policy must refuse and watch what the
 *   runtime does with it.
 *
 * The server records every request body it receives. That record is the harness's *independent*
 * view of a session: it is written by the endpoint the run was deliberately pointed at, not by
 * the plugin under test, so a claim about what a tool call did can be checked against what the
 * runtime sent afterwards rather than against the guard's own report of itself.
 *
 * It is a test double and never part of the product: nothing in the shipped plugin or observer
 * imports it, and it is only ever reachable on loopback.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The capture server, as a path, so a caller can also run it directly. */
export const SCRIPTED_PROVIDER = fileURLToPath(
  new URL('../../../integrations/opencode/scripts/stage1r-capture-server.mjs', import.meta.url),
);

/** What one scripted session should be asked for. */
export interface ScriptedProviderOptions {
  /** The JSONL file the provider writes what it received to. Its directory is created. */
  readonly capturePath: string;
  /** The fixed script: the path each scripted `read` call asks for. */
  readonly readPath?: string;
  /** The fixed script: how many `read` calls the first answer carries. */
  readonly toolCalls?: number;
  /** The plan script: a JSON array of `{ name, args }`, one tool call per turn. */
  readonly toolPlanPath?: string;
}

/** A running provider. `stop` ends it; the capture file stays for the caller to read. */
export interface ScriptedProvider {
  readonly baseUrl: string;
  readonly stop: () => void;
}

/**
 * Start the provider and wait for its readiness line.
 *
 * Readiness is the server's own `LISTENING <port>` line, so a caller never sleeps and hopes; a
 * server that exits before printing it is reported with its diagnostics instead of leaving the
 * session to fail on a dead port.
 */
export async function startScriptedProvider(
  options: ScriptedProviderOptions,
): Promise<ScriptedProvider> {
  // The provider writes its capture file at startup, so its directory must exist before it is
  // spawned.
  await mkdir(dirname(options.capturePath), { recursive: true });

  const scriptArgs = ['--capture', options.capturePath, '--port', '0', '--mode', 'scripted'];
  if (options.toolPlanPath !== undefined) {
    scriptArgs.push('--tool-plan', options.toolPlanPath);
  } else {
    scriptArgs.push('--read-path', options.readPath ?? '', '--tool-calls', String(options.toolCalls ?? 1));
  }

  const server = spawn(process.execPath, [SCRIPTED_PROVIDER, ...scriptArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let diagnosis = '';
  server.stderr.on('data', (chunk) => {
    diagnosis += String(chunk);
  });

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let buffered = '';
    const timer = setTimeout(
      () =>
        rejectPort(
          new Error(`the scripted provider did not report readiness: ${diagnosis.trim().slice(0, 300)}`),
        ),
      15_000,
    );
    server.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      const match = /LISTENING (\d+)/.exec(buffered);
      if (match !== null) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    server.on('error', (error) => rejectPort(error));
    server.on('close', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        rejectPort(
          new Error(
            `the scripted provider exited with code ${String(code)}: ${diagnosis.trim().slice(0, 300)}`,
          ),
        );
      }
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stop: () => {
      server.kill();
    },
  };
}
