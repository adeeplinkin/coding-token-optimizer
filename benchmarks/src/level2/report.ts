/**
 * Building and publishing a Level 2 experiment.
 *
 * This module turns recorded arm observations into the framework's own comparison
 * results (so the Stage 1S contract — not a parallel scorer — decides what may be
 * compared), then states the outcome in the design's terms:
 *
 * - correctness first, per pair and per task;
 * - token deltas per **field**, never summed, and only over pairs whose mechanism
 *   actually fired;
 * - the distribution, not a headline;
 * - an explicit list of what the experiment does not establish.
 *
 * A pair whose treatment mechanism did not fire contributes no size or token
 * comparison. It is reported as `no-opportunity`, which is not the same thing as a
 * saving of zero.
 */
import { fileURLToPath } from 'node:url';
import { compareRuns } from '../comparison.js';
import { isAvailable } from '../measurement.js';
import type { BenchmarkRunRecord, ComparisonResult, Measurement } from '../types.js';
import { MIN_PAIRS_PER_TASK, MIN_PAIRS_TOTAL, MIN_TASKS, type Level2Plan } from './plan.js';
import { LEVEL2_MECHANISM_NOTES, describeMechanism, markerCount, mechanismFired } from './mechanism.js';
import { buildArmRunRecord, pairInputHash } from './records.js';
import { resolveLevel2Declaration } from './variants.js';
import type {
  Level2Arm,
  Level2ArmObservation,
  Level2Distribution,
  Level2ExperimentResult,
  Level2MechanismVerdict,
  Level2PublishedPair,
  Level2RunDisposition,
  Level2Task,
  Level2TaskFieldComparison,
  Level2TaskResult,
} from './types.js';

/** Default report directory for Level 2 artifacts, resolved for `src` and `dist` builds. */
export const LEVEL2_REPORT_DIR = fileURLToPath(new URL('../../reports/level2/', import.meta.url));

/** Statements that must travel with any Level 2 report. */
export const LEVEL2_REPORT_NOTES: readonly string[] = [
  'Correctness is a gate, not a metric: a pair in which the treatment arm failed the task\u2019s own tests is a failure of the experiment for that task, whatever the token fields show.',
  'Token fields are reported separately and are never summed: input, output, reasoning, cache-read and cache-write overlap in ways the harness does not document, so a single headline number would be fabricated.',
  'A delta inside run-to-run spread is reported as no change, not as an improvement. Three pairs per task is the design\u2019s minimum for a distribution, not for a conclusion.',
  'Request-size facts (bytes elided) are not tokens saved. A run whose mechanism did not fire is recorded as no-opportunity and excluded from every comparison.',
  'Model, task instructions, starting repository state, grading command and grading criteria are identical in both arms; the only declared difference is the optimizer configuration.',
];

/** All observed token fields, in report order. Fields are never combined. */
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/** Median of a sorted list of numbers. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Summarize deltas as a distribution, keeping the sign consistency visible. */
export function describeDistribution(values: readonly number[]): Level2Distribution {
  const positive = values.filter((value) => value > 0).length;
  const negative = values.filter((value) => value < 0).length;
  return {
    samples: values.length,
    median: median(values),
    min: values.length === 0 ? 0 : Math.min(...values),
    max: values.length === 0 ? 0 : Math.max(...values),
    consistentSign: positive === 0 || negative === 0,
  };
}

/**
 * Per-field comparison for one task.
 *
 * A pair contributes only when the contract found it *comparable*, both arms solved
 * the task, and the mechanism fired. A refused pair (failed baseline, mismatched
 * identity) or a pair whose treatment failed the task contributes nothing: the design
 * ends the experiment for a task on a correctness failure, and a delta from such a
 * pair would leak a number into a report that establishes no correctness.
 */
