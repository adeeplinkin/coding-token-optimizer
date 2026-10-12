/**
 * Evidence intake for one arm run: may this driver output be treated as a measurement?
 *
 * The arm driver is a separate process, and its output is untrusted input. Three ways a
 * run can produce something that *looks* like a measurement while being no measurement at
 * all were all observed in practice, so each is a named, fatal rejection here rather than
 * a note that travels beside an accepted artifact:
 *
 * 1. **The driver crashed.** Stage 1V's canary died on a wiring bug before any session
 *    started, and the run was still reported with a full observation — because a non-zero
 *    exit was recorded as a problem and an artifact (from an earlier run) was read anyway.
 *    A non-zero exit now ends the run.
 * 2. **The artifact is stale.** The workspace path is reused across runs, so a file left by
 *    an earlier run sits at exactly the path this run will be read from. Each run now carries
 *    a nonce that the driver stamps into its artifact, and the intake requires that nonce to
 *    match — an artifact this run did not write can never be accepted, whatever it says.
 * 3. **The artifact is partial.** A truncated write can still be valid JSON if it is cut
 *    after a complete prefix, so the driver writes `complete: true` in its final statement
 *    and the intake requires it.
 * 4. **The session never completed.** The driver exits 0 whenever it managed to write a whole
 *    artifact, so a session the runtime killed, that crashed, or that was cut off by the
 *    wall-clock bound still arrives here as a well-formed file. Its counters describe a
 *    partial session, and the artifact itself carries the outcome, so
 *    {@link checkSessionCompletion} refuses it by name rather than letting the run
 *    contribute to a distribution.
 * 5. **The artifact is another mode's run.** A rehearsal drives the same driver, the same plugins
 *    and the same artifact shape as a live session; only its provider is a script. Its counts are
 *    plumbing evidence and must never be read as a measurement, so a caller that knows which mode
 *    it started passes `expectedMode` and the declared mode has to match.
 *
 * The split matters: {@link checkArmArtifactProvenance} answers "is this file this run's own
 * whole output from a session that finished?", which must be decided **before** grading is
 * attempted. Only then does {@link intakeArmEvidence} add the shape and identity checks of
 * {@link readArmArtifact}, which need the grading result merged in first.
 */
import { readArmArtifact } from './observation.js';
import { FREE_ONLY_PRIMARY_MODEL, isFreeOnlyModelConfig, isZeroPriceRow } from './free-model-policy.js';
import type { Level2Arm, Level2ArmObservation } from './types.js';

/**
 * Why a run produced no usable measurement.
 *
 * Each value is a distinct operational fact, because they need different responses: a crash
 * needs a fix, a stale artifact needs a clean workspace, a refused model needs an
 * environment, and a partial file needs a look at the disk.
 */
export type ArmInvalidReason =
  /** The driver exited non-zero: it did not complete, so it measured nothing. */
  | 'driver-exit-nonzero'
  /** An artifact already existed at this path before the run: the workspace was not fresh. */
  | 'artifact-preexisting'
  /** No artifact was written at all. */
  | 'artifact-missing'
  /** The artifact could not be parsed as JSON. */
  | 'artifact-unreadable'
  /** The artifact parsed but is not marked complete, so it is a partial write. */
  | 'artifact-incomplete'
  /** The artifact carries a different run identity, so it is another run's output. */
  | 'artifact-foreign'
  /** The artifact is this run's, but its contents fail the observation contract. */
  | 'artifact-invalid'
  /** The artifact declares a different run mode, so it is not the run that was asked for. */
  | 'mode-mismatch'
  /** The session's runtime process ended non-zero: the arm did not run to completion. */
  | 'session-exit-nonzero'
  /** The wall-clock bound stopped the session, so what it measured is a partial run. */
  | 'session-timed-out'
  /** The artifact does not state that the session completed, so completion cannot be claimed. */
  | 'session-outcome-unrecorded'
  /** The runtime refused the model, so no request was ever composed. */
  | 'model-unavailable'
  /** The run's free-only model policy is absent or does not hold, so the envelope is unverified. */
  | 'model-policy-unverified'
  /**
   * The run cannot show that a model request outside the approved envelope would have been stopped
   * before it was sent. Distinct from `model-policy-unverified`, which is about whether the run was
   * *configured* free: this one is about whether the configuration was *enforced* on the wire.
   */
  | 'model-guard-unverified';

