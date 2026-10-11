/**
 * The Level 2 run plan: how many pairs, in what order, on which tasks.
 *
 * Two controls from the design live here and nowhere else:
 *
 * - **Minimum samples.** Fewer than three pairs per task over fewer than five tasks
 *   is an incomplete experiment, never a result (§6.3). The plan refuses to be built
 *   below those numbers, and the report re-checks them from the recorded runs.
 * - **Order and caching.** Each task's pairs alternate ABBA, so provider cache
 *   warm-up cannot systematically favour one arm, and the plan records the order it
 *   actually used rather than assuming it.
 *
 * The plan also freezes the experiment: it carries a fingerprint of the task pack,
 * so a report produced from a different pack is visibly a different experiment.
 */
import { createHash } from 'node:crypto';
import { LEVEL2_TASKS } from './tasks.js';
import type { Level2Arm, Level2Task } from './types.js';

/** Minimum tasks the design permits a Level 2 conclusion on. */
export const MIN_TASKS = 5;

/** Minimum paired runs per task. */
export const MIN_PAIRS_PER_TASK = 3;

/** Minimum total pairs: five tasks at three pairs each. */
export const MIN_PAIRS_TOTAL = MIN_TASKS * MIN_PAIRS_PER_TASK;

/** Minimum arm runs: both arms of every minimum pair. */
export const MIN_ARM_RUNS = MIN_PAIRS_TOTAL * 2;

/** One planned arm run. */
export interface Level2PlannedRun {
  readonly taskId: string;
  readonly pairIndex: number;
  /** 1-based position of this run within the whole experiment. */
  readonly ordinal: number;
  readonly arm: Level2Arm;
}

/** The plan as a value. */
export interface Level2Plan {
  readonly pairsPerTask: number;
  readonly taskPackFingerprint: string;
  readonly declarationFingerprint: string;
  readonly runs: readonly Level2PlannedRun[];
  readonly pairsTotal: number;
  readonly armRunsTotal: number;
  readonly tasks: readonly string[];
}

/**
 * Fingerprint of the task pack.
 *
 * Includes the instruction, the starting state, the graded files, the grading
 * command and both solution variants: changing any of them makes the pairs already
 * recorded incomparable with the ones that follow.
 */
