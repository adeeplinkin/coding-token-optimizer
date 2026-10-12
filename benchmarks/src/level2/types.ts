/**
 * Level 2 — paired real-harness experiment (design §6.3). Types only.
 *
 * Level 2 asks one question: *with the pass on, does a real coding model still
 * solve the same tasks at the same rate, and what did the host report for token
 * usage?* Everything here exists to make that question answerable without
 * weakening a single honesty rule of the existing framework:
 *
 * - a task is a synthetic repository plus the **identical** instruction both arms
 *   receive, plus the repository's own independent test command;
 * - an arm run is one fresh session in a fresh copy of that repository, produced
 *   by the arm driver and reduced to content-free observations;
 * - a pair is one control run and one treatment run of the same task, compared
 *   through the Stage 1S declared-variant contract;
 * - a measurement is only ever reported with the evidence class it earned, and a
 *   coding failure in the treatment arm is a failure, never a smaller token bill.
 *
 * Nothing in this module claims a token saving. Request-size facts (bytes
 * removed from a request) are kept in a separate vocabulary from token
 * measurements, because the two are not interchangeable.
 */
import type {
  BenchmarkRunRecord,
  ComparisonResult,
  DeclaredVariant,
  Measurement,
} from '../types.js';

/** The two arms of the experiment. `control` runs the pass off; `treatment` on. */
export type Level2Arm = 'control' | 'treatment';

/** What a task asks a coding agent to do. */
export type Level2TaskCategory =
  | 'read-and-edit'
  | 'debug-failing-test'
  | 'multi-file-change'
  | 'repeated-reads'
  | 'no-duplicate-opportunity'
  | 'edge-case-fix';

/** One `read`-heavy step the task asks for, recorded so a token change is attributable. */
export interface Level2TaskExpectation {
  /**
   * True when the task deliberately asks for a repeated identical read, which is
   * what the pass requires to have anything to elide.
   */
  readonly expectsDuplicateReadOpportunity: boolean;
  /** Minimum number of tool calls the task expects; a shortfall is reported, not hidden. */
  readonly minimumToolCalls: number;
}

/**
 * One Level 2 task: a synthetic repository, the instruction given to both arms,
 * and the independent test command that decides whether the agent succeeded.
 */
export interface Level2Task {
  readonly id: string;
  readonly category: Level2TaskCategory;
  readonly title: string;
  /**
   * The instruction handed to the coding agent. Recorded by hash; byte-identical
   * in both arms, and a changed hash invalidates the pair.
   */
  readonly prompt: string;
  /** Relative path to file content: the state every arm starts from. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Files replaced from `files` **after** the arm finishes and **before** grading.
   *
   * This is what makes the grader independent: an agent that edits the repository's
   * own tests gains nothing, because grading runs the pristine copies.
   */
  readonly gradedFiles: readonly string[];
  /** The repository's own test command, run from the repository root. */
  readonly gradingCommand: readonly string[];
  /** A correct solution, used to prove the grader accepts one. */
  readonly goldenFiles: Readonly<Record<string, string>>;
  /** A plausible but wrong solution, used to prove the grader is not vacuous. */
  readonly brokenFiles: Readonly<Record<string, string>>;
  readonly expectation: Level2TaskExpectation;
  /** Content-free note kept in the report. */
  readonly note: string;
}

/** Where one arm run happened, and on what. */
export interface Level2RunIdentity {
  readonly taskId: string;
  readonly arm: Level2Arm;
  /** Stable id of this arm run, unique within the experiment. */
  readonly runId: string;
  /** 0-based pair index this run belongs to. */
  readonly pairIndex: number;
  /** 1-based attempt of this arm within the pair (`>= 1` only for retries). */
  readonly attempt: number;
}

/**
 * The result of the repository's own test command for one arm run.
 *
 * It is the only thing that decides coding success: the agent's own claim about
 * what it did is never used.
 */
