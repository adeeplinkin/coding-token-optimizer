/**
 * The order arm runs are launched in, and the rule that ends the plan early.
 *
 * ## Why this is its own module
 *
 * The live loop used to live inside the command line, where nothing could test it: importing
 * `cli.ts` starts the CLI. That is why a fatal outcome could be *recorded* as an invalid
 * measurement and then have the next arm launched anyway — which is what the 2026-10-12 canary
 * measured. The control session exited non-zero (the provider refused the request upstream), its
 * run was refused as `session-exit-nonzero`, and the treatment session was launched regardless,
 * spending the second half of a single-use authorization to learn the same thing twice.
 *
 * The sequence is therefore a function over the plan, with the per-run execution **injected**.
 * The production caller passes the real `runArm`; a test passes a fake that records which runs
 * were launched and returns whatever outcome the case is about. "The second arm never launches"
 * is then a fact about the returned `launched` list rather than a claim about control flow.
 *
 * ## What stops the plan, and what does not
 *
 * Fatal — the plan stops and every remaining run is published as `not-run`:
 *
 * - **no observation at all** (a crashed, killed or timed-out session, a missing/stale/partial/
 *   foreign artifact, a mode mismatch). The harness state that produced it is not the harness the
 *   experiment declares, so the next session cannot be assumed to run under it either;
 * - **the runtime refused the model** — repeating it would learn the same thing;
 * - **the harness was not engaged** — the live path is broken rather than the model being slow;
 * - **a cap decided no further run may start**, including an unreported cost while a spending cap
 *   is set.
 *
 * Not fatal, and deliberately so: a `task-failed` run (the model tried and the code did not pass)
 * and an `unavailable-evidence` run (the task ran, the host reported no token field). Those are
 * results about the model, not failures of the apparatus, and stopping on them would end an
 * experiment because the model had a bad run.
 */
import { checkLiveEngagement, type LiveEngagementRequirements } from './engagement.js';
import { hasNoReportedUsage, type BudgetDecision } from './budget.js';
import type { Level2Plan, Level2PlannedRun } from './plan.js';
import { describeObservation } from './report.js';
import type { ArmRunOutcome } from './runner.js';
import type { Level2ArmObservation, Level2RunDisposition } from './types.js';

/** Why the plan stopped launching arm runs. */
export type ArmStopCode = 'invalid-measurement' | 'model-refused' | 'not-engaged' | 'budget';

/** A stop the plan must obey, with the content-free reason to print. */
export interface ArmSequenceStop {
  readonly code: ArmStopCode;
  readonly detail: string;
}

/** The one budget method the sequence needs, so a test can pass a fake. */
export interface ArmSequenceBudget {
  readonly observe: (observation: Level2ArmObservation) => BudgetDecision;
}

export interface ArmSequenceOptions {
  readonly plan: Level2Plan;
  /**
   * Execute one planned run. Injected: the production caller passes the real `runArm`, a test
   * passes a fake that records the launch and returns the outcome under test.
   */
  readonly execute: (run: Level2PlannedRun) => Promise<ArmRunOutcome>;
  readonly budget: ArmSequenceBudget;
  /** Named only so the refusal message can quote it. */
  readonly model: string;
  readonly requirements?: LiveEngagementRequirements;
  /** Receives one line at a time, in the order an operator should read them. */
  readonly report?: (line: string) => void;
}

export interface ArmSequenceResult {
  /** The runs that were actually started, in order. */
  readonly launched: readonly Level2PlannedRun[];
  readonly observations: readonly Level2ArmObservation[];
  /** One entry per planned run: the launched ones, then the ones the stop prevented. */
  readonly dispositions: readonly Level2RunDisposition[];
  readonly stop: ArmSequenceStop | undefined;
  readonly failures: number;
}

/**
 * Run the plan's arms in order, stopping at the first fatal outcome.
 *
 * Every planned run appears in {@link ArmSequenceResult.dispositions}: a run that was launched and
 * refused as an invalid measurement is `invalid-measurement`, and a run the stop prevented is
 * `not-run`. Nothing that was authorized can disappear from the report.
 */