function fieldComparisons(pairs: readonly Level2PairObservation[]): readonly Level2TaskFieldComparison[] {
  const firing = pairs.filter(
    (pair) =>
      mechanismFired(pair.mechanism) &&
      pair.comparison.verdict !== 'invalid' &&
      !pair.comparison.correctnessRegression,
  );

  return TOKEN_FIELDS.map((field) => {
    const deltas: number[] = [];
    let missing = 0;
    for (const pair of firing) {
      const control = pair.control.usage[field];
      const treatment = pair.treatment.usage[field];
      if (control === undefined || treatment === undefined) {
        missing += 1;
        continue;
      }
      deltas.push(treatment - control);
    }

    const delta: Measurement<Level2Distribution> =
      deltas.length === 0
        ? {
            evidence: 'unavailable',
            note:
              firing.length === 0
                ? 'No comparable pair in this task had a treatment run whose mechanism fired, so no delta is computed.'
                : `The host did not report ${field} for every run in the pairs that fired, so no delta can be formed.`,
          }
        : { evidence: 'measured', value: describeDistribution(deltas) };

    const note =
      missing > 0 && deltas.length > 0
        ? `${missing} pair(s) were excluded from this field because the host did not report it for both arms.`
        : 'Treatment minus control, in the field\u2019s own unit. Fields are never summed.';

    return { field, delta, note };
  });
}

/** One pair as observed. */
interface Level2PairObservation {
  readonly taskId: string;
  readonly pairIndex: number;
  readonly control: Level2ArmObservation;
  readonly treatment: Level2ArmObservation;
  readonly mechanism: Level2MechanismVerdict;
  readonly order: readonly Level2Arm[];
  readonly comparison: ComparisonResult;
}