export interface Level2Grading {
  readonly passed: boolean;
  /** The command that produced this outcome, joined for reporting. */
  readonly command: string;
  /** Process exit code, or `undefined` when the command could not be started. */
  readonly exitCode: number | undefined;
  /** True when the command exceeded its timeout and was killed. */
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** SHA-256 of the captured output, so two runs can be compared without storing text. */
  readonly outputDigest: string;
  /** Bounded head of the captured output, kept in the run artifact (never in the report). */
  readonly outputExcerpt: string;
  /** Checks the grader itself made: pristine restoration, expected files, and so on. */
  readonly checks: readonly Level2GradeCheck[];
}

/** One structural check the grader performed before running the tests. */
export interface Level2GradeCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** Host-reported token fields for one arm run, each independently optional. */
export interface Level2UsageObservation {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly costUsd: number | undefined;
}

/** Behavioural counts for one arm run. */
export interface Level2BehaviourObservation {
  readonly toolCalls: number | undefined;
  readonly repeatedFileReads: number | undefined;
  readonly assistantMessages: number | undefined;
  readonly observerInternalErrors: number | undefined;
  readonly optimizerErrors: number | undefined;
  readonly recoveryAttempts: number | undefined;
}

/**
 * The pass's own request-size facts for one treatment run, read from the session
 * summary the observer wrote. Absent for a control run, and for a treatment run
 * whose observer never got the option.
 */
export interface Level2ApplyEvidence {
  readonly requestsAttempted: number;
  readonly requestsApplied: number;
  readonly elidedOccurrences: number;
  readonly elidedBytes: number;
  readonly markerBytes: number;
}

/** One outbound request as observed. Lengths and marker counts only, never content. */
export interface Level2WireRequest {
  readonly seq: number;
  readonly bodyBytes: number;
  /** Markers of the Safe Mode marker prefix found in this request body. */
  readonly markerCount: number;
  /**
   * The model identifier the request body named, or `undefined` when it could not be read.
   *
   * An identifier is not content: it is the same string the run was started with, and it is
   * what makes "no unexpected model substitution" checkable at the endpoint rather than
   * assumed from the configuration.
   */
  readonly model?: string;
  /**
   * Whether the request carried a tool registry. The runtime's agent-loop request does; its
   * auxiliary title request does not, so this is the endpoint's own way of showing that an
   * auxiliary request did or did not happen.
   */
  readonly hasTools?: boolean;
}

/**
 * Where the request observations came from.
 *
 * This is not a detail: Stage 1U measured that the runtime hands the outbound body
 * to `session.hook("http.request")` as a **`ReadableStream`**, not as text, so a
 * plugin cannot measure the request it is about to send. Wire evidence therefore has
 * exactly one honest source — a loopback endpoint the run was pointed at — and a
 * live run against a real provider has none.
 */
export type Level2WireSource =
  /** Measured at a loopback provider endpoint the run was deliberately pointed at. */
  | 'loopback-endpoint'
  /** The plugin hook fired, but the body it was handed was not measurable text. */
  | 'hook-unmeasurable'
  /** No request was observed at all. */
  | 'none';

/** What the wire saw during one arm run. Lengths and marker counts only, never content. */
export interface Level2WireEvidence {
  readonly source: Level2WireSource;
  readonly requests: readonly Level2WireRequest[];
  /** Requests the `http.request` hook observed, whatever their shapes. */
  readonly hookInvocations: number;
  /** Requests the hook saw whose body it could not measure (never content). */
  readonly unmeasurableRequests: number;
  /** True when every observed request went to the configured provider base URL. */
  readonly allRequestsToProvider: boolean;
}

/**
 * What the runtime was observed to do, per request kind, for one arm run.
 *
 * The request kind is not content — it is the runtime's own category for the call it composed
 * — and it is the fact that decides whether an auxiliary call (a title, a compaction, a
 * generate) happened at all. `modelsNamed` is the set of model identifiers the runtime named
 * when composing requests, which is how a substitution would show up.
 *
 * Two sources feed this: the runtime's `model.request:<kind>` hooks (available in every mode,
 * including live), and the loopback endpoint's own record in a rehearsal. Neither is the
 * optimizer's report of itself.
 */
