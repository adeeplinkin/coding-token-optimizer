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
import type { ArmRuntimeMode } from './runner.js';

/** Everything the guards need to know, so they can be evaluated without touching a runtime. */
export interface LiveGuardInput {
  readonly approveLive: boolean;
  readonly model: string | undefined;
  readonly runtime: ArmRuntimeMode;
  readonly cliPath: string;
  readonly cliPresent: boolean;
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