/** What the caller knows about one arm run before its artifact is interpreted. */
export interface ArmProvenanceInput {
  /** The driver process's exit code, or `undefined` when it never started. */
  readonly driverExitCode: number | undefined;
  /**
   * True when an artifact already existed at the artifact path before this run started.
   *
   * Not by itself fatal — the run may legitimately overwrite it — but it is the condition
   * under which a stale read happened, so it is reported and the nonce check is what
   * actually decides.
   */
  readonly artifactPreexisting: boolean;
  /** The artifact's text as read after the run, or `undefined` when it is absent. */
  readonly artifactText: string | undefined;
  /** The nonce this run generated and passed to the driver. */
  readonly expectedRunNonce: string;
  /**
   * The mode this run was started in, when the caller knows it.
   *
   * A rehearsal drives the same driver, the same plugins and the same artifact shape as a live
   * session; the only difference is that its provider is a loopback script and its token counts
   * are the script's, so an artifact from one must never be read as a live measurement. Checking
   * the declared mode is what makes that a rule rather than an assumption about which run wrote
   * the file the path happens to hold.
   */
  readonly expectedMode?: 'live' | 'rehearse';
}

/** The provenance gate's verdict. `parsed` is present only when the gate opened. */
export interface ArmProvenanceVerdict {
  readonly ok: boolean;
  readonly invalidReason: ArmInvalidReason | undefined;
  readonly problems: readonly string[];
  /** The parsed artifact object, present exactly when `ok` is true. */
  readonly parsed: Record<string, unknown> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The session-completion gate's verdict. */
export interface SessionCompletionVerdict {
  readonly ok: boolean;
  readonly invalidReason: ArmInvalidReason | undefined;
  readonly problem: string | undefined;
}

/**
 * Decide whether the artifact describes a session that ran to completion.
 *
 * This is the check the driver's own exit code cannot make. The driver exits 0 as soon as it
 * has written a whole artifact, which is the right contract for a *process* — the evidence a
 * failed session left behind must survive — but it means a session that crashed, was killed, or
 * hit the wall-clock bound still arrives here looking complete. Every counter in such an
 * artifact describes a partial session, so the run cannot enter a distribution; the artifact
 * records the outcome (`exitCode`, `timedOut`, `sessionCleanExit`) precisely so this can be
 * decided rather than inferred from an absence of evidence.
 *
 * The runtime's model refusal is deliberately *not* decided here: the intake's own
 * `model-unavailable` rule reports it later with the detail it deserves (an environment to fix,
 * not a run that went wrong), and the driver may legitimately record it from a process that
 * exited non-zero. Deferring keeps that distinction intact instead of relabelling it.
 */
export function checkSessionCompletion(
  artifact: Record<string, unknown>,
): SessionCompletionVerdict {
  if (artifact['modelUnavailable'] === true) {
    return { ok: true, invalidReason: undefined, problem: undefined };
  }

  if (artifact['timedOut'] === true) {
    return {
      ok: false,
      invalidReason: 'session-timed-out',
      problem:
        'The session was stopped by the wall-clock bound, so it is a partial run: its counters describe the part that had time to happen, not the arm.',
    };
  }

  const exitCode = artifact['exitCode'];
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) {
    return {
      ok: false,
      invalidReason: 'session-outcome-unrecorded',
      problem:
        'The artifact does not record how the session process ended, so a completed session cannot be claimed and this run is not a measurement.',
    };
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      invalidReason: 'session-exit-nonzero',
      problem: `The session process exited with code ${String(exitCode)}, so the arm did not run to completion and this run is not a measurement of the harness.`,
    };
  }

  if (artifact['sessionCleanExit'] !== true) {
    return {
      ok: false,
      invalidReason: 'session-outcome-unrecorded',
      problem:
        'The artifact does not affirm a clean session exit, so it does not show that the arm ran to completion and it is not a measurement.',
    };
  }

  return { ok: true, invalidReason: undefined, problem: undefined };
}