export interface Level2RequestKindEvidence {
  /** Where the counts came from, so the strength of the claim travels with it. */
  readonly source: 'model-request-hooks' | 'loopback-endpoint' | 'none';
  /**
   * The hook name(s) the runtime accepted, so a silent absence is distinguishable from a zero.
   *
   * A name here is not evidence that the hook **fires**: the pinned runtime accepts a hook
   * registration without validating the name and then never calls one it does not dispatch
   * (measured — a per-kind name such as `model.request:title` registers cleanly and stays silent
   * while real requests go out). Only {@link kinds} can show an absence, which is why a check
   * that requires "no title request" must also require the invocation count of the primary kind
   * to be above zero from *this* hook.
   */
  readonly kindsRegistered: readonly string[];
  /** Invocations per request kind, e.g. `{ primary: 2, title: 0 }`. */
  readonly kinds: Readonly<Record<string, number>>;
  /** Model identifiers the runtime named when composing requests, and how often. */
  readonly modelsNamed: Readonly<Record<string, number>>;
  /** The paths/kinds the probe registered but the runtime rejected, if any. */
  readonly registrationFailures: readonly string[];
  /**
   * The payload key names the runtime handed the hook, so the recorded kinds can be seen to come
   * from real payloads rather than from a hook that fired with nothing in it.
   */
  readonly payloadKeys: readonly string[];
  /**
   * What the loopback endpoint itself received, when the run was pointed at one. Independent of
   * the hook: a request without the agent-loop tool registry is an auxiliary request, so the two
   * readings can be compared instead of one being trusted.
   */
  readonly endpointKinds: Level2EndpointKindCounts | undefined;
  /** True when no kind other than `primary` was ever composed. */
  readonly auxiliaryRequests: number;
}

/** The loopback endpoint's own count of what it received, by request shape. */
export interface Level2EndpointKindCounts {
  readonly requests: number;
  /** Requests that declared the agent-loop tool registry, i.e. primary requests. */
  readonly withToolRegistry: number;
  /** Requests with no tool registry: auxiliary work, whatever kind composed it. */
  readonly withoutToolRegistry: number;
}

/**
 * The free-only model policy as one arm run exercised it.
 *
 * This is the evidence that the run stayed inside the approved envelope: the configuration the
 * repository received (so the two arms' configurations can be shown to be identical), the
 * price row the runtime reported for the model *before* any session started, what the runtime
 * resolved from that configuration, and what kinds of request it then composed.
 *
 * A run whose policy evidence is absent or does not match the expected configuration is refused
 * by the intake rather than compared: it is not a cheap run, it is an unverified one.
 */
export interface Level2ModelPolicyEvidence {
  /** The primary model the policy requires. */
  readonly primaryModel: string;
  /** The model configured for unavoidable auxiliary calls. */
  readonly auxiliaryModel: string;
  /** Every approved model identifier. */
  readonly approvedModels: readonly string[];
  /** The exact configuration object written into the repository's `.opencode/opencode.json`. */
  readonly config: unknown;
  /** SHA-256 of the canonical configuration text; identical in both arms by construction. */
  readonly configDigest: string;
  /** True when the written configuration was structurally the free-only one. */
  readonly configAccepted: boolean;
  /** Where the price verdict came from, or `not-checked` when no catalogue was consulted. */
  readonly catalogueSource: 'service' | 'standalone' | 'not-checked';
  /** True only when every tier was explicitly zero. */
  readonly priceVerifiedFree: boolean;
  /** The price row the runtime reported, when one was read. */
  readonly priceRow:
    | {
        readonly input: number | undefined;
        readonly output: number | undefined;
        readonly cacheRead: number | undefined;
        readonly cacheWrite: number | undefined;
      }
    | undefined;
  /** Why no catalogue was consulted, when none was (a rehearsal spends nothing). */
  readonly priceCheckSkippedReason: string | undefined;
  /** Every pre-spawn refusal; empty means the run started inside the policy. */
  readonly refusals: readonly string[];
  /** What the runtime resolved from the configuration, as its own config read reported it. */
  readonly resolved: unknown;
  /** Request kinds the runtime was observed to compose. */
  readonly requests: Level2RequestKindEvidence;
  /**
   * True when the auxiliary calls were removed at the source rather than only bounded: the
   * stable session title is supplied on the command line, so the runtime composes none.
   */
  readonly titleGenerationSuppressed: boolean;
}

