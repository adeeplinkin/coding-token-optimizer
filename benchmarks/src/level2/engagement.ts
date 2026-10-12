/**
 * Whether a **live** arm run measured this harness at all.
 *
 * A live session can end with an artifact that looks perfectly well-formed while
 * carrying no evidence that the repository-local plugin ever reached the runtime. That
 * is not a hypothetical: Stage 1U's pilot ran every session in a runtime that could not
 * offer the model at all, and a session whose plugin never loads produces the same
 * shape — an artifact, an observation, and `usage: unavailable` — which the report
 * would otherwise publish as a "no-opportunity" treatment run. A canary whose only job
 * is to prove the live path must be able to fail on that, rather than file it.
 *
 * The check therefore reads only things that cannot exist without the plugin:
 *
 * - **`wire.hookInvocations`** is the length of the wire probe's own log. The probe is a
 *   second repository-local plugin, and it appends one line per outbound request it is
 *   handed. Zero invocations across a completed session means the plugin layer never
 *   ran (or the session never asked the model for anything).
 * - **`apply`** is the observer's Safe Mode counter block, present only when a plugin
 *   that was told to apply actually observed. Its presence in the control arm, or its
 *   absence in the treatment arm, means the two arms are not the declared pair.
 *
 * It is deliberately *not* a quality check: a run that engages the harness completely can
 * still fail the task, and that is reported as a coding failure and nothing else.
 */
import type { Level2ArmObservation } from './types.js';

/** Verdict for one live arm run. */
export interface LiveEngagementVerdict {
  readonly measurable: boolean;
  /**
   * True when the problem makes the run meaningless rather than merely unsuccessful, so
   * the plan must stop instead of repeating the session.
   *
   * Repeating it could not help: the environment is what it is, and each attempt costs
   * money to learn the same thing.
   */
  readonly stop: boolean;
  readonly detail: string;
}

/** Preconditions a caller can add to the engagement check. */
export interface LiveEngagementRequirements {
  /**
   * True when this run was configured with a per-session spending cap on a runtime where an
   * in-session stop is possible. The observation must then show the governor armed: an
   * unarmed governor means the authorized cap was not the bound that was in force, which is
   * a safety failure rather than a measurement to compare.
   */
  readonly requireInSessionGovernor?: boolean;
  /**
   * True when this run must be able to show the **native permission layer** was resolved.
   *
   * Containment has two layers: the plugin guard (whose enforcement the harness proves against
   * the installed runtime) and the runtime's own permission policy. The guest's own event stream
   * does not carry the session's permission rules in the pinned runtime, so the second layer is
   * evidenced by asking the runtime for its resolved rules before a session starts. A live run
   * whose runtime did not report them is refused rather than compared: with the native layer
   * unobserved, only half of containment is evidenced.
   */
  readonly requireNativePermissions?: boolean;
}

/**
 * Read one live arm observation for evidence that the harness was engaged.
 *
 * The caller must treat `measurable: false` as a failed run, and `stop: true` as a
 * reason to end the plan rather than retry.
 */
