import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir, removeDir, validFixture, writeFiles } from './helpers.js';

const execFileAsync = promisify(execFile);

const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await createTempDir();
  tempDirs.push(directory);
  return directory;
}

beforeAll(async () => {
  try {
    await access(CLI_PATH);
  } catch {
    throw new Error(`The benchmark CLI is not built at ${CLI_PATH}. Run "npm run build" first.`);
  }
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => removeDir(directory)));
});

describe('benchmark CLI', () => {
  it('runs the default fixtures and writes a JSON report', async () => {
    const directory = await makeTempDir();
    const reportPath = path.join(directory, 'report.json');

    const result = await runCli(['--out', reportPath]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OK');
    expect(result.stdout).toContain('tokens=unavailable');

    const parsed = JSON.parse(await readFile(reportPath, 'utf8')) as {
      schemaVersion: number;
      runs: readonly { correctness: { passed: boolean } }[];
      comparisons: readonly { verdict: string }[];
      summary: { unavailableMetrics: readonly string[] };
      disclaimer: string;
    };

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.runs).toHaveLength(16);
    expect(parsed.runs.every((run) => run.correctness.passed)).toBe(true);
    expect(parsed.comparisons.every((comparison) => comparison.verdict === 'unavailable')).toBe(true);
    expect(parsed.summary.unavailableMetrics).toContain('totalTokens');
    expect(parsed.disclaimer).toContain('No real coding harness was executed');
  });

  it('records the requested mode in the report', async () => {
    const directory = await makeTempDir();
    const reportPath = path.join(directory, 'mode-report.json');

    const result = await runCli(['--mode', 'balanced', '--out', reportPath]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(await readFile(reportPath, 'utf8')) as {
      runs: readonly { provenance: { mode: string } }[];
    };
    expect(parsed.runs.every((run) => run.provenance.mode === 'balanced')).toBe(true);
  });

  it('exits with code 1 when a fixture fails its correctness checks', async () => {
    const directory = await makeTempDir();
    const fixturesDir = path.join(directory, 'fixtures');
    const reportPath = path.join(directory, 'failing-report.json');
    await writeFiles(fixturesDir, {
      'broken-fixture.json': validFixture({
        id: 'broken-fixture',
        context: 'short text that does not contain the requirement',
        requiredContent: [{ label: 'impossible', text: 'this text is definitely absent' }],
      }),
    });

    const result = await runCli(['--fixtures', fixturesDir, '--out', reportPath]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('FAIL');
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(await readFile(reportPath, 'utf8')) as {
      summary: { correctnessFailed: number };
    };
    expect(parsed.summary.correctnessFailed).toBe(2);
  });

  it('exits with code 2 when fixtures cannot be loaded', async () => {
    const directory = await makeTempDir();
    const reportPath = path.join(directory, 'missing-report.json');

    const result = await runCli([
      '--fixtures',
      path.join(directory, 'missing'),
      '--out',
      reportPath,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('could not be read');
    await expect(access(reportPath)).rejects.toThrow();
  });

  it('prints usage for --help', async () => {
    const result = await runCli(['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage');
  });

  it('exits with code 2 for an unknown mode', async () => {
    const result = await runCli(['--mode', 'turbo']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown mode');
  });

  it('exits with code 2 for an unknown argument', async () => {
    const result = await runCli(['--nope']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown argument');
  });
});