/**
 * How this arm run's mechanism evidence classifies.
 *
 * - `fired` — the pass reported elision *and* the marker was observed on the wire;
 * - `no-opportunity` — the pass ran or could not run, and no elision was recorded,
 *   so the run contributes nothing to a size comparison (design §6.3);
 * - `unexplained` — the counters and the wire disagree, which is a defect signal
 *   rather than a datapoint;
 * - `not-applicable` — the control arm, where the pass must not have run at all.
 */
export type Level2MechanismVerdict =
  /** The pass reported elision and the marker was observed at the wire endpoint. */
  | 'fired'
  /**
   * The pass reported elision, but this mode produced no wire observation at all
   * (a live run against a real provider). The counters are the pass's own report, so
   * this is weaker evidence than `fired` and is labelled separately rather than
   * folded into it.
   */
  | 'fired-counters-only'
  | 'no-opportunity'
  | 'unexplained'
  | 'not-applicable';

/**
 * Containment evidence for one arm run, read from the guard plugin's own record.
 *
 * `guard` is the fact that decides whether the run may be treated as a measurement:
 * a session whose guard never registered its tool hook ran without the enforcement
 * layer, and no result from it can be compared as if it had one.
 */
export interface Level2ContainmentEvidence {
  readonly guard: 'loaded' | 'capability-missing' | 'missing';
  /** False when the host never declared a project directory, so nothing was checked. */
  readonly rootKnown: boolean;
  readonly blockedCalls: number;
  readonly allowedCalls: number;
  /** Refused calls by tool name; never a path or an argument value. */
  readonly blockedByTool: Readonly<Record<string, number>>;
  /** The permission rules the session itself declared, as action/effect/resource class. */
  readonly permissionRules:
    | readonly { readonly action: string; readonly effect: string; readonly resource: string }[]
    | undefined;
  /** SHA-256 of the byte-identical containment configuration both arms receive. */
  readonly configDigest: string | undefined;
}

/**
 * The **pre-transmission model guard** as one arm run exercised it.
 *
 * This is the third enforcement layer, and the only one that acts while a request is still being
 * assembled: the price gate and the resolved-configuration check decide whether a session may
 * *start*, the containment guard decides what its tools may *do*, and this decides whether a model
 * request may be *sent*. It is read from the guard plugin's own record, and the two facts that
 * decide measurability are `loaded` **and** `hookRegistered` — a plugin that ran without the runtime
 * accepting its hook bounds nothing, however complete its evidence file looks.
 *
 * `refused` being non-zero is reported rather than tolerated: a request the guard stopped means the
 * session tried to step outside the approved envelope, so nothing it produced is a free-only
 * measurement, even though the request itself never left the process.
 */
export interface Level2ModelGuardEvidence {
  /** `loaded` requires both the plugin and the runtime-accepted hook, not one of them. */
  readonly guard: 'loaded' | 'capability-missing' | 'missing';
  /** The hook name the guard registered; the one the runtime dispatches every request to. */
  readonly hook: string;
  readonly loaded: boolean;
  readonly hookRegistered: boolean;
  /** Requests the guard saw and classified, whether it allowed or refused them. */
  readonly invocations: number;
  readonly allowed: number;
  readonly refused: number;
  /** Why each refusal happened. Model identifiers and reasons only, never request content. */
  readonly refusals: readonly {
    readonly requestKind?: string;
    readonly model?: string;
    readonly reason: string;
  }[];
  /** True when the guard was constructed without a usable envelope: it refuses everything. */
  readonly misconfigured: boolean;
  /** The configuration digest the guard was given, so it can be compared with this run's. */
  readonly policyDigest: string;
  /** The envelope itself, as the driver passed it; absent when the policy could not state one. */
  readonly envelope:
    | {
        readonly primary: string;
        readonly approved: readonly string[];
        readonly allowedKinds: readonly string[];
        readonly policyDigest: string;
      }
    | undefined;
  readonly evidenceLines: number;
}

/**
 * What the in-session spending governor did during one arm run.
 *
 * Read from the driver's own supervisor, which polls the cost the runtime reports
 * and calls the runtime's native `session.interrupt` when the per-session cap is
 * crossed. `armed: false` with a reason means the session ran without an in-session
 * spending bound, and the report must say so rather than implying one existed.
 */