export function taskPackFingerprint(tasks: readonly Level2Task[] = LEVEL2_TASKS): string {
  const canonical = tasks.map((task) => ({
    id: task.id,
    category: task.category,
    prompt: task.prompt,
    files: sortedEntries(task.files),
    gradedFiles: [...task.gradedFiles].sort(),
    gradingCommand: task.gradingCommand,
    goldenFiles: sortedEntries(task.goldenFiles),
    brokenFiles: sortedEntries(task.brokenFiles),
    expectation: task.expectation,
  }));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function sortedEntries(files: Readonly<Record<string, string>>): (readonly [string, string])[] {
  return Object.keys(files)
    .sort()
    .map((path) => [path, files[path] ?? ''] as const);
}

/** Arms of the two orders a pair may run in. */
export const PAIR_ORDER_CONTROL_FIRST: readonly Level2Arm[] = ['control', 'treatment'];
export const PAIR_ORDER_TREATMENT_FIRST: readonly Level2Arm[] = ['treatment', 'control'];

/**
 * Build the plan.
 *
 * `pairsPerTask` defaults to the minimum the design allows; a larger number is
 * accepted and recorded, never silently reduced. The ABBA alternation is by pair
 * index, so an odd pair count leaves the arms balanced across tasks.
 */
export function buildPlan(options: {
  readonly pairsPerTask?: number;
  readonly tasks?: readonly Level2Task[];
  readonly declarationFingerprint: string;
  /**
   * Allow a plan below the design's minimum samples.
   *
   * Only the scripted rehearsal uses this: it runs one pair to prove the plumbing,
   * and the experiment it builds is labelled incomplete so nothing can be concluded
   * from it. A live run never sets it, and `validatePlan` still refuses such a plan.
   */
  readonly allowIncomplete?: boolean;
}): Level2Plan {
  const tasks = options.tasks ?? LEVEL2_TASKS;
  const pairsPerTask = options.pairsPerTask ?? MIN_PAIRS_PER_TASK;
  const incomplete = options.allowIncomplete === true;

  if (!incomplete && (!Number.isInteger(pairsPerTask) || pairsPerTask < MIN_PAIRS_PER_TASK)) {
    throw new Error(
      `A Level 2 plan needs at least ${MIN_PAIRS_PER_TASK} pairs per task; ${String(pairsPerTask)} was requested.`,
    );
  }
  if (!incomplete && tasks.length < MIN_TASKS) {
    throw new Error(
      `A Level 2 plan needs at least ${MIN_TASKS} tasks; ${tasks.length} were supplied.`,
    );
  }
  if (!Number.isInteger(pairsPerTask) || pairsPerTask < 1) {
    throw new Error('A plan needs at least one pair per task.');
  }

  const runs: Level2PlannedRun[] = [];
  let ordinal = 0;

  for (const task of tasks) {
    for (let pairIndex = 0; pairIndex < pairsPerTask; pairIndex += 1) {
      // ABBA: even pairs run the control first, odd pairs run the treatment first.
      const order = pairIndex % 2 === 0 ? PAIR_ORDER_CONTROL_FIRST : PAIR_ORDER_TREATMENT_FIRST;
      for (const arm of order) {
        ordinal += 1;
        runs.push({ taskId: task.id, pairIndex, ordinal, arm });
      }
    }
  }

  return {
    pairsPerTask,
    taskPackFingerprint: taskPackFingerprint(tasks),
    declarationFingerprint: options.declarationFingerprint,
    runs,
    pairsTotal: tasks.length * pairsPerTask,
    armRunsTotal: runs.length,
    tasks: tasks.map((task) => task.id),
  };
}

/**
 * Check a plan against the design's minimums and its own order rule.
 *
 * Returns the problems found rather than throwing, so a caller can report all of
 * them at once. An empty list means the plan may be executed.
 */
export function validatePlan(plan: Level2Plan): readonly string[] {
  const problems: string[] = [];

  if (plan.tasks.length < MIN_TASKS) {
    problems.push(
      `The plan covers ${plan.tasks.length} task(s); the design requires at least ${MIN_TASKS}.`,
    );
  }
  if (plan.pairsPerTask < MIN_PAIRS_PER_TASK) {
    problems.push(
      `The plan records ${plan.pairsPerTask} pair(s) per task; the design requires at least ${MIN_PAIRS_PER_TASK}.`,
    );
  }
  if (plan.pairsTotal < MIN_PAIRS_TOTAL) {
    problems.push(
      `The plan records ${plan.pairsTotal} pair(s); the design requires at least ${MIN_PAIRS_TOTAL}.`,
    );
  }
  if (plan.armRunsTotal !== plan.runs.length) {
    problems.push('The plan\u2019s arm-run total does not match its run list.');
  }
  if (plan.armRunsTotal !== plan.pairsTotal * 2) {
    problems.push('Every pair must contain exactly two arm runs.');
  }
  if (
    plan.armRunsTotal !== plan.tasks.length * plan.pairsPerTask * 2 ||
    new Set(plan.tasks).size !== plan.tasks.length
  ) {
    problems.push('The plan does not describe each task/pair/arm combination exactly once.');
  }

  for (const taskId of plan.tasks) {
    const taskRuns = plan.runs.filter((entry) => entry.taskId === taskId);
    if (taskRuns.length !== plan.pairsPerTask * 2) {
      problems.push(`Task "${taskId}" has ${taskRuns.length} arm run(s) planned.`);
    }
    for (let pairIndex = 0; pairIndex < plan.pairsPerTask; pairIndex += 1) {
      const pair = taskRuns.filter((entry) => entry.pairIndex === pairIndex);
      if (pair.length !== 2) {
        problems.push(`Task "${taskId}" pair ${pairIndex} has ${pair.length} arm run(s).`);
        continue;
      }
      const arms = pair.map((entry) => entry.arm);
      if (arms[0] === arms[1]) {
        problems.push(`Task "${taskId}" pair ${pairIndex} runs the same arm twice.`);
      }
      const expected = pairIndex % 2 === 0 ? PAIR_ORDER_CONTROL_FIRST : PAIR_ORDER_TREATMENT_FIRST;
      if (arms[0] !== expected[0] || arms[1] !== expected[1]) {
        problems.push(
          `Task "${taskId}" pair ${pairIndex} does not follow the alternating order the plan declares.`,
        );
      }
    }
  }

  return problems;
}

/** Stable run id for one planned arm run. */
export function runIdFor(taskId: string, pairIndex: number, arm: Level2Arm): string {
  return `${taskId}:p${pairIndex}:${arm}`;
}
