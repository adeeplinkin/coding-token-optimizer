/**
 * Refusals that stand between an authorization and a live model call.
 *
 * These are the checks that decide whether a live run may start at all. They live in their own module
 * because the command line cannot be imported by a test — importing it would start the CLI — and a
 * guard that is not tested is a guard that stops working silently.
 *
 * The rule the caps enforce here is the one Stage 1U's pilot showed to be necessary: a live run must
 * have a **per-session** bound and a **total** bound, in at least one currency, before it starts. A
 * cap that is only cumulative cannot stop one runaway session; a cap that is only per-session cannot
 * bound the sequence; and a run with no bound at all cannot be stopped by anything except a human.
 * Both currencies may be configured at once — the unit bound is what still works when the provider
 * reports no cost, and the spending bound is what the report is actually about.
 */
import { spawnSync } from 'node:child_process';
import type { ArmRuntimeMode } from './runner.js';

/** One path `git status` reported as changed, split into its code and its path. */
export interface WorkingTreeEntry {
  /** The two-character porcelain status, e.g. ` M`, `??`, `A `. */
  readonly code: string;
  readonly path: string;
}

/**
 * A repository's working tree, as git describes it.
 *
 * Only files git *tracks* or reports as **untracked** count. Ignored files are absent from
 * `git status --porcelain` by construction, which is what makes this check usable on a checkout
 * where this harness writes reports into an ignored directory.
 *
 * `error` is set when the state could not be read at all (not a repository, git absent, git
 * failed). That is not "clean": an unreadable tree is refused exactly like a dirty one, because
 * a live run must be attributable to a revision someone can find again.
 */
export interface WorkingTreeState {
  readonly clean: boolean;
  readonly entries: readonly WorkingTreeEntry[];
  readonly error: string | undefined;
}

/** A `git` invocation, injectable so the check can be tested without a repository. */
export type GitRunner = (args: readonly string[]) => {
  readonly stdout: string;
  readonly error: string | undefined;
};

/** Parse `git status --porcelain` output into the paths it reports. */
export function parseWorkingTree(porcelain: string): WorkingTreeState {
  const entries = porcelain
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.trim().length === 0) return [];
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      return path.length === 0 ? [] : [{ code, path }];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return { clean: entries.length === 0, entries, error: undefined };
}

/**
 * Read the working tree of the repository containing `root`.
 *
 * Read-only: `git status` writes nothing, and this function never stages, commits, stashes or
 * deletes — a dirty tree is reported, not repaired. The repository root is resolved with
 * `rev-parse --show-toplevel` so the check is about the checkout that contains the harness rather
 * than whatever directory the process happened to start in.
 */
export function readWorkingTree(root: string, run: GitRunner = defaultGitRunner): WorkingTreeState {
  const top = run(['-C', root, 'rev-parse', '--show-toplevel']);
  if (top.error !== undefined || top.stdout.trim().length === 0) {
    return {
      clean: false,
      entries: [],
      error: top.error ?? 'git did not report the repository root',
    };
  }
  const status = run(['-C', top.stdout.trim(), 'status', '--porcelain']);
  if (status.error !== undefined) {
    return { clean: false, entries: [], error: status.error };
  }
  return parseWorkingTree(status.stdout);
}