/**
 * The runtime's own resolved permission rules for one arm's repository.
 *
 * This is the **second** containment layer, and it is evidenced by asking the runtime rather than
 * by assuming it: the arm driver runs a read-only `api config.get --standalone` in the arm's own
 * isolated environment before any session starts and records the canonical actions, effects and a
 * resource *class* (never a path). A live session whose runtime did not resolve the required
 * denies is refused, because then only the plugin layer would be in force.
 *
 * The plugin event stream does **not** carry the session's permission rules in the pinned runtime
 * (`permissionRules: null` in the guard's own evidence is a gap in what the runtime reports to a
 * plugin, not a missing rule), so this is where the native layer is observed.
 */
export interface Level2NativePermissionsEvidence {
  /** True when the runtime reported at least one permission rule. */
  readonly observed: boolean;
  /** Exactly which read-only call produced this, so the claim names its source. */
  readonly source: string;
  readonly rules: readonly {
    readonly action: string;
    readonly effect: string;
    readonly resource: string;
  }[];
  /** The denies the canary policy requires, in the runtime's own vocabulary. */
  readonly requiredDenies: readonly string[];
  /** Required denies the runtime did not report. Empty means the layer is fully evidenced. */
  readonly missingRequiredDenies: readonly string[];
  readonly allRequiredPresent: boolean;
  readonly error: string | undefined;
}

export interface Level2InSessionGovernorEvidence {
  readonly armed: boolean;
  readonly reason: string | undefined;
  readonly capUsd: number | undefined;
  readonly polls: number;
  /** The latest cumulative cost the runtime reported to the governor, if any. */
  readonly reportedCostUsd: number | undefined;
  readonly interrupted: boolean;
  readonly interruptAttempts: number;
  /** True when the native interrupt did not confirm and the client was killed instead. */
  readonly killedAfterFailedInterrupt: boolean;
}

/** Everything one arm run produced, reduced to content-free observations. */
export interface Level2ArmObservation {
  readonly identity: Level2RunIdentity;
  readonly taskId: string;
  /** Model identifier actually used, or `undefined` when none was recorded. */
  readonly model: string | undefined;
  /** Harness identifier, e.g. `opencode`. */
  readonly harness: string;
  /** Optimizer revision string recorded in provenance. */
  readonly optimizerRevision: string;
  /** SHA-256 of the pristine repository state the run started from. */
  readonly repositoryRevision: string;
  /** SHA-256 of the instruction, so prompt drift invalidates the pair. */
  readonly promptHash: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly grading: Level2Grading;
  readonly usage: Level2UsageObservation;
  readonly behaviour: Level2BehaviourObservation;
  readonly apply: Level2ApplyEvidence | undefined;
  readonly wire: Level2WireEvidence;
  /**
   * Containment evidence, or `undefined` when the artifact predates it. A live run
   * with no containment evidence is refused rather than compared (see
   * `checkLiveEngagement`).
   */
  readonly containment: Level2ContainmentEvidence | undefined;
  /** The native permission layer as the runtime itself resolved it; absent before it was read. */
  readonly nativePermissions: Level2NativePermissionsEvidence | undefined;
  /** In-session spending-governor evidence, or `undefined` when none was recorded. */
  readonly inSessionGovernor: Level2InSessionGovernorEvidence | undefined;
  /**
   * Pre-transmission model-guard evidence, or `undefined` when the artifact predates it.
   *
   * A run without it is refused: an unregistered guard means an unapproved model request would
   * have been sent, and there would be no record either way.
   */
  readonly modelGuard: Level2ModelGuardEvidence | undefined;
  /** Classification computed from {@link apply} and {@link wire}. */
  readonly mechanism: Level2MechanismVerdict;
  /**
   * The free-only model policy as this run exercised it, or `undefined` when the artifact
   * predates it. A run without it is refused by the intake: the approved envelope is part of
   * what makes the measurement interpretable.
   */
  readonly modelPolicy: Level2ModelPolicyEvidence | undefined;
}

/** A method, a number and the pairs it was observed on. Never a single headline. */
export interface Level2Distribution {
  readonly samples: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  /** True when every pair's delta has the same sign (or every delta is zero). */
  readonly consistentSign: boolean;
}