/**
 * The free-only policy gate's verdict.
 */
export interface FreeOnlyPolicyVerdict {
  readonly ok: boolean;
  readonly invalidReason: ArmInvalidReason | undefined;
  readonly problem: string | undefined;
}

/**
 * Decide whether a run's artifact shows it stayed inside the approved free-only envelope.
 *
 * This is the *fifth* way a run can look like a measurement while not being one, and it is the
 * one a token comparison cannot detect from the inside: a session that ran on a paid model, or
 * on a model whose price the runtime cannot price at all, produces perfectly ordinary numbers.
 * The artifact therefore has to carry the policy it ran under, and this gate refuses a run
 * whose policy is missing, whose configuration is not the approved one, whose pre-spawn price
 * verification did not happen (in a mode that spends), or that composed an auxiliary request.
 *
 * The mode matters for exactly one clause. A rehearsal spends nothing and its isolated
 * environment holds no account catalogue, so it legitimately records *why* no price check was
 * made; a live run has no such excuse and must show a verified-zero price row.
 */
export function checkFreeOnlyPolicy(
  artifact: Record<string, unknown>,
): FreeOnlyPolicyVerdict {
  const reject = (problem: string): FreeOnlyPolicyVerdict => ({
    ok: false,
    invalidReason: 'model-policy-unverified',
    problem,
  });
  const record = artifact['modelPolicy'];
  if (!isRecord(record)) {
    return reject(
      'The arm artifact carries no free-only model policy, so the approved envelope this run was supposed to stay inside cannot be read from the run itself.',
    );
  }
  const config = record['config'];
  if (record['configAccepted'] !== true || !isFreeOnlyModelConfig(config)) {
    return reject(
      'The arm artifact\u2019s recorded configuration is not the approved free-only configuration (primary model, auxiliary model, provider restriction, disabled compaction), so this run is not a measurement under the benchmark\u2019s model policy.',
    );
  }
  const primary = record['primaryModel'];
  if (primary !== FREE_ONLY_PRIMARY_MODEL) {
    return reject(
      `The arm artifact names \`${String(primary ?? 'none')}\` as its primary model rather than the approved \`${FREE_ONLY_PRIMARY_MODEL}\`, so the run is not attributable to an approved free model.`,
    );
  }
  const refusals = Array.isArray(record['refusals'])
    ? record['refusals'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (refusals.length > 0) {
    return reject(
      `The arm artifact records pre-spawn policy refusals (${refusals.join('; ')}), so it must not have started a session.`,
    );
  }
  const mode = artifact['mode'];
  if (mode !== 'rehearse') {
    // The **row** has to be there and has to be zero, tier by tier. The driver's own
    // `priceVerifiedFree` flag is not accepted on its own: a boolean cannot be audited, and a
    // claimed-free run with no row behind it is exactly the artifact a mistake would leave.
    const priceRow = isRecord(record['priceRow']) ? record['priceRow'] : undefined;
    const rowIsZero =
      priceRow !== undefined &&
      isZeroPriceRow({
        input: typeof priceRow['input'] === 'number' ? priceRow['input'] : undefined,
        output: typeof priceRow['output'] === 'number' ? priceRow['output'] : undefined,
        cacheRead: typeof priceRow['cacheRead'] === 'number' ? priceRow['cacheRead'] : undefined,
        cacheWrite: typeof priceRow['cacheWrite'] === 'number' ? priceRow['cacheWrite'] : undefined,
      });
    if (record['priceVerifiedFree'] !== true || !rowIsZero) {
      return reject(
        'The arm artifact does not carry a price row that is explicitly zero in every applicable tier (input, output, cache read, cache write), so this model is not verified free and the run is refused.',
      );
    }
  }
  if (record['titleGenerationSuppressed'] !== true) {
    return reject(
      'The arm artifact does not show that title generation was suppressed, so the session may have composed an auxiliary model request; the run is refused rather than assumed free.',
    );
  }
  const requests = isRecord(record['requests']) ? record['requests'] : undefined;
  const kinds = isRecord(requests?.['kinds']) ? (requests?.['kinds'] as Record<string, unknown>) : {};
  const auxiliary = Object.entries(kinds)
    .filter(([kind]) => kind !== 'primary')
    .reduce((total, [, count]) => total + (typeof count === 'number' ? count : 0), 0);
  if (auxiliary > 0) {
    return reject(
      `The arm artifact records ${String(auxiliary)} non-primary model request(s), so this session composed an auxiliary call and is refused as a free-only measurement.`,
    );
  }
  return { ok: true, invalidReason: undefined, problem: undefined };
}

/**
 * Decide whether a run's artifact shows the **pre-transmission model guard** was in force.
 *
 * The free-only gate above answers "was this run configured inside the envelope?". It cannot answer
 * "would a request that left the envelope have been stopped?", because the configuration it reads is
 * a statement of intent made before the session started. The provider policy that admits `opencode`
 * admits every model that provider offers, free and paid alike, so between the configuration and the
 * wire there is exactly one place an unapproved model could still be requested — and that is what
 * this gate requires evidence for.
 *
 * Two facts, both read from the guard's own record, and the reason each is not optional:
 *
 * - **the hook registered**: the runtime accepted the callback that refuses a request. A plugin that
 *   loaded but whose hook was rejected bounds nothing, and its evidence file looks the same either
 *   way — so `hookRegistered` is required separately from `loaded`;
 * - **nothing was refused**: a refusal means a request outside the envelope was *attempted*. It was
 *   stopped before transmission (that is what the guard does), but the session was not the free-only
 *   session the experiment declares, so its numbers are not comparable with a session that never
 *   tried. The endpoint never saw it, and the run is refused all the same.
 *
 * The envelope is also compared with the free-only configuration's digest: a guard bounding a
 * different policy than the one the run was configured with would be enforcement of the wrong thing.
 */
export function checkModelGuard(artifact: Record<string, unknown>): ModelGuardVerdict {
  const reject = (problem: string): ModelGuardVerdict => ({
    ok: false,
    invalidReason: 'model-guard-unverified',
    problem,
  });
  const record = artifact['modelGuard'];
  if (!isRecord(record)) {
    return reject(
      'The arm artifact carries no pre-transmission model-guard evidence, so nothing shows a request naming a model outside the approved envelope would have been refused before it was sent. The provider policy admits every model of an allowed provider, so a run without this evidence cannot be claimed to be free-only.',
    );
  }
  if (record['loaded'] !== true) {
    return reject(
      'The arm artifact\u2019s model guard never loaded, so no request was checked before transmission and this session cannot be claimed to be free-only.',
    );
  }
  if (record['hookRegistered'] !== true) {
    return reject(
      'The arm artifact\u2019s model guard did not register the request hook the runtime dispatches model requests to, so the runtime accepted no refusal callback for this session: an unapproved model would have been sent.',
    );
  }
  if (record['misconfigured'] === true) {
    return reject(
      'The arm artifact\u2019s model guard was constructed without a usable approved envelope, so it could not have allowed a legitimate request either; the session is not attributable to the declared envelope.',
    );
  }
  const policy = artifact['modelPolicy'];
  const configDigest = isRecord(policy) ? policy['configDigest'] : undefined;
  if (typeof record['policyDigest'] !== 'string' || record['policyDigest'].length === 0) {
    return reject(
      'The arm artifact\u2019s model-guard evidence records no policy digest, so the envelope the guard enforced cannot be compared with the configuration this run received.',
    );
  }
  if (typeof configDigest === 'string' && record['policyDigest'] !== configDigest) {
    return reject(
      `The model guard enforced envelope \`${String(record['policyDigest'])}\` while this run\u2019s free-only configuration digests to \`${configDigest}\`, so the guard bounded a different policy than the one the run was configured with.`,
    );
  }
  const refusals = Array.isArray(record['refusals']) ? record['refusals'] : [];
  const refused = typeof record['refused'] === 'number' ? record['refused'] : 0;
  if (refused > 0 || refusals.length > 0) {
    const detail = refusals
      .flatMap((entry) =>
        isRecord(entry) && typeof entry['reason'] === 'string'
          ? [`${entry['reason']}${typeof entry['requestKind'] === 'string' ? `@${entry['requestKind']}` : ''}${typeof entry['model'] === 'string' ? `[${entry['model']}]` : ''}`]
          : [],
      )
      .join(', ');
    return reject(
      `The session attempted ${String(Math.max(refused, refusals.length))} model request(s) outside the approved envelope (${detail || 'reason unrecorded'}). The guard refused them before transmission, so nothing was sent and nothing was spent — but a session that tried to leave the envelope is not the free-only session this experiment measures, and its numbers are not comparable.`,
    );
  }
  return { ok: true, invalidReason: undefined, problem: undefined };
}

/** The pre-transmission model-guard gate's verdict. */
export interface ModelGuardVerdict {
  readonly ok: boolean;
  readonly invalidReason: ArmInvalidReason | undefined;
  readonly problem: string | undefined;
}

/**
 * Decide whether an artifact file is this run's own, whole output.
 *
 * Order matters. A non-zero exit is checked first because everything downstream (a
 * plausible artifact, a fresh nonce) can be true of a run that still did not complete —
 * and reporting that as valid is the failure this module exists to prevent.
 */
export function checkArmArtifactProvenance(input: ArmProvenanceInput): ArmProvenanceVerdict {
  const problems: string[] = [];
  const reject = (invalidReason: ArmInvalidReason, detail: string): ArmProvenanceVerdict => {
    problems.push(detail);
    return { ok: false, invalidReason, problems, parsed: undefined };
  };

  if (input.artifactPreexisting) {
    problems.push(
      'An artifact already existed at this path before the run (the workspace is reused between runs); it was removed, and the artifact read below must prove by its run identity that it came from this run.',
    );
  }

  if (input.driverExitCode === undefined) {
    return reject(
      'driver-exit-nonzero',
      'The arm driver never started, so this run produced no measurement.',
    );
  }
  if (input.driverExitCode !== 0) {
    return reject(
      'driver-exit-nonzero',
      `The arm driver exited with code ${String(input.driverExitCode)}, so it did not complete and this run produced no measurement (any artifact at this path is not this run's output).`,
    );
  }

  if (input.artifactText === undefined) {
    return reject(
      'artifact-missing',
      'The arm driver exited cleanly but wrote no artifact, so this run produced no measurement.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.artifactText);
  } catch {
    return reject(
      'artifact-unreadable',
      'The arm artifact is not valid JSON, so it was truncated or corrupted and cannot be read as a measurement.',
    );
  }

  if (!isRecord(parsed)) {
    return reject('artifact-invalid', 'The arm artifact is not a JSON object.');
  }

  if (parsed['complete'] !== true) {
    return reject(
      'artifact-incomplete',
      'The arm artifact is not marked complete, so it is a partial write and cannot be read as a measurement.',
    );
  }

  if (parsed['runNonce'] !== input.expectedRunNonce) {
    return reject(
      'artifact-foreign',
      'The arm artifact carries a different run identity than the one this run issued, so it is another run\u2019s output and cannot be read as this run\u2019s measurement.',
    );
  }

  if (input.expectedMode !== undefined && parsed['mode'] !== input.expectedMode) {
    return reject(
      'mode-mismatch',
      `The arm artifact declares mode \`${String(parsed['mode'] ?? 'none')}\` while this run was started in \`${input.expectedMode}\`, so it is not the measurement this run asked for. A rehearsal's token counts come from a script, and plumbing evidence is never a measurement.`,
    );
  }

  // The file is this run's own, whole output. It still has to describe a session that
  // finished: a crashed, killed or timed-out session leaves a complete artifact whose
  // counters describe a partial run.
  const session = checkSessionCompletion(parsed);
  if (!session.ok) {
    problems.push(session.problem ?? 'The session did not run to completion.');
    return { ok: false, invalidReason: session.invalidReason, problems, parsed: undefined };
  }

  // A run that did not stay inside the approved free-only envelope is not a cheaper
  // measurement, it is an unverified one — and its numbers look exactly like a verified
  // run's, which is why this is decided from the artifact rather than from configuration.
  const policy = checkFreeOnlyPolicy(parsed);
  if (!policy.ok) {
    problems.push(policy.problem ?? 'The free-only model policy could not be verified.');
    return { ok: false, invalidReason: policy.invalidReason, problems, parsed: undefined };
  }

  // ...and that the envelope it was configured under was the one *enforced* on the wire. The check
  // above is about intent, this one about the one place an unapproved model could still be asked
  // for after the configuration was written.
  const guard = checkModelGuard(parsed);
  if (!guard.ok) {
    problems.push(guard.problem ?? 'The pre-transmission model guard could not be verified.');
    return { ok: false, invalidReason: guard.invalidReason, problems, parsed: undefined };
  }

  return { ok: true, invalidReason: undefined, problems, parsed };
}

/** Everything the caller knows about one arm run, for a single-call intake. */
export interface ArmEvidenceIntake extends ArmProvenanceInput {
  /** What the plan says this run must be. */
  readonly expected: {
    readonly taskId: string;
    readonly arm: Level2Arm;
    readonly pairIndex: number;
  };
}


/** The intake's verdict. An observation is present only when the run is accepted. */
export interface ArmEvidenceOutcome {
  readonly observation: Level2ArmObservation | undefined;
  /** True only when the run was accepted as a measurement. */
  readonly accepted: boolean;
  /** Present exactly when the run was not accepted. */
  readonly invalidReason: ArmInvalidReason | undefined;
  readonly problems: readonly string[];
  readonly modelUnavailable: boolean;
}

/**
 * Full intake: provenance, then the observation contract.
 *
 * Used where the artifact is complete as written (the driver embeds identity, and grading is
 * merged by the caller before {@link readArmArtifact}). A caller that must grade before it can
 * read should use {@link checkArmArtifactProvenance} first and this shape afterwards.
 */
export function intakeArmEvidence(input: ArmEvidenceIntake): ArmEvidenceOutcome {
  const provenance = checkArmArtifactProvenance(input);
  if (!provenance.ok || provenance.parsed === undefined) {
    return {
      observation: undefined,
      accepted: false,
      invalidReason: provenance.invalidReason,
      problems: provenance.problems,
      modelUnavailable: false,
    };
  }

  const read = readArmArtifact(provenance.parsed, input.expected);
  const problems = [...provenance.problems, ...read.problems];
  if (read.observation === undefined) {
    return {
      observation: undefined,
      accepted: false,
      invalidReason: read.modelUnavailable ? 'model-unavailable' : 'artifact-invalid',
      problems,
      modelUnavailable: read.modelUnavailable,
    };
  }

  if (read.modelUnavailable) {
    problems.push(
      'The arm artifact reports that the runtime refused the model, so this session never composed a request and is not a measurement of zero tokens.',
    );
    return {
      observation: undefined,
      accepted: false,
      invalidReason: 'model-unavailable',
      problems,
      modelUnavailable: true,
    };
  }

  return {
    observation: read.observation,
    accepted: true,
    invalidReason: undefined,
    problems,
    modelUnavailable: false,
  };
}