export async function runArmSequence(options: ArmSequenceOptions): Promise<ArmSequenceResult> {
  const report = options.report ?? (() => {});
  const launched: Level2PlannedRun[] = [];
  const observations: Level2ArmObservation[] = [];
  const dispositions: Level2RunDisposition[] = [];
  let stop: ArmSequenceStop | undefined;
  let failures = 0;

  const record = (
    run: Level2PlannedRun,
    disposition: Level2RunDisposition['disposition'],
    detail: string,
  ): void => {
    dispositions.push({
      taskId: run.taskId,
      pairIndex: run.pairIndex,
      arm: run.arm,
      disposition,
      detail,
    });
  };

  for (const run of options.plan.runs) {
    // The stop is consulted *before* the next launch, so a fatal outcome costs exactly one
    // session — never two.
    if (stop !== undefined) {
      break;
    }
    launched.push(run);
    const outcome = await options.execute(run);
    for (const problem of outcome.problems) {
      report(`NOTE  ${problem}`);
    }

    if (outcome.modelUnavailable) {
      failures += 1;
      stop = {
        code: 'model-refused',
        detail: `the runtime refused the model \`${options.model}\` for ${run.taskId} pair ${run.pairIndex} ${run.arm}`,
      };
      record(run, 'invalid-measurement', 'the runtime refused the model, so this session never composed a request');
      report(`STOP  ${stop.detail}; stopping the plan rather than repeating it.`);
      continue;
    }

    if (outcome.observation === undefined) {
      failures += 1;
      const reason = outcome.invalidReason ?? 'no observation';
      stop = {
        code: 'invalid-measurement',
        detail:
          `${run.taskId} pair ${run.pairIndex} ${run.arm} produced no measurement (${reason}), so this ` +
          'run is not evidence about the harness and the next one would not be either',
      };
      record(run, 'invalid-measurement', `refused as a measurement (${reason})`);
      report(`FAIL  ${run.taskId} pair ${run.pairIndex} ${run.arm} produced no measurement (${reason})`);
      report(`STOP  ${stop.detail}.`);
      continue;
    }

    report(`      ${describeObservation(outcome.observation)}`);
    const governor = outcome.observation.inSessionGovernor;
    if (governor !== undefined) {
      report(
        `      in-session spending bound: ${
          governor.armed
            ? `armed at $${governor.capUsd ?? '?'} (polls ${governor.polls}, reported cost ${governor.reportedCostUsd ?? 'none'}${governor.interrupted ? ', interrupt confirmed' : ''})`
            : `not armed (${governor.reason ?? 'no reason recorded'})`
        }`,
      );
    }

    const engagement = checkLiveEngagement(outcome.observation, options.requirements ?? {});
    report(`      ${engagement.detail}`);
    if (!engagement.measurable) {
      failures += 1;
      stop = { code: 'not-engaged', detail: engagement.detail };
      record(run, 'invalid-measurement', `the session did not engage the harness: ${engagement.detail}`);
      report(`STOP  ${engagement.detail}`);
      report(`      the arm artifact is at ${outcome.artifactPath}`);
      continue;
    }
    observations.push(outcome.observation);

    // A measured run, classified in the report's own vocabulary: the coding outcome first (it is
    // the gate), then whether the host reported anything to compare.
    const solved = outcome.observation.grading.passed;
    if (hasNoReportedUsage(outcome.observation)) {
      record(
        run,
        'unavailable-evidence',
        `the task ${solved ? 'passed' : 'FAILED'} its own tests, and the host reported no token field, so no token comparison can be made`,
      );
    } else {
      record(
        run,
        solved ? 'solved' : 'task-failed',
        `the task ${solved ? 'passed' : 'FAILED'} its own tests (graded outside the session, against pristine tests)`,
      );
    }

    const decision = options.budget.observe(outcome.observation);
    if (!decision.allowed) {
      failures += 1;
      stop = { code: 'budget', detail: decision.detail };
      report(`STOP  usage cap reached: ${decision.detail}`);
    }
  }

  // Runs the plan stopped before are still planned runs: they are published as `not-run` rather
  // than omitted, so the report accounts for every authorized session.
  for (const run of options.plan.runs.slice(launched.length)) {
    record(run, 'not-run', 'the plan stopped before this run started');
  }

  return { launched, observations, dispositions, stop, failures };
}
