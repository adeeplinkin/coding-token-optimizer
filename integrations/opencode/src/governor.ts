/**
 * The in-session cost governor for a harness-run live session (Stage 1V).
 *
 * ## Why this exists
 *
 * Post-session caps can only stop the *next* session: a session that spends more
 * than its cap does so before anyone can read the number. The runtime's own
 * `session.interrupt` operation is the one native control that stops a session
 * **while it is running**, so the harness runs a small supervisor beside the
 * session: it reads the cost the runtime reports (through the observer's summary,
 * which is written per model step), and when the reported cost crosses the
 * per-session cap it calls the native interrupt.
 *
 * ## What it can and cannot bound
 *
 * It is an *in-session* stop, which the post-session caps are not — but it is not
 * instantaneous: between the moment the cost crosses the cap and the moment the
 * interrupt lands, at most one more model step is billed (the poll interval plus
 * the interrupt's own latency). That overshoot is bounded by a model step, not by
 * the cap, which is why the caps are also checked after the session and the
 * wall-clock timeout remains the ultimate per-session stop.
 *
 * The decision logic here is pure: the driver does the reading, spawning and
 * killing, and this module answers only "what should happen next".
 */

/** How many interrupt attempts a governor makes before it gives up and kills the run. */
export const MAX_INTERRUPT_ATTEMPTS = 2;

/**
 * Which of the governor's helpers the caller's plugin build actually exposes.
 *
 * The arm driver imports the built module and picks helpers by name, so a build that
 * exports only *some* of them is a real state: it would arm the governor and then
 * throw when it reached the missing one. Stage 1V hit exactly that — the driver picked
 * `decideCostGovernor` but not `startCostGovernor`, so it entered the armed branch and
 * crashed before the session started, leaving the spending cap unenforced.
 */
export interface GovernorHelperAvailability {
  /** `decideCostGovernor` is present. */
  readonly decide: boolean;
  /** `latestSessionCostUsd` is present. */
  readonly latest: boolean;
  /** `startCostGovernor` is present (the loop itself). */
  readonly start: boolean;
}

/** Inputs for {@link planGovernorArming}. */
export interface GovernorArmingInput {
  /** The driver mode: `live`, `rehearse` or `preflight`. */
  readonly mode: string;
  /** The runtime that would carry the session: `service` or `standalone`. */
  readonly runtime: string;
  /** The per-session spending cap, when one was configured. */
  readonly capUsd: number | undefined;
  readonly helpers: GovernorHelperAvailability;
}

/** What the driver should do about the in-session governor. */
export interface GovernorArmingPlan {
  /**
   * True when a session with a spending cap is about to run, so not arming is a
   * safety failure the caller must refuse rather than record and continue.
   */
  readonly required: boolean;
  /** True when the driver should start the supervisor loop. */
  readonly armed: boolean;
  /** Why the governor is not armed; `undefined` when it is. */
  readonly reason: string | undefined;
}

/** Names of the helpers a build is missing, for a content-free reason string. */
export function missingGovernorHelpers(helpers: GovernorHelperAvailability): readonly string[] {
  const missing: string[] = [];
  if (!helpers.decide) missing.push('decideCostGovernor');
  if (!helpers.latest) missing.push('latestSessionCostUsd');
  if (!helpers.start) missing.push('startCostGovernor');
  return missing;
}

/**
 * Decide whether the in-session governor must, can and will arm before a session starts.
 *
 * This is the check that has to happen **before** a live model process is spawned. It is
 * deliberately pure: the driver passes in what mode it is running, which runtime carries
 * the session, the cap it was given, and which helpers its imported build exposes, and
 * gets back a decision it can act on without touching the runtime.
 *
 * Three cases, and each one is a different answer:
 *
 * - **live + service + a cap** — the cap *must* be enforceable, so `required` is true and
 *   the caller aborts the run when `armed` is false. A live capped session with no
 *   in-session bound is exactly the state the authorization forbids.
 * - **rehearse** — nothing is billed, but the *initialisation path* is the one a live run
 *   uses, so the supervisor is armed whenever the helpers are present. That is what makes
 *   a wiring regression (the Stage 1V `startCostGovernor` crash) fail at zero cost instead
 *   of on a paid canary.
 * - **live + standalone** and **preflight** — no in-session bound is claimed: the private
 *   server belongs to the run process, and a preflight starts no session at all.
 */
