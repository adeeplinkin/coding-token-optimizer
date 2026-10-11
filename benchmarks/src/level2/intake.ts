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
 *
 * The split matters: {@link checkArmArtifactProvenance} answers "is this file this run's own
 * whole output?", which must be decided **before** grading is attempted. Only then does
 * {@link intakeArmEvidence} add the shape and identity checks of {@link readArmArtifact},
 * which need the grading result merged in first.
 */
import { readArmArtifact } from './observation.js';
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
  /** The runtime refused the model, so no request was ever composed. */
  | 'model-unavailable';

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
