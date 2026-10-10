import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

/** Absolute path of the built entry point this adapter's hooks invoke. */
export const ENTRY_PATH = fileURLToPath(new URL('../dist/entry.js', import.meta.url));

/** Directory containing the package's example hook configuration. */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const temporaryDirectories: string[] = [];

/** Create a temporary directory removed after the current test file finishes. */
export async function temporaryDirectory(prefix = 'dr-token-codex-'): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

export interface FakeClock {
  readonly now: () => number;
  readonly advance: (ms?: number) => void;
}

/** Clock with a fixed start so summaries are byte-for-byte reproducible. */
export function createFakeClock(start = 1_700_000_000_000, step = 1000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms = step) => {
      current += ms;
    },
  };
}

/** Minimal environment a Node child needs to start on Windows and POSIX. */
function baseProcessEnvironment(): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']) {
    const value = process.env[key];
    if (typeof value === 'string') {
      picked[key] = value;
    }
  }
  return picked;
}

export interface EntryRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the real hook entry point as its own process, exactly as Codex does.
 *
 * The payload is delivered on stdin and the process environment is replaced with
 * `env`, so a test can never inherit a developer's real switches.
 */
export async function runHookProcess(
  payload: string,
  env: Readonly<Record<string, string>>,
  options: { readonly path?: string; readonly timeoutMs?: number } = {},
): Promise<EntryRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.path ?? ENTRY_PATH], {
      // Only the base variables Node needs to start, plus the switches under test:
      // a developer's real DR_TOKEN_* settings must never leak into a test run.
      env: { ...baseProcessEnvironment(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('hook entry did not exit in time'));
    }, options.timeoutMs ?? 20_000);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });

    child.stdin.end(payload, 'utf8');
  });
}

/** Run many hook processes concurrently, sharing one state directory. */
export async function runHookProcesses(
  payloads: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<readonly EntryRun[]> {
  return Promise.all(payloads.map((payload) => runHookProcess(payload, env)));
}

/** Read a JSON Lines summary file into parsed records, ignoring a torn tail. */
export async function readSummaryLines(
  filePath: string,
): Promise<readonly Record<string, unknown>[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = contents.split('\n');
  if ((lines[lines.length - 1] ?? '').length > 0) {
    lines.pop();
  }
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    records.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return records;
}

/** Assert a value, serialized, contains none of the supplied secrets. */
export function leakChecker(serialized: string, secrets: readonly string[]): string | undefined {
  for (const secret of secrets) {
    if (serialized.includes(secret)) {
      return secret;
    }
  }
  return undefined;
}