export function planGovernorArming(input: GovernorArmingInput): GovernorArmingPlan {
  const helpersReady =
    input.helpers.decide === true && input.helpers.latest === true && input.helpers.start === true;
  const missing = missingGovernorHelpers(input.helpers).join(', ');

  if (input.mode === 'preflight') {
    return { required: false, armed: false, reason: 'no session is started in preflight mode' };
  }

  if (input.mode === 'rehearse') {
    return helpersReady
      ? { required: false, armed: true, reason: undefined }
      : {
          required: false,
          armed: false,
          reason: `the built plugin module does not export the governor helpers (missing: ${missing})`,
        };
  }

  if (input.mode !== 'live') {
    return { required: false, armed: false, reason: 'not a live session' };
  }

  if (input.runtime !== 'service') {
    return {
      required: false,
      armed: false,
      reason:
        'the private server belongs to this run process; the native interrupt targets the background service',
    };
  }

  const capped =
    typeof input.capUsd === 'number' && Number.isFinite(input.capUsd) && input.capUsd > 0;
  if (!capped) {
    return { required: false, armed: false, reason: 'no per-session spending cap was configured' };
  }

  return helpersReady
    ? { required: true, armed: true, reason: undefined }
    : {
        required: true,
        armed: false,
        reason: `the built plugin module does not export the governor helpers (missing: ${missing})`,
      };
}

/** What the governor should do on this poll. */
export type CostGovernorAction =
  /** Nothing to do: no reported cost yet, already interrupted, or still under the cap. */
  | 'wait'
  /** The reported cost crossed the cap: call the runtime's native interrupt. */
  | 'interrupt'
  /** The interrupt failed repeatedly: stop the client process instead. */
  | 'give-up';

/** Inputs for one poll. Everything the governor knows, and nothing more. */
export interface CostGovernorInput {
  /** The per-session spending cap in reported USD. */
  readonly capUsd: number;
  /** The latest cumulative cost the runtime reported for this session, if any. */
  readonly costUsd: number | undefined;
  /** True once the runtime confirmed an interrupt (`{ interrupted: true }`). */
  readonly interrupted: boolean;
  /** Interrupt attempts that did not confirm, so far. */
  readonly failedAttempts: number;
}

/**
 * Decide the next action.
 *
 * `costUsd === undefined` waits: an unreported cost is not a zero, and interrupting
 * a session for spending nothing measured would be wrong. What happens when the
 * cost *stays* unreported is the harness's problem (the post-session tracker fails
 * closed on it); the governor does not invent a number.
 */
export function decideCostGovernor(input: CostGovernorInput): CostGovernorAction {
  if (input.interrupted) {
    return 'wait';
  }
  if (input.costUsd === undefined || !Number.isFinite(input.costUsd)) {
    return 'wait';
  }
  if (input.costUsd < input.capUsd) {
    return 'wait';
  }
  return input.failedAttempts >= MAX_INTERRUPT_ATTEMPTS ? 'give-up' : 'interrupt';
}

/** The summary line shape the governor reads, as a structural subset. */
type SummaryLine = Record<string, unknown>;