export function checkLiveEngagement(
  observation: Level2ArmObservation,
  requirements: LiveEngagementRequirements = {},
): LiveEngagementVerdict {
  const arm = observation.identity.arm;
  const requests = observation.wire.hookInvocations;

  if (requests === 0) {
    return {
      measurable: false,
      stop: true,
      detail:
        `the ${arm} arm produced no outbound request the plugin could see, so the ` +
        'repository-local plugins did not reach the runtime (or the session never called the ' +
        'model). Nothing about the harness was measured, and repeating it would spend ' +
        'authorization to learn the same thing.',
    };
  }

  // Containment is a precondition, not a bonus: a session whose guard never
  // registered ran with its tools unenforced, so whatever it measured is not the
  // harness this experiment declares. It is checked before the arm-pair checks
  // because it applies to both arms identically.
  const containment = observation.containment;
  if (containment === undefined) {
    return {
      measurable: false,
      stop: true,
      detail:
        'the session artifact carries no containment evidence, so nothing shows its tools stayed inside the workspace; ' +
        'a live run is refused rather than treated as a valid measurement.',
    };
  }
  if (containment.guard !== 'loaded') {
    return {
      measurable: false,
      stop: true,
      detail:
        `the containment guard did not register its tool hook (${containment.guard}), so this session ran without the ` +
        'enforcement layer; repeating it would spend authorization to learn the same thing, so the plan stops.',
    };
  }
  if (!containment.rootKnown) {
    return {
      measurable: false,
      stop: true,
      detail:
        'the containment guard could not determine the session workspace, so no tool call was checked and the session ' +
        'cannot be treated as a valid measurement.',
    };
  }

  // The pre-transmission model guard, checked for the same reason as containment and with the same
  // severity: it is the only layer that can stop a request that does not belong to the approved
  // envelope, and a session where it did not register would have sent one. An attempted refusal is
  // its own failure — the request never left the process, but the session is no longer the free-only
  // session the experiment declares.
  const modelGuard = observation.modelGuard;
  if (modelGuard === undefined) {
    return {
      measurable: false,
      stop: true,
      detail:
        'the session artifact carries no pre-transmission model-guard evidence, so nothing shows an unapproved model request would have been refused before it was sent; ' +
        'a live run is refused rather than treated as bounded because it did not say otherwise.',
    };
  }
  if (modelGuard.guard !== 'loaded') {
    return {
      measurable: false,
      stop: true,
      detail:
        `the pre-transmission model guard did not register the request hook (${modelGuard.guard}), so this session would have sent a request naming any model of an allowed provider; ` +
        'repeating it would spend authorization to learn the same thing, so the plan stops.',
    };
  }
  if (modelGuard.refused > 0) {
    const detail = modelGuard.refusals
      .map(
        (entry) =>
          `${entry.reason}${entry.requestKind === undefined ? '' : `@${entry.requestKind}`}${entry.model === undefined ? '' : `[${entry.model}]`}`,
      )
      .join(', ');
    return {
      measurable: false,
      stop: true,
      detail:
        `the model guard refused ${String(modelGuard.refused)} request(s) outside the approved envelope (${detail || 'reason unrecorded'}): the request never reached a provider, but this session is not the free-only session the experiment declares.`,
    };
  }

  // Defence in depth for the in-session cap. The arm driver already refuses to start a
  // capped live session whose governor cannot arm; this is the same rule applied to what the
  // session reports, so a build that armed and then lost the governor is refused too.
  if (requirements.requireNativePermissions === true) {
    const native = observation.nativePermissions;
    if (native === undefined) {
      return {
        measurable: false,
        stop: true,
        detail:
          'the session artifact carries no evidence of the native permission layer, so only the plugin guard was evidenced; ' +
          'a live run is refused rather than compared with half of containment unobserved.',
      };
    }
    if (!native.observed) {
      return {
        measurable: false,
        stop: true,
        detail:
          `the runtime did not report the permission rules it resolved for this repository (${native.error ?? 'no reason recorded'}); ` +
          'with the native layer unobserved, containment rests on the plugin guard alone.',
      };
    }
    if (native.missingRequiredDenies.length > 0 || !native.allRequiredPresent) {
      return {
        measurable: false,
        stop: true,
        detail:
          `the runtime resolved ${String(native.rules.length)} permission rule(s) but not every deny this policy requires ` +
          `(missing: ${native.missingRequiredDenies.join(', ') || 'unrecorded'}); the session ran with part of containment unenforced.`,
      };
    }
  }

  if (requirements.requireInSessionGovernor === true && observation.inSessionGovernor?.armed !== true) {
    const governor = observation.inSessionGovernor;
    return {
      measurable: false,
      stop: true,
      detail:
        'the session was authorized with a per-session spending cap, but the in-session governor did not enforce it ' +
        `(${governor === undefined ? 'no governor evidence was recorded' : `armed: false, ${governor.reason ?? 'no reason recorded'}`}), so the cost bound that was authorized was not in force; ` +
        'the run is refused rather than compared as if it had been capped.',
    };
  }

  if (arm === 'treatment' && observation.apply === undefined) {
    return {
      measurable: false,
      stop: true,
      detail:
        'the treatment session was observed but recorded no Safe Mode apply counters, so the ' +
        'arm switch never reached the plugin and the pair would compare the pass off against the ' +
        'pass off.',
    };
  }

  if (arm === 'control' && observation.apply !== undefined) {
    return {
      measurable: false,
      stop: true,
      detail:
        'the control session recorded Safe Mode apply counters, so the arms are not the declared ' +
        'pair: the pass was on in both.',
    };
  }

  return {
    measurable: true,
    stop: false,
    detail:
      `the harness was engaged for the ${arm} arm: ${String(requests)} outbound request(s) reached ` +
      `the plugin${arm === 'treatment' ? ` and the pass attempted ${String(observation.apply?.requestsAttempted ?? 0)} of them` : ' with the pass off'}, ` +
      `the containment guard registered its tool hook (${containment.blockedCalls} call(s) refused, ${containment.allowedCalls} checked and allowed), ` +
      `and the pre-transmission model guard registered its request hook and refused nothing across ${String(modelGuard.invocations)} request(s).`,
  };
}