/** Group observations into pairs, refusing anything that is not exactly one pair. */
export function pairObservations(
  observations: readonly Level2ArmObservation[],
): { readonly pairs: readonly Level2PairObservation[]; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const declaration = resolveLevel2Declaration().declaration;
  const grouped = new Map<string, Level2ArmObservation[]>();

  for (const observation of observations) {
    const key = `${observation.taskId}:${observation.identity.pairIndex}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(observation);
    grouped.set(key, bucket);
  }

  const pairs: Level2PairObservation[] = [];

  for (const [key, bucket] of [...grouped.entries()].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  )) {
    const control = bucket.find((entry) => entry.identity.arm === 'control');
    const treatment = bucket.find((entry) => entry.identity.arm === 'treatment');
    if (control === undefined || treatment === undefined || bucket.length !== 2) {
      problems.push(`${key}: a pair must contain exactly one control run and one treatment run.`);
      continue;
    }
    if (pairInputHash(control, declaration) !== pairInputHash(treatment, declaration)) {
      problems.push(
        `${key}: the arms do not share an input identity (task, prompt, repository revision, model or declaration differ).`,
      );
      continue;
    }

    const controlRecord = buildArmRunRecord(control, declaration);
    const treatmentRecord = buildArmRunRecord(treatment, declaration);
    // The order the pair actually ran in: a pair is planned ABBA, and the recorded
    // start times are the only evidence of which arm really went first.
    const order: readonly Level2Arm[] =
      control.startedAt <= treatment.startedAt ? ['control', 'treatment'] : ['treatment', 'control'];
    pairs.push({
      taskId: control.taskId,
      pairIndex: control.identity.pairIndex,
      control,
      treatment,
      mechanism: treatment.mechanism,
      order,
      comparison: compareRuns(controlRecord, treatmentRecord),
    });
  }

  return { pairs, problems };
}

/**
 * Build the published experiment result from recorded arm observations.
 *
 * `dispositions` carries what happened to *every planned* run, including the ones that
 * produced no observation at all. They are published alongside the pairs so a rejected run
 * cannot disappear from the report — an absent row reads as "never planned", which is how a
 * crashed canary came to look like a clean one.
 */
export function buildExperiment(
  observations: readonly Level2ArmObservation[],
  plan: Level2Plan,
  tasks: readonly Level2Task[],
  dispositions: readonly Level2RunDisposition[] = [],
): Level2ExperimentResult {
  const declaration = resolveLevel2Declaration();
  const { pairs, problems } = pairObservations(observations);

  const runs: BenchmarkRunRecord[] = [];
  const comparisons: ComparisonResult[] = [];
  const published: Level2PublishedPair[] = [];
  for (const pair of pairs) {
    runs.push(buildArmRunRecord(pair.control, declaration.declaration));
    runs.push(buildArmRunRecord(pair.treatment, declaration.declaration));
    comparisons.push(pair.comparison);
    published.push({
      taskId: pair.taskId,
      pairIndex: pair.pairIndex,
      mechanism: pair.mechanism,
      order: pair.order,
      controlTaskPassed: pair.control.grading.passed,
      treatmentTaskPassed: pair.treatment.grading.passed,
      verdict: pair.comparison.verdict,
      reason: pair.comparison.reason,
      correctnessRegression: pair.comparison.correctnessRegression,
    });
  }

  const taskResults: Level2TaskResult[] = tasks.map((task) => {
    const taskPairs = pairs.filter((pair) => pair.taskId === task.id);
    return {
      taskId: task.id,
      title: task.title,
      category: task.category,
      pairs: taskPairs.length,
      belowMinimumPairs: taskPairs.length < MIN_PAIRS_PER_TASK,
      treatmentFailures: taskPairs.filter((pair) => !pair.treatment.grading.passed).length,
      controlFailures: taskPairs.filter((pair) => !pair.control.grading.passed).length,
      verdicts: taskPairs.map((pair) => pair.comparison.verdict),
      treatmentMechanisms: taskPairs.map((pair) => pair.mechanism),
      fields: fieldComparisons(taskPairs),
    };
  });

  const meetsMinimumSamples =
    taskResults.length >= MIN_TASKS &&
    pairs.length >= MIN_PAIRS_TOTAL &&
    taskResults.every((result) => result.pairs >= MIN_PAIRS_PER_TASK);

  return {
    declarationId: declaration.declaration.declarationId,
    declarationFingerprint: declaration.fingerprint,
    taskPackFingerprint: plan.taskPackFingerprint,
    tasks: taskResults,
    pairsRecorded: pairs.length,
    pairsRequired: plan.pairsTotal,
    meetsMinimumSamples,
    pairs: published,
    runs,
    comparisons,
    dispositions,
    notes: [
      ...LEVEL2_REPORT_NOTES,
      ...LEVEL2_MECHANISM_NOTES,
      ...(problems.length === 0
        ? []
        : [`Pairs that could not be formed or compared: ${problems.join(' ')}`]),
      ...(pairs.length < plan.pairsTotal
        ? [
            `${plan.pairsTotal - pairs.length} planned pair(s) were not recorded; the experiment is incomplete and no conclusion may be drawn from it.`,
          ]
        : []),
    ],
  };
}

/** True when at least one comparison reported a correctness regression. */
export function hasCorrectnessRegression(experiment: Level2ExperimentResult): boolean {
  return experiment.comparisons.some((comparison) => comparison.correctnessRegression);
}

function formatDistribution(measurement: Measurement<Level2Distribution>): string {
  if (!isAvailable(measurement)) {
    return 'unavailable';
  }
  const { median: mediaValue, min, max, samples, consistentSign } = measurement.value;
  return `${mediaValue} [${min}..${max}] n=${samples}${consistentSign ? '' : ' sign-mixed'}`;
}

/** Human-readable report for a completed (or partial) experiment. */
export function renderLevel2Markdown(
  experiment: Level2ExperimentResult,
  context: {
    readonly model: string;
    readonly harness: string;
    readonly pairsPerTask: number;
    readonly generatedAt: string;
  },
): string {
  const lines: string[] = [];
  lines.push('# Level 2 — paired control/treatment experiment');
  lines.push('');
  lines.push(`- Declared experiment: \`${experiment.declarationId}\``);
  lines.push(`- Declaration fingerprint: \`${experiment.declarationFingerprint}\``);
  lines.push(`- Task-pack fingerprint: \`${experiment.taskPackFingerprint}\``);
  lines.push(`- Harness: \`${context.harness}\``);
  lines.push(`- Model: \`${context.model}\``);
  lines.push(`- Pairs per task (planned): ${context.pairsPerTask}`);
  lines.push(`- Pairs recorded: ${experiment.pairsRecorded} of ${experiment.pairsRequired} planned`);
  lines.push(
    `- Minimum samples met: ${experiment.meetsMinimumSamples ? 'yes' : 'no — this is an incomplete experiment, not a result'}`,
  );
  lines.push(`- Generated at: ${context.generatedAt}`);
  lines.push('');

  lines.push('## Per task');
  lines.push('');
  lines.push(
    '| Task | Category | Pairs | Control fails | Treatment fails | Verdicts | Treatment mechanisms |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const task of experiment.tasks) {
    lines.push(
      `| ${task.taskId} | ${task.category} | ${task.pairs}${task.belowMinimumPairs ? ' (below minimum)' : ''} | ${task.controlFailures} | ${task.treatmentFailures} | ${task.verdicts.join(', ') || 'none'} | ${task.treatmentMechanisms.join(', ') || 'none'} |`,
    );
  }
  lines.push('');

  lines.push('## Per-field token deltas (treatment − control, pairs that fired only)');
  lines.push('');
  lines.push('| Task | Field | Median [min..max] | Note |');
  lines.push('| --- | --- | --- | --- |');
  for (const task of experiment.tasks) {
    for (const field of task.fields) {
      lines.push(`| ${task.taskId} | ${field.field} | ${formatDistribution(field.delta)} | ${field.note} |`);
    }
  }
  lines.push('');

  lines.push('## Pair detail');
  lines.push('');
  lines.push('| Task | Pair | Ran | Control task | Treatment task | Mechanism | Verdict |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const pair of experiment.pairs) {
    lines.push(
      `| ${pair.taskId} | ${pair.pairIndex} | ${pair.order.join(' then ')} | ${pair.controlTaskPassed ? 'pass' : 'FAIL'} | ${pair.treatmentTaskPassed ? 'pass' : 'FAIL'} | \`${pair.mechanism}\` | ${pair.verdict} |`,
    );
  }
  lines.push('');

  if (experiment.dispositions.length > 0) {
    lines.push('## Run dispositions');
    lines.push('');
    lines.push(
      'Every planned arm run is listed, including the ones that produced no measurement. `solved` and `task-failed` are coding results decided by the repository\u2019s own tests; `invalid-measurement` is no result at all (a crash, a stale or partial artifact, a refused model); `unavailable-evidence` is a measured run whose token fields the host did not report; `not-run` is a planned run the plan stopped before.',
    );
    lines.push('');
    lines.push('| Task | Pair | Arm | Disposition | Detail |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of experiment.dispositions) {
      lines.push(
        `| ${entry.taskId} | ${entry.pairIndex} | ${entry.arm} | \`${entry.disposition}\` | ${entry.detail} |`,
      );
    }
    lines.push('');
  }

  lines.push('## What this report establishes, and what it does not');
  lines.push('');
  for (const note of experiment.notes) {
    lines.push(`- ${note}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/** Compact, machine-readable summary of an experiment. */
export function renderLevel2Json(
  experiment: Level2ExperimentResult,
  context: { readonly model: string; readonly harness: string; readonly generatedAt: string },
): string {
  return `${JSON.stringify(
    {
      generatedAt: context.generatedAt,
      model: context.model,
      harness: context.harness,
      declarationId: experiment.declarationId,
      declarationFingerprint: experiment.declarationFingerprint,
      taskPackFingerprint: experiment.taskPackFingerprint,
      pairsRecorded: experiment.pairsRecorded,
      pairsRequired: experiment.pairsRequired,
      meetsMinimumSamples: experiment.meetsMinimumSamples,
      tasks: experiment.tasks,
      pairs: experiment.pairs,
      comparisons: experiment.comparisons,
      dispositions: experiment.dispositions,
      notes: experiment.notes,
    },
    null,
    2,
  )}\n`;
}

/** One line per treatment run, for logs: no content, just the classification. */
export function describeObservation(observation: Level2ArmObservation): string {
  const markers = markerCount(observation.wire);
  return [
    observation.identity.runId,
    observation.grading.passed ? 'task=pass' : 'task=FAIL',
    `mechanism=${observation.mechanism}`,
    `markersOnWire=${markers}`,
    `requests=${observation.wire.requests.length}`,
    `in=${observation.usage.inputTokens ?? 'unavailable'}`,
    `out=${observation.usage.outputTokens ?? 'unavailable'}`,
    `tools=${observation.behaviour.toolCalls ?? 'unavailable'}`,
    describeMechanism(observation.mechanism, observation.apply, observation.wire),
  ].join(' ');
}
