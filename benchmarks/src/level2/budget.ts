/**
 * Hard usage and spending caps for a Level 2 run.
 *
 * ## Two bounds, and why neither is a measurement
 *
 * The framework's rule is that overlapping token fields are never summed, because a
 * total would be a fabricated measurement. A *cap* has the opposite requirement: it
 * must be one number that cannot under-count, so the unit bound deliberately adds
 * every reported field together and calls the result what it is — a conservative
 * accounting unit, not a measurement. It is used only to decide whether another
 * session may start.
 *
 * - **Units.** Every reported token field (input, output, reasoning, cache read,
 *   cache write) added together. Machine-independent, and cheap, but it cannot be
 *   compared with a price list.
 * - **Cost.** The provider's own reported `cost` for the session, summed over the run.
 *   This is the bound that answers "how much money can this spend", so it is the
 *   primary cap; the unit cap is the backstop that still works when cost is absent.
 *
 * The defaults are calibrated from measured sessions, not from intuition. On the
 * development machine, 23 real OpenCode sessions recorded a median of ~1.1M units and
 * ~$0.07 per paid session, with one large session at 85.9M units (its cost was
 * $1.74 at that provider's rates). Tiny synthetic repositories, which is what the
 * Level 2 pack uses, sit far below that. Defaults are therefore a safety net with
 * several times the headroom of a plausible session rather than a target to spend.
 *
 * ## Stopping is always "before the next session"
 *
 * The harness cannot interrupt a session mid-flight, so the wall-clock session timeout
 * is the per-session hard stop and these caps bound the *sequence*: after each session
 * the tracker decides whether another one may start, and the first cap that is broken
 * ends the run. A cap can therefore never be exceeded by more than the single session
 * that tripped it.
 *
 * ## Fail closed on an unreported cost
 *
 * A session that reports no cost at all is not a free session: it is an unmeasured
 * one. When a spending cap is configured and a session reports no cost, the tracker
 * stops the run (`cost-unreported`) rather than continuing with a bound it can no
 * longer see. A reported `0` (a free model) is a value, not a gap, and does not stop
 * anything.
 */
import type { Level2ArmObservation } from './types.js';

/**
 * Default per-session unit cap.
 *
 * 3,000,000 units is roughly three times the machine-measured median of a real
 * session, and comfortably above the largest small-repository session seen. It is a
 * runaway guard, not a budget: a session that approaches it is already pathological.
 */
export const DEFAULT_MAX_UNITS_PER_RUN = 3_000_000;

/** Default cumulative unit cap: ten sessions at the per-session cap. */
export const DEFAULT_MAX_UNITS = 30_000_000;

/** Default per-session spending cap, in US dollars as reported by the provider. */
export const DEFAULT_MAX_COST_USD_PER_RUN = 1;

/** Default cumulative spending cap: ten sessions at the per-session cap. */
export const DEFAULT_MAX_COST_USD = 10;

/** Reason a cap stopped a run, ready to print. */
export type BudgetStopReason =
  | 'per-run-cap'
  | 'total-cap'
  | 'per-run-cost-cap'
  | 'total-cost-cap'
  | 'cost-unreported';

/** Result of folding one observation into the tracker. */
export interface BudgetDecision {
  readonly allowed: boolean;
  readonly reason: BudgetStopReason | undefined;
  readonly detail: string;
}

/** Settings for a tracked run. */
export interface BudgetSettings {
  /** Cap for one arm run, or `undefined` for no per-run cap. */
  readonly maxUnitsPerRun: number | undefined;
  /** Cap for the whole run, or `undefined` for no cumulative cap. */
  readonly maxTotalUnits: number | undefined;
  /** Spending cap for one arm run in reported USD, or `undefined` for none. */
  readonly maxCostUsdPerRun: number | undefined;
  /** Cumulative spending cap in reported USD, or `undefined` for none. */
  readonly maxCostUsd: number | undefined;
}

/** What a tracker has observed so far. */
export interface BudgetState {
  readonly runs: number;
  /** Sum of the conservative units of every observed run. */
  readonly spentUnits: number;
  /** Units of the most recent run. */
  readonly lastRunUnits: number;
  /** Runs whose host reported no token field at all. */
  readonly runsWithoutReportedUsage: number;
  /** Sum of the reported cost of every run that reported one. */
  readonly spentCostUsd: number;
  /** Reported cost of the most recent run, or `0` when it reported none. */
  readonly lastRunCostUsd: number;
  /** Runs whose host reported no cost at all. */
  readonly runsWithoutReportedCost: number;
}

/**
 * Conservative accounting units for one run: every reported token field added
 * together.
 *
 * Reported fields only. An absent field contributes nothing (it is not zero), and a
 * run with no reported field at all counts as zero units — which is why
 * {@link BudgetState.runsWithoutReportedUsage} exists: a run that reported nothing may
 * still have cost money, and the report says so instead of implying it was free.
 */