/** Per-field token comparison for one task. Fields are never summed together. */
export interface Level2TaskFieldComparison {
  readonly field: string;
  /** Median of (treatment − control), in the field's own unit. */
  readonly delta: Measurement<Level2Distribution>;
  readonly note: string;
}

/** One task's Level 2 outcome. */
export interface Level2TaskResult {
  readonly taskId: string;
  readonly title: string;
  readonly category: Level2TaskCategory;
  readonly pairs: number;
  /** True when the task did not reach the minimum pair count and cannot be concluded from. */
  readonly belowMinimumPairs: boolean;
  /** Pairs where the treatment arm failed the task's own tests. */
  readonly treatmentFailures: number;
  /** Pairs where the control arm failed the task's own tests. */
  readonly controlFailures: number;
  /** Verdicts from the declared-variant comparison, one per pair. */
  readonly verdicts: readonly string[];
  /** Mechanism classification of every treatment run, in pair order. */
  readonly treatmentMechanisms: readonly Level2MechanismVerdict[];
  readonly fields: readonly Level2TaskFieldComparison[];
}

/** One pair as published: classification, verdict and both arms' outcomes. */
export interface Level2PublishedPair {
  readonly taskId: string;
  readonly pairIndex: number;
  /** Mechanism classification of the treatment run of this pair. */
  readonly mechanism: Level2MechanismVerdict;
  /** Order the pair actually ran in, so cache-order effects stay visible. */
  readonly order: readonly Level2Arm[];
  readonly controlTaskPassed: boolean;
  readonly treatmentTaskPassed: boolean;
  readonly verdict: string;
  readonly reason: string;
  readonly correctnessRegression: boolean;
}

/**
 * What happened to one *planned* arm run, in the report's own vocabulary.
 *
 * The four classes are deliberately distinct, because collapsing them is how a report
 * misleads: a task that ran and failed its tests is a coding result, an invalid measurement
 * is no result at all, and unavailable evidence is a result whose numbers are missing.
 * Before this existed, an invalid run simply did not appear — it looked like a run that was
 * never planned rather than one that was refused.
 */
export type Level2RunDispositionClass =
  /** The session ran, produced a usable observation, and solved the task. */
  | 'solved'
  /** The session ran and produced a usable observation, but failed the task's own tests. */
  | 'task-failed'
  /** The run produced no measurement: a crash, a stale/partial artifact, or a refused model. */
  | 'invalid-measurement'
  /** The session ran and was measured, but the host reported no token field to compare. */
  | 'unavailable-evidence'
  /** The run was planned and never started, because the plan stopped before it. */
  | 'not-run';

/** One planned arm run and what became of it. */
export interface Level2RunDisposition {
  readonly taskId: string;
  readonly pairIndex: number;
  readonly arm: Level2Arm;
  readonly disposition: Level2RunDispositionClass;
  /** Content-free detail: a rejection reason, the failing grade, or the missing evidence. */
  readonly detail: string;
}

/** The whole experiment, as published. */
export interface Level2ExperimentResult {
  readonly declarationId: string;
  readonly declarationFingerprint: string;
  /** SHA-256 of the frozen task pack: a different pack is a different experiment. */
  readonly taskPackFingerprint: string;
  readonly tasks: readonly Level2TaskResult[];
  /** Pairs recorded in total. */
  readonly pairsRecorded: number;
  readonly pairsRequired: number;
  /** True only when every task reached the minimum pair count. */
  readonly meetsMinimumSamples: boolean;
  /** Every pair as published, in task/pair order. */
  readonly pairs: readonly Level2PublishedPair[];
  /** Run records, so the declared-variant comparison is re-derivable from the artifact. */
  readonly runs: readonly BenchmarkRunRecord[];
  readonly comparisons: readonly ComparisonResult[];
  /** What became of every planned arm run, including the ones that produced no measurement. */
  readonly dispositions: readonly Level2RunDisposition[];
  /** Statements the report must carry, so no number is read without them. */
  readonly notes: readonly string[];
}

/** The declared controlled comparison Level 2 uses. */
export interface Level2Declaration {
  readonly declaration: DeclaredVariant;
  readonly fingerprint: string;
}