/** The real `git`, capturing both streams and never throwing. */
function defaultGitRunner(args: readonly string[]): { stdout: string; error: string | undefined } {
  try {
    const result = spawnSync('git', [...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.error !== undefined && result.error !== null) {
      return { stdout: '', error: result.error.message };
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      return {
        stdout: result.stdout ?? '',
        error: `git ${args.join(' ')} exited with code ${String(result.status)}: ${(result.stderr ?? '').trim().slice(0, 200)}`,
      };
    }
    return { stdout: result.stdout ?? '', error: undefined };
  } catch (error) {
    return { stdout: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Everything the guards need to know, so they can be evaluated without touching a runtime. */
export interface LiveGuardInput {
  readonly approveLive: boolean;
  readonly model: string | undefined;
  readonly runtime: ArmRuntimeMode;
  readonly cliPath: string;
  readonly cliPresent: boolean;
  /**
   * The checkout the run would be attributed to. Required, not optional: a guard input that could
   * silently omit it would make the check skippable, which is how it went unnoticed on 2026-10-12.
   */
  readonly workingTree: WorkingTreeState;
  readonly maxRuns: number | undefined;
  /** Number of arm runs the plan would execute. */
  readonly planArmRuns: number;
  readonly maxUnitsPerRun: number | undefined;
  readonly maxUnits: number | undefined;
  readonly maxCostUsdPerRun: number | undefined;
  readonly maxCostUsd: number | undefined;
  /** Per-session wall-clock timeout in milliseconds, or `undefined` for the driver's default. */
  readonly timeoutMs: number | undefined;
}

/**
 * Every reason this live run must not start, in the order an operator would want to fix them.
 *
 * An empty list means the run may start; nothing here decides whether it will *succeed*.
 */
export function liveRunRefusals(input: LiveGuardInput): readonly string[] {
  const problems: string[] = [];

  if (!input.approveLive) {
    problems.push(
      'refusing to make live model calls without --approve-live. Run --preflight first, then authorize explicitly.',
    );
  }
  if (input.model === undefined) {
    problems.push('--live requires --model so the run is attributable to one model.');
  }
  if (!input.cliPresent) {
    problems.push(`the OpenCode CLI was not found at ${input.cliPath}`);
  }
  // A live run is an experiment against a *revision*. If the tree carries uncommitted work, the
  // report cannot name what was run, and a reader cannot reproduce it — so the run is refused
  // rather than annotated. Gitignored artifacts (this harness's own reports, temp homes) do not
  // count: `git status --porcelain` omits them by construction.
  if (input.workingTree.error !== undefined) {
    problems.push(
      `refusing to start: the working tree could not be read (${input.workingTree.error}), so the revision this run would be attributed to is unknown; commit or stash the work and re-run.`,
    );
  } else if (!input.workingTree.clean) {
    const shown = input.workingTree.entries.slice(0, 5).map((entry) => `${entry.code.trim() || '??'} ${entry.path}`);
    const more = input.workingTree.entries.length - shown.length;
    problems.push(
      `refusing to start: the working tree has ${String(input.workingTree.entries.length)} uncommitted change(s) (${shown.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}), so a live run could not be attributed to a revision; commit or stash them first (this check changes nothing).`,
    );
  }
  if (input.maxRuns === undefined || input.planArmRuns > input.maxRuns) {
    problems.push(
      `refusing to run ${input.planArmRuns} arm run(s) without --max-runs at or above that number.`,
    );
  }

  // A live run must be bounded before it starts. The wall-clock timeout is always in force (a
  // non-positive or absent value falls back to the driver's own default), so it is not a reason to
  // refuse; the caps are, because they are the only bound that survives a session misbehaving.
  const perSessionBounded =
    input.maxUnitsPerRun !== undefined || input.maxCostUsdPerRun !== undefined;
  const totalBounded = input.maxUnits !== undefined || input.maxCostUsd !== undefined;
  if (!perSessionBounded) {
    problems.push(
      'refusing to start: no per-session cap is configured (--max-units-per-run or --max-cost-usd-per-run), so one runaway session could spend unbounded.',
    );
  }
  if (!totalBounded) {
    problems.push(
      'refusing to start: no total cap is configured (--max-units or --max-cost-usd), so the run has no bound to stop at.',
    );
  }

  return problems;
}

/**
 * The bounds a run will actually enforce, as one printable line.
 *
 * Printed before the first session so the operator sees the numbers an authorization is being spent
 * against, rather than discovering them in the report afterwards.
 */
export function describeLiveBounds(input: LiveGuardInput): string {
  const units = (value: number | undefined): string => (value === undefined ? 'none' : String(value));
  const money = (value: number | undefined): string =>
    value === undefined ? 'none' : `$${value.toFixed(2)}`;
  const timeout =
    input.timeoutMs === undefined ? 'driver default (20 min)' : `${String(input.timeoutMs)} ms`;
  const inSession =
    input.runtime === 'service'
      ? 'the per-session spending cap is also enforced in-session: a governor reads the cost the runtime reports and ' +
        "calls the runtime's native session.interrupt when the cap is crossed, so the overshoot is limited to the spend " +
        'of the steps that complete between a poll (1.5 s interval) and the interrupt landing, never by the cap; the unit ' +
        'caps and the cumulative caps are checked after each session (post-session breakers)'
      : 'on the private server the only in-session stop is the wall-clock kill: the native interrupt targets the ' +
        'background service, and the caps are checked after each session (post-session breakers)';
  return (
    `bounds: per session ${units(input.maxUnitsPerRun)} unit(s) / ${money(input.maxCostUsdPerRun)}, ` +
    `total ${units(input.maxUnits)} unit(s) / ${money(input.maxCostUsd)}, session timeout ${timeout}, ` +
    `at most ${input.maxRuns === undefined ? 'unset' : String(input.maxRuns)} arm run(s); ` +
    `${inSession}; the only unconditional per-session stop is the wall-clock kill at ${timeout}, ` +
    'and no in-session request-count or output-token limit is enforced'
  );
}
