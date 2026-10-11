/**
 * Independent grading for Level 2.
 *
 * The rule this module enforces: **coding success is the repository's own test
 * command exiting zero, run against pristine tests.** Nothing the agent reports is
 * consulted, and nothing the agent wrote under the graded paths survives.
 *
 * The output of the command is captured as a bounded excerpt plus a digest. The
 * digest is what the report carries; the excerpt stays in the run artifact so a
 * human can inspect a failure without the benchmark report becoming a channel for
 * model output.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, restoreGradedFiles } from './repos.js';
import type { Level2GradeCheck, Level2Grading, Level2Task } from './types.js';

const run = promisify(execFile);

/** Default time limit for one task's test command. */
export const DEFAULT_GRADING_TIMEOUT_MS = 120_000;

/** How much captured output is kept in the artifact. */
const MAX_OUTPUT_CHARS = 4_000;

/** Options for one grading run. */
export interface GradeOptions {
  readonly timeoutMs?: number;
  /** Called with the restored-file list, for logging by the caller. */
  readonly onRestored?: (changed: readonly string[]) => void;
}

/**
 * Grade one repository against its task's acceptance criteria.
 *
 * Steps, in order: restore the graded files to their pristine content, assert the
 * restore took effect, then run the task's own command. A task whose graded files
 * cannot be trusted is never graded, because a passing result would be meaningless.
 */
export async function gradeTask(
  task: Level2Task,
  root: string,
  options: GradeOptions = {},
): Promise<Level2Grading> {
  const checks: Level2GradeCheck[] = [];
  let changed: readonly string[] = [];
  let restoreFailed: string | undefined;

  try {
    changed = await restoreGradedFiles(root, task);
    checks.push({
      name: 'graded-files-restored',
      passed: true,
      detail:
        changed.length === 0
          ? 'The graded files were already pristine.'
          : `Restored ${changed.length} edited graded file(s) from the pristine pack.`,
    });
    options.onRestored?.(changed);
  } catch (error) {
    restoreFailed = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'graded-files-restored',
      passed: false,
      detail: restoreFailed,
    });
  }

  const command = task.gradingCommand.join(' ');
  const startedAt = performance.now();

  if (restoreFailed !== undefined) {
    return {
      passed: false,
      command,
      exitCode: undefined,
      timedOut: false,
      durationMs: performance.now() - startedAt,
      outputDigest: digest(`grading-not-run: ${restoreFailed}`),
      outputExcerpt: '',
      checks,
    };
  }

  const [executable, ...args] = task.gradingCommand;
  if (executable === undefined) {
    checks.push({
      name: 'test-command-ran',
      passed: false,
      detail: 'The task declares no grading command.',
    });
    return {
      passed: false,
      command,
      exitCode: undefined,
      timedOut: false,
      durationMs: performance.now() - startedAt,
      outputDigest: digest('grading-not-run: no command'),
      outputExcerpt: '',
      checks,
    };
  }

  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  let timedOut = false;

  try {
    const result = await run(executable, args, {
      cwd: root,
      timeout: options.timeoutMs ?? DEFAULT_GRADING_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    stdout = String(result.stdout ?? '');
    stderr = String(result.stderr ?? '');
    exitCode = 0;
  } catch (error) {
    const failure = error as {
      readonly code?: number | string;
      readonly killed?: boolean;
      readonly signal?: string;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    stdout = String(failure.stdout ?? '');
    stderr = String(failure.stderr ?? '');
    exitCode = typeof failure.code === 'number' ? failure.code : undefined;
    timedOut = failure.killed === true || failure.signal !== undefined;
  }

  const durationMs = performance.now() - startedAt;
  const passed = exitCode === 0 && !timedOut;
  checks.push({
    name: 'test-command-ran',
    passed: exitCode !== undefined,
    detail:
      exitCode === undefined
        ? 'The test command could not be started or reported no exit code.'
        : `The test command exited with code ${exitCode}${timedOut ? ' (after being killed)' : ''}.`,
  });
  checks.push({
    name: 'task-acceptance',
    passed,
    detail: passed
      ? 'The repository\u2019s own test command passed against pristine tests.'
      : 'The repository\u2019s own test command did not pass, so the task was not solved.',
  });

  const combined = `${stdout}\n--- stderr ---\n${stderr}`;

  return {
    passed,
    command,
    exitCode,
    timedOut,
    durationMs,
    outputDigest: digest(combined),
    outputExcerpt: combined.slice(0, MAX_OUTPUT_CHARS),
    checks,
  };
}