export function conservativeTokenUnits(observation: Level2ArmObservation): number {
  const { usage } = observation;
  const fields = [
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ];
  let total = 0;
  let reported = 0;
  for (const value of fields) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      total += value;
      reported += 1;
    }
  }
  return reported === 0 ? 0 : total;
}

/** True when the host reported no token field at all for this run. */
export function hasNoReportedUsage(observation: Level2ArmObservation): boolean {
  const { usage } = observation;
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].every((value) => typeof value !== 'number');
}

/**
 * The cost the provider reported for one run, or `undefined` when it reported none.
 *
 * A reported `0` is returned as `0`: a free model is a measured free model, not a
 * missing measurement, and the two must not be conflated by a spending cap.
 */
export function reportedCostUsd(observation: Level2ArmObservation): number | undefined {
  const { costUsd } = observation.usage;
  return typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0
    ? costUsd
    : undefined;
}

/**
 * A tracker for one run's caps.
 *
 * `observe` is called **after** each session and answers whether another one may
 * start. The spending caps are checked first, because money is the bound that cannot
 * be recovered, then the unit caps.
 */
export function createBudgetTracker(settings: BudgetSettings): {
  readonly observe: (observation: Level2ArmObservation) => BudgetDecision;
  readonly state: () => BudgetState;
  readonly describe: () => string;
} {
  const costCapped = settings.maxCostUsd !== undefined || settings.maxCostUsdPerRun !== undefined;
  let runs = 0;
  let spentUnits = 0;
  let lastRunUnits = 0;
  let runsWithoutReportedUsage = 0;
  let spentCostUsd = 0;
  let lastRunCostUsd = 0;
  let runsWithoutReportedCost = 0;

  return {
    observe(observation: Level2ArmObservation): BudgetDecision {
      runs += 1;
      lastRunUnits = conservativeTokenUnits(observation);
      spentUnits += lastRunUnits;
      if (hasNoReportedUsage(observation)) {
        runsWithoutReportedUsage += 1;
      }

      const cost = reportedCostUsd(observation);
      lastRunCostUsd = cost ?? 0;
      if (cost === undefined) {
        runsWithoutReportedCost += 1;
      } else {
        spentCostUsd += cost;
      }

      if (costCapped && cost === undefined) {
        return {
          allowed: false,
          reason: 'cost-unreported',
          detail: `the run ${observation.identity.runId} reported no cost, so a spending cap cannot bound it; stopping rather than continuing unmeasured`,
        };
      }
      if (settings.maxCostUsdPerRun !== undefined && cost !== undefined && cost > settings.maxCostUsdPerRun) {
        return {
          allowed: false,
          reason: 'per-run-cost-cap',
          detail: `the run ${observation.identity.runId} reported $${cost.toFixed(4)}, above the per-session spending cap of $${settings.maxCostUsdPerRun.toFixed(2)}`,
        };
      }
      if (settings.maxCostUsd !== undefined && spentCostUsd > settings.maxCostUsd) {
        return {
          allowed: false,
          reason: 'total-cost-cap',
          detail: `the run has reported $${spentCostUsd.toFixed(4)} in total, above the spending cap of $${settings.maxCostUsd.toFixed(2)}`,
        };
      }

      if (settings.maxUnitsPerRun !== undefined && lastRunUnits > settings.maxUnitsPerRun) {
        return {
          allowed: false,
          reason: 'per-run-cap',
          detail: `the run ${observation.identity.runId} reported ${lastRunUnits} unit(s), above the per-session cap of ${settings.maxUnitsPerRun}`,
        };
      }
      if (settings.maxTotalUnits !== undefined && spentUnits > settings.maxTotalUnits) {
        return {
          allowed: false,
          reason: 'total-cap',
          detail: `the run has reported ${spentUnits} unit(s) in total, above the cap of ${settings.maxTotalUnits}`,
        };
      }
      return { allowed: true, reason: undefined, detail: '' };
    },
    state(): BudgetState {
      return {
        runs,
        spentUnits,
        lastRunUnits,
        runsWithoutReportedUsage,
        spentCostUsd,
        lastRunCostUsd,
        runsWithoutReportedCost,
      };
    },
    describe(): string {
      const perRun =
        settings.maxUnitsPerRun === undefined ? 'none' : String(settings.maxUnitsPerRun);
      const total =
        settings.maxTotalUnits === undefined ? 'none' : String(settings.maxTotalUnits);
      const perRunCost =
        settings.maxCostUsdPerRun === undefined
          ? 'none'
          : `$${settings.maxCostUsdPerRun.toFixed(2)}`;
      const totalCost = settings.maxCostUsd === undefined ? 'none' : `$${settings.maxCostUsd.toFixed(2)}`;
      return `caps: per-session ${perRun} unit(s) / ${perRunCost}, total ${total} unit(s) / ${totalCost}; units add every reported token field together and are an accounting bound, never a reported measurement; a session that reports no cost stops the run while a spending cap is set`;
    },
  };
}