function isRecord(value: unknown): value is SummaryLine {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The latest cumulative cost one session's summary lines report.
 *
 * Prefers the host's own `session.usage.updated` series (`usage.sourceReported.latest.cost`),
 * and falls back to the observer's per-message aggregate (`measurements.cost`) only
 * when that measurement is labelled `measured` or `calculated` — the same evidence
 * rules the artifact uses. Lines for other sessions are ignored, and the last
 * matching line wins because the summary is append-only and cumulative.
 */
/** The governor's running state, for the arm artifact. */
export interface CostGovernorState {
  readonly polls: number;
  /** The latest cumulative cost the governor saw, or `undefined` if none was reported. */
  readonly reportedCostUsd: number | undefined;
  readonly interruptAttempts: number;
  readonly interrupted: boolean;
  readonly killedAfterFailedInterrupt: boolean;
  readonly stopped: boolean;
}

/** Inputs for {@link startCostGovernor}, all injectable so the loop is testable. */
export interface CostGovernorOptions {
  /** The per-session spending cap in reported USD. */
  readonly capUsd: number;
  /** Poll interval in milliseconds; the driver uses 1500. */
  readonly intervalMs?: number;
  /** Latest cumulative reported cost for the session, read fresh each poll. */
  readonly readCostUsd: () => number | undefined;
  /** Attempt the runtime's native interrupt; true only when it was confirmed. */
  readonly interrupt: () => boolean;
  /** Called once when repeated interrupts will not confirm: stop the client process. */
  readonly abandon: () => void;
}

/** A running supervisor. `stop` is idempotent; `state` remains readable afterwards. */
export interface CostGovernor {
  readonly stop: () => void;
  readonly state: () => CostGovernorState;
}

/**
 * Start the supervisor loop.
 *
 * Every poll reads the latest reported cost and asks {@link decideCostGovernor} what to
 * do. On `interrupt` it calls the driver's native-interrupt attempt; on `give-up` it
 * asks the driver to abandon the client process instead. All three callbacks are
 * injected, so this loop is unit-testable without a runtime, and every failure inside
 * it is swallowed into the state rather than thrown at the session it supervises.
 */
export function startCostGovernor(options: CostGovernorOptions): CostGovernor {
  const interval = typeof options.intervalMs === 'number' && options.intervalMs > 0 ? options.intervalMs : 1500;
  let polls = 0;
  let reportedCostUsd: number | undefined;
  let interruptAttempts = 0;
  let interrupted = false;
  let killedAfterFailedInterrupt = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (!stopped) {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
    }
  };

  const poll = (): void => {
    try {
      polls += 1;
      const cost = options.readCostUsd();
      if (typeof cost === 'number' && Number.isFinite(cost)) {
        reportedCostUsd = cost;
      }
      const action = decideCostGovernor({
        capUsd: options.capUsd,
        costUsd: cost,
        interrupted,
        failedAttempts: interruptAttempts,
      });
      if (action === 'interrupt') {
        interruptAttempts += 1;
        if (options.interrupt()) {
          interrupted = true;
          stop();
        }
      } else if (action === 'give-up') {
        killedAfterFailedInterrupt = true;
        stop();
        try {
          options.abandon();
        } catch {
          // Best effort: the caller's wall-clock timeout still applies.
        }
      }
    } catch {
      // A governor failure must never disturb the session it supervises.
    }
  };

  timer = setInterval(poll, interval);

  return {
    stop,
    state: () => ({
      polls,
      reportedCostUsd,
      interruptAttempts,
      interrupted,
      killedAfterFailedInterrupt,
      stopped,
    }),
  };
}

export function latestSessionCostUsd(
  lines: readonly unknown[],
  sessionId: string | undefined,
): number | undefined {
  const matching: SummaryLine[] = [];
  for (const line of lines) {
    if (isRecord(line) && (sessionId === undefined || line['sessionId'] === sessionId)) {
      matching.push(line);
    }
  }
  let latest: number | undefined;
  for (const line of matching) {
    const usage = isRecord(line['usage']) ? line['usage'] : undefined;
    const sourceReported = usage !== undefined && isRecord(usage['sourceReported']) ? usage['sourceReported'] : undefined;
    const latestReport = sourceReported !== undefined && isRecord(sourceReported['latest']) ? sourceReported['latest'] : undefined;
    const direct = latestReport === undefined ? undefined : numberAt(latestReport['cost']);
    if (direct !== undefined) {
      latest = direct;
      continue;
    }
    const measurements = isRecord(line['measurements']) ? line['measurements'] : undefined;
    const costMeasurement = measurements === undefined ? undefined : measurements['cost'];
    if (isRecord(costMeasurement)) {
      const evidence = costMeasurement['evidence'];
      if (evidence === 'measured' || evidence === 'calculated') {
        const value = numberAt(costMeasurement['value']);
        if (value !== undefined) {
          latest = value;
        }
      }
    }
  }
  return latest;
}
