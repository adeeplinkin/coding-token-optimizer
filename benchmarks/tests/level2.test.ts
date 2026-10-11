import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAvailable } from '../src/measurement.js';
import {
  LEVEL2_TASKS,
  MIN_PAIRS_PER_TASK,
  MIN_TASKS,
  applyFiles,
  armMetrics,
  conservativeTokenUnits,
  createBudgetTracker,
  hasNoReportedUsage,
  buildArmRunRecord,
  buildExperiment,
  buildPlan,
  checkLiveEngagement,
  classifyMechanism,
  configurationFor,
  describeDistribution,
  digest,
  gradeTask,
  pairInputHash,
  describeLiveBounds,
  isolationVerdict,
  liveRunRefusals,
  probeCanRunModel,
  provisionTaskRepo,
  readArmArtifact,
  reportedCostUsd,
  repoRevision,
  resolveLevel2Declaration,
  restoreGradedFiles,
  safeModeSettingFor,
  snapshotRevision,
  syntheticObservation,
  taskPackFingerprint,
  validatePlan,
  weakenGradedFiles,
} from '../src/level2/index.js';
import type {
  ArmEnvironmentProbe,
  Level2ArmObservation,
  Level2WireEvidence,
  LiveGuardInput,
} from '../src/level2/index.js';

/**
 * The Level 2 apparatus, tested without a model, a runtime or a network.
 *
 * These tests are about the parts that decide whether a Level 2 number could be
 * trusted: the frozen task pack, reproducible repositories, a grader that rejects
 * wrong and cheating solutions, a plan that meets the design's minimums and
 * alternates its order, an observation intake that recomputes rather than believes,
 * and a mechanism classification that refuses to call an unobserved run `fired`.
 */

const declaration = resolveLevel2Declaration().declaration;

function wire(overrides: Partial<Level2WireEvidence> = {}): Level2WireEvidence {
  return {
    source: 'loopback-endpoint',
    requests: [{ seq: 0, bodyBytes: 1_000, markerCount: 0 }],
    hookInvocations: 1,
    unmeasurableRequests: 0,
    allRequestsToProvider: true,
    ...overrides,
  };
}

async function withTempDir<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dr-token-level2-test-'));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the Level 2 task pack', () => {
  it('covers the design\u2019s breadth with unique, well-formed tasks', () => {
    expect(LEVEL2_TASKS.length).toBeGreaterThanOrEqual(MIN_TASKS);
    const ids = LEVEL2_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    const prompts = LEVEL2_TASKS.map((task) => task.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it('includes a task with a duplicate-read opportunity and one without', () => {
    expect(LEVEL2_TASKS.some((task) => task.expectation.expectsDuplicateReadOpportunity)).toBe(true);
    expect(LEVEL2_TASKS.some((task) => !task.expectation.expectsDuplicateReadOpportunity)).toBe(true);
  });

  it('spans reading, debugging, multi-file and edge-case work', () => {
    const categories = new Set(LEVEL2_TASKS.map((task) => task.category));
    expect(categories).toContain('read-and-edit');
    expect(categories).toContain('debug-failing-test');
    expect(categories).toContain('multi-file-change');
    expect(categories).toContain('edge-case-fix');
  });

  it('declares graded files that exist and a grading command that can run', () => {
    for (const task of LEVEL2_TASKS) {
      expect(task.gradingCommand.length).toBeGreaterThan(0);
      expect(task.gradedFiles.length).toBeGreaterThan(0);
      for (const file of task.gradedFiles) {
        expect(task.files[file], `${task.id} must define ${file}`).toBeDefined();
      }
    }
  });

  it('gives golden and wrong solutions that actually differ from the starting state', () => {
    for (const task of LEVEL2_TASKS) {
      const changed = Object.keys(task.goldenFiles).filter(
        (file) => task.goldenFiles[file] !== task.files[file],
      );
      expect(changed.length, `${task.id} golden solution must edit something`).toBeGreaterThan(0);
      const brokenChanged = Object.keys(task.brokenFiles).filter(
        (file) => task.brokenFiles[file] !== task.goldenFiles[file],
      );
      expect(brokenChanged.length, `${task.id} wrong solution must differ from the correct one`).toBeGreaterThan(0);
    }
  });

  it('fingerprints the pack so a different pack is visibly a different experiment', () => {
    const fingerprint = taskPackFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(taskPackFingerprint(LEVEL2_TASKS.slice(0, MIN_TASKS))).not.toBe(fingerprint);
  });
});

describe('repositories and grading', () => {
  it('derives a revision identity from content alone', () => {
    const task = LEVEL2_TASKS[0];
    if (task === undefined) throw new Error('no task');
    const first = repoRevision(task.files);
    expect(repoRevision({ ...task.files })).toBe(first);
    expect(repoRevision({ ...task.files, 'extra.txt': 'x' })).not.toBe(first);
    const renamed: Record<string, string> = {};
    for (const [key, value] of Object.entries(task.files)) {
      renamed[key === 'README.md' ? 'README2.md' : key] = value;
    }
    expect(repoRevision(renamed)).not.toBe(first);
  });

  it('restores edited graded files and reports what it restored', async () => {
    const task = LEVEL2_TASKS[0];
    if (task === undefined) throw new Error('no task');
    await withTempDir(async (directory) => {
      await provisionTaskRepo(directory, task);
      const graded = task.gradedFiles[0];
      if (graded === undefined) throw new Error('no graded file');
      await writeFile(path.join(directory, graded), 'test("trivially passes", () => {});\n', 'utf8');
      const changed = await restoreGradedFiles(directory, task);
      expect(changed).toEqual([graded]);
      expect(await restoreGradedFiles(directory, task)).toEqual([]);
    });
  });

  it('accepts the correct solution and rejects both a wrong and a cheating one', async () => {
    const task = LEVEL2_TASKS.find((entry) => entry.category === 'read-and-edit');
    if (task === undefined) throw new Error('no read-and-edit task');

    await withTempDir(async (directory) => {
      const initial = path.join(directory, 'initial');
      await provisionTaskRepo(initial, task);
      expect((await gradeTask(task, initial)).passed).toBe(false);

      const golden = path.join(directory, 'golden');
      await provisionTaskRepo(golden, task);
      await applyFiles(golden, task.goldenFiles);
      expect((await gradeTask(task, golden)).passed).toBe(true);

      const cheating = path.join(directory, 'cheating');
      await provisionTaskRepo(cheating, task);
      await weakenGradedFiles(cheating, task);
      const cheatingResult = await gradeTask(task, cheating);
      expect(cheatingResult.passed).toBe(false);
      expect(cheatingResult.checks.every((check) => typeof check.detail === 'string')).toBe(true);
    });
  });

  it('snapshots the repository without its harness directories', async () => {
    const task = LEVEL2_TASKS[0];
    if (task === undefined) throw new Error('no task');
    await withTempDir(async (directory) => {
      await provisionTaskRepo(directory, task);
      const before = await snapshotRevision(directory);
      await provisionTaskRepo(path.join(directory, '.opencode', 'plugin'), task);
      expect(await snapshotRevision(directory)).toBe(before);
    });
  });
});

describe('the run plan', () => {
  it('meets the design\u2019s minimum samples and alternates the arms', () => {
    const plan = buildPlan({ declarationFingerprint: resolveLevel2Declaration().fingerprint });
    expect(plan.tasks.length).toBeGreaterThanOrEqual(MIN_TASKS);
    expect(plan.pairsPerTask).toBe(MIN_PAIRS_PER_TASK);
    expect(validatePlan(plan)).toEqual([]);

    for (const taskId of plan.tasks) {
      const pairs = plan.runs.filter((run) => run.taskId === taskId);
      const pair0 = pairs.filter((run) => run.pairIndex === 0).map((run) => run.arm);
      const pair1 = pairs.filter((run) => run.pairIndex === 1).map((run) => run.arm);
      expect(pair0).toEqual(['control', 'treatment']);
      expect(pair1).toEqual(['treatment', 'control']);
    }
  });

  it('refuses a plan below the minimum samples', () => {
    expect(() => buildPlan({ pairsPerTask: 1, declarationFingerprint: 'x' })).toThrow(/at least 3 pairs/);
    expect(() =>
      buildPlan({ tasks: LEVEL2_TASKS.slice(0, 2), declarationFingerprint: 'x' }),
    ).toThrow(/at least 5 tasks/);
  });

  it('detects a tampered plan', () => {
    const plan = buildPlan({ declarationFingerprint: 'abc' });
    const firstTwo = plan.runs.slice(0, 2);
    const first = firstTwo[0];
    const second = firstTwo[1];
    if (first === undefined || second === undefined) throw new Error('plan is too small');
    const tampered = {
      ...plan,
      runs: [{ ...first, arm: second.arm }, second, ...plan.runs.slice(2)],
    } as typeof plan;
    expect(validatePlan(tampered).join(' ')).toMatch(/same arm twice|does not follow/);
  });

  it('allows an explicitly incomplete plan for the scripted rehearsal only', () => {
    const task = LEVEL2_TASKS[0];
    if (task === undefined) throw new Error('no task');
    const rehearsal = buildPlan({
      pairsPerTask: 1,
      tasks: [task],
      declarationFingerprint: 'abc',
      allowIncomplete: true,
    });
    expect(rehearsal.armRunsTotal).toBe(2);
    expect(validatePlan(rehearsal).length).toBeGreaterThan(0);
  });
});

describe('the declared variant', () => {
  it('names one axis and two configurations', () => {
    expect(declaration.axis).toBe('optimizer-configuration');
    expect(configurationFor('control')).toBe(declaration.control.optimizerConfiguration);
    expect(configurationFor('treatment')).toBe(declaration.treatment.optimizerConfiguration);
    expect(configurationFor('control')).not.toBe(configurationFor('treatment'));
    expect(safeModeSettingFor('control')).toBe('off');
    expect(safeModeSettingFor('treatment')).toBe('apply');
  });
});

describe('arm records', () => {
  it('shares one input identity across the arms of a pair', () => {
    const control = syntheticObservation({ arm: 'control', taskPassed: true, inputTokens: 1_000, outputTokens: 200 });
    const treatment = syntheticObservation({ arm: 'treatment', taskPassed: true, inputTokens: 900, outputTokens: 200 });
    expect(pairInputHash(control, declaration)).toBe(pairInputHash(treatment, declaration));

    const drifted = syntheticObservation({
      arm: 'treatment',
      taskPassed: true,
      inputTokens: 900,
      outputTokens: 200,
      promptHash: digest('another instruction'),
    });
    expect(pairInputHash(drifted, declaration)).not.toBe(pairInputHash(control, declaration));
  });

  it('never derives a token total and keeps per-field values measured', () => {
    const observation = syntheticObservation({ arm: 'treatment', taskPassed: true, inputTokens: 900, outputTokens: 200 });
    const metrics = armMetrics(observation);
    expect(metrics.totalTokens.evidence).toBe('unavailable');
    expect(metrics.inputTokens).toEqual({ evidence: 'measured', value: 900 });
    expect(metrics.outputTokens).toEqual({ evidence: 'measured', value: 200 });
    expect(metrics.toolCalls).toEqual({ evidence: 'measured', value: 4 });
    expect(metrics.durationMs.evidence).toBe('measured');
  });

  it('leaves an unreported field unavailable rather than zero', () => {
    const observation = syntheticObservation({ arm: 'control', taskPassed: true, inputTokens: 100, outputTokens: 10 });
    const withoutInput: Level2ArmObservation = {
      ...observation,
      usage: { ...observation.usage, inputTokens: undefined },
    };
    expect(armMetrics(withoutInput).inputTokens.evidence).toBe('unavailable');
  });

  it('records the declared arm in provenance and keeps correctness names identical across arms', () => {
    const control = syntheticObservation({ arm: 'control', taskPassed: true, inputTokens: 100, outputTokens: 10 });
    const treatment = syntheticObservation({ arm: 'treatment', taskPassed: true, inputTokens: 90, outputTokens: 10 });
    const controlRecord = buildArmRunRecord(control, declaration);
    const treatmentRecord = buildArmRunRecord(treatment, declaration);

    expect(controlRecord.provenance.variant?.variantId).toBe('control');
    expect(treatmentRecord.provenance.variant?.variantId).toBe('safe-mode-v1');
    expect(controlRecord.provenance.optimizerConfiguration).not.toBe(
      treatmentRecord.provenance.optimizerConfiguration,
    );
    expect(controlRecord.correctness.checks.map((check) => check.name)).toEqual(
      treatmentRecord.correctness.checks.map((check) => check.name),
    );
    expect(controlRecord.contextPreservedExactly).toBe(true);
    expect(treatmentRecord.contextPreservedExactly).toBe(false);
  });
});

describe('mechanism classification', () => {
  const applied = { requestsAttempted: 2, requestsApplied: 1, elidedOccurrences: 1, elidedBytes: 900, markerBytes: 178 };

  it('calls a treatment run fired when its marker reached the endpoint', () => {
    expect(
      classifyMechanism('treatment', applied, wire({ requests: [{ seq: 0, bodyBytes: 5_000, markerCount: 1 }] })),
    ).toBe('fired');
  });

  it('labels a run with no wire observation fired-counters-only rather than fired', () => {
    expect(
      classifyMechanism('treatment', applied, wire({ source: 'hook-unmeasurable', requests: [], hookInvocations: 3 })),
    ).toBe('fired-counters-only');
  });

  it('treats a treatment run with counters but no marker as unexplained', () => {
    expect(classifyMechanism('treatment', applied, wire())).toBe('unexplained');
  });

  it('treats a size increase as unexplained rather than as the mechanism', () => {
    expect(
      classifyMechanism(
        'treatment',
        { ...applied, elidedBytes: 100, markerBytes: 178 },
        wire({ requests: [{ seq: 0, bodyBytes: 5_000, markerCount: 1 }] }),
      ),
    ).toBe('unexplained');
  });

  it('records no-opportunity when nothing was elided and nothing was marked', () => {
    const nothing = { requestsAttempted: 2, requestsApplied: 0, elidedOccurrences: 0, elidedBytes: 0, markerBytes: 0 };
    expect(classifyMechanism('treatment', nothing, wire())).toBe('no-opportunity');
    expect(classifyMechanism('treatment', undefined, wire())).toBe('no-opportunity');
  });

  it('refuses a control run that carried apply evidence or a marker', () => {
    expect(classifyMechanism('control', undefined, wire())).toBe('not-applicable');
    expect(classifyMechanism('control', applied, wire())).toBe('unexplained');
    expect(
      classifyMechanism('control', undefined, wire({ requests: [{ seq: 0, bodyBytes: 10, markerCount: 1 }] })),
    ).toBe('unexplained');
  });
});

describe('artifact intake', () => {
  const base = {
    taskId: 'read-and-edit-total',
    arm: 'treatment',
    runId: 'read-and-edit-total:p0:treatment',
    pairIndex: 0,
    attempt: 1,
    startedAt: '2026-10-11T00:00:00.000Z',
    durationMs: 1_000,
    harness: 'opencode-coding-task',
    optimizerRevision: '0.0.0',
    repositoryRevision: digest('repo'),
    promptHash: digest('prompt'),
    model: 'test/model',
    grading: { passed: true, command: 'node --test', exitCode: 0, timedOut: false, durationMs: 1, outputDigest: digest('out'), outputExcerpt: '', checks: [] },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    behaviour: { toolCalls: 2, repeatedFileReads: 1 },
    wire: { source: 'loopback-endpoint', requests: [{ seq: 0, bodyBytes: 100, markerCount: 0 }], hookInvocations: 1, unmeasurableRequests: 0 },
  };

  it('recomputes the mechanism instead of believing the artifact', () => {
    const claimed = readArmArtifact({ ...base, apply: undefined, mechanism: 'fired' });
    expect(claimed.observation?.mechanism).toBe('no-opportunity');

    const honest = readArmArtifact({
      ...base,
      apply: { requestsAttempted: 2, requestsApplied: 1, elidedOccurrences: 1, elidedBytes: 900, markerBytes: 178 },
      wire: { ...base.wire, requests: [{ seq: 0, bodyBytes: 100, markerCount: 1 }] },
    });
    expect(honest.observation?.mechanism).toBe('fired');
  });

  it('rejects an artifact that is not an object, or is missing identity', () => {
    expect(readArmArtifact('not an artifact').observation).toBeUndefined();
    expect(readArmArtifact({ arm: 'treatment' }).problems.length).toBeGreaterThan(0);
  });

  it('surfaces a refused model as its own outcome rather than as zero usage', () => {
    const refused = readArmArtifact({
      ...base,
      modelUnavailable: true,
      usage: {},
      wire: { source: 'none', requests: [], hookInvocations: 0, unmeasurableRequests: 0 },
    });
    expect(refused.modelUnavailable).toBe(true);
    // A refused session must not look like a successful one that reported nothing.
    expect(refused.observation?.model).toBeUndefined();
    expect(refused.observation?.usage.inputTokens).toBeUndefined();

    const normal = readArmArtifact(base);
    expect(normal.modelUnavailable).toBe(false);
  });

  it('refuses an artifact for a different task, arm or pair', () => {
    const read = readArmArtifact(base, { taskId: 'other-task', arm: 'control', pairIndex: 2 });
    expect(read.observation).toBeUndefined();
    expect(read.problems.join(' ')).toMatch(/not "other-task"|not the control arm|not pair 2/);
  });

  it('treats an absent token field as unavailable and a negative or fractional one as a problem', () => {
    const absent = readArmArtifact({ ...base, usage: { outputTokens: 5 } });
    expect(absent.observation?.usage.inputTokens).toBeUndefined();

    const fractional = readArmArtifact({ ...base, behaviour: { toolCalls: 1.5 } });
    expect(fractional.problems.join(' ')).toMatch(/whole, non-negative/);
  });

  it('reads containment and governor evidence, and refuses an unrecognized guard verdict', () => {
    const read = readArmArtifact({
      ...base,
      containment: {
        guard: 'loaded',
        rootKnown: true,
        blockedCalls: 1,
        allowedCalls: 2,
        blockedByTool: { read: 1 },
        permissionRules: [{ action: 'shell', effect: 'deny', resource: 'any' }],
        configDigest: digest('config'),
      },
      inSessionGovernor: {
        armed: true,
        reason: undefined,
        capUsd: 0.5,
        polls: 4,
        reportedCostUsd: 0.12,
        interrupted: false,
        interruptAttempts: 0,
        killedAfterFailedInterrupt: false,
      },
    });
    expect(read.observation?.containment).toMatchObject({
      guard: 'loaded',
      blockedCalls: 1,
      blockedByTool: { read: 1 },
    });
    expect(read.observation?.inSessionGovernor).toMatchObject({ armed: true, capUsd: 0.5, polls: 4 });

    // An unrecognized verdict is refused outright: a run whose containment cannot be
    // read must never look like a run that had it.
    const unrecognized = readArmArtifact({ ...base, containment: { guard: 'maybe', rootKnown: true } });
    expect(unrecognized.observation).toBeUndefined();
    expect(unrecognized.problems.join(' ')).toMatch(/containment.guard/);
  });
});

describe('the usage cap', () => {
  const observation = (
    inputTokens: number | undefined,
    outputTokens: number | undefined,
    costUsd: number | undefined = undefined,
  ) => {
    const base = syntheticObservation({
      arm: 'treatment',
      taskPassed: true,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
    });
    return {
      ...base,
      usage: {
        ...base.usage,
        inputTokens,
        outputTokens,
        costUsd,
        // The synthetic baseline fills the cache fields with `0`, which is a reported
        // value rather than a gap. A run that reported nothing has to report nothing in
        // every field, or the test would be asserting about a run that did report.
        ...(inputTokens === undefined && outputTokens === undefined
          ? { cacheReadTokens: undefined, cacheWriteTokens: undefined }
          : {}),
      },
    };
  };

  /** No cap at all, for the tests that only exercise the unit bounds. */
  const uncapped = { maxCostUsd: undefined, maxCostUsdPerRun: undefined };

  it('reads the reported cost, and refuses to invent one', () => {
    expect(reportedCostUsd(observation(1_000, 100, 0.1234))).toBe(0.1234);
    expect(reportedCostUsd(observation(1_000, 100, 0))).toBe(0);
    expect(reportedCostUsd(observation(1_000, 100, undefined))).toBeUndefined();
    expect(reportedCostUsd(observation(1_000, 100, -1))).toBeUndefined();
  });

  it('counts every reported field, and reports a run with nothing reported as zero units', () => {
    const reported = observation(1_000, 200);
    expect(conservativeTokenUnits(reported)).toBe(1_200);
    expect(hasNoReportedUsage(reported)).toBe(false);

    const nothing = observation(undefined, undefined);
    expect(conservativeTokenUnits(nothing)).toBe(0);
    // Zero units, but flagged: a session that reported nothing may still have spent
    // something, and the report must not imply it was free.
    expect(hasNoReportedUsage(nothing)).toBe(true);
  });

  it('stops on the per-session cap, and never allows another session after that', () => {
    const tracker = createBudgetTracker({
      maxUnitsPerRun: 1_000,
      maxTotalUnits: 1_000_000,
      ...uncapped,
    });
    expect(tracker.observe(observation(500, 100)).allowed).toBe(true);

    const stop = tracker.observe(observation(2_000, 0));
    expect(stop.allowed).toBe(false);
    expect(stop.reason).toBe('per-run-cap');
    expect(tracker.state()).toMatchObject({ runs: 2, spentUnits: 2_600 });
  });

  it('stops on the cumulative cap once the total is passed', () => {
    const tracker = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: 1_500,
      ...uncapped,
    });
    expect(tracker.observe(observation(1_000, 0)).allowed).toBe(true);
    const stop = tracker.observe(observation(600, 0));
    expect(stop.allowed).toBe(false);
    expect(stop.reason).toBe('total-cap');
    expect(tracker.describe()).toMatch(/accounting bound, never a reported measurement/);
  });

  it('caps nothing when no cap is configured', () => {
    const tracker = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: undefined,
      ...uncapped,
    });
    expect(tracker.observe(observation(10_000_000, 0)).allowed).toBe(true);
  });

  it('counts a run with no reported usage and surfaces it', () => {
    const tracker = createBudgetTracker({ maxUnitsPerRun: 10, maxTotalUnits: 10, ...uncapped });
    expect(tracker.observe(observation(undefined, undefined)).allowed).toBe(true);
    expect(tracker.state().runsWithoutReportedUsage).toBe(1);
  });

  it('sums the provider-reported cost and stops on the per-session spending cap', () => {
    const tracker = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: undefined,
      maxCostUsdPerRun: 0.5,
      maxCostUsd: 5,
    });
    expect(tracker.observe(observation(1_000, 100, 0.2)).allowed).toBe(true);

    const stop = tracker.observe(observation(1_000, 100, 0.75));
    expect(stop.allowed).toBe(false);
    expect(stop.reason).toBe('per-run-cost-cap');
    expect(tracker.state()).toMatchObject({ spentCostUsd: 0.95, lastRunCostUsd: 0.75 });
  });

  it('stops on the cumulative spending cap', () => {
    const tracker = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: undefined,
      maxCostUsdPerRun: 10,
      maxCostUsd: 0.5,
    });
    expect(tracker.observe(observation(1_000, 100, 0.3)).allowed).toBe(true);

    const stop = tracker.observe(observation(1_000, 100, 0.3));
    expect(stop.allowed).toBe(false);
    expect(stop.reason).toBe('total-cost-cap');
    expect(stop.detail).toMatch(/0\.6000/);
  });

  it('treats a reported zero cost as a value, not as a missing measurement', () => {
    const tracker = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: undefined,
      maxCostUsdPerRun: 0.5,
      maxCostUsd: 1,
    });
    // A free model reports 0; that must not be confused with "no cost was reported".
    expect(tracker.observe(observation(1_000, 100, 0)).allowed).toBe(true);
    expect(tracker.state()).toMatchObject({ spentCostUsd: 0, runsWithoutReportedCost: 0 });
  });

  it('fails closed when a spending cap is set and a session reports no cost', () => {
    const tracker = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: undefined,
      maxCostUsdPerRun: undefined,
      maxCostUsd: 5,
    });
    const stop = tracker.observe(observation(1_000, 100, undefined));
    expect(stop.allowed).toBe(false);
    expect(stop.reason).toBe('cost-unreported');
    expect(tracker.state().runsWithoutReportedCost).toBe(1);
  });

  it('does not fail closed on an unreported cost when no spending cap is set', () => {
    const tracker = createBudgetTracker({ maxUnitsPerRun: 10_000, maxTotalUnits: 10_000, ...uncapped });
    expect(tracker.observe(observation(1_000, 100, undefined)).allowed).toBe(true);
    expect(tracker.state().runsWithoutReportedCost).toBe(1);
  });

  it('counts a retry against the same caps as the run it retries', () => {
    // A retry is a fresh session, so the harness records it as another arm run — but the *budget* is
    // per experiment, not per attempt. A retry that cost money must be visible to the same total
    // bound, or a plan could retry past its authorization.
    const tracker = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: 1_500,
      maxCostUsdPerRun: undefined,
      maxCostUsd: 0.5,
    });
    const attempt = (number_: number, input: number, cost: number) => ({
      ...observation(input, 0, cost),
      identity: { ...observation(input, 0, cost).identity, attempt: number_ },
    });

    expect(tracker.observe(attempt(1, 1_000, 0.3)).allowed).toBe(true);
    // The retry of the same run is a second observation: it pushes the total past the cap.
    const stop = tracker.observe(attempt(2, 1_000, 0.3));
    expect(stop.allowed).toBe(false);
    expect(stop.reason).toBe('total-cost-cap');
    expect(tracker.state()).toMatchObject({ runs: 2, spentCostUsd: 0.6, spentUnits: 2_000 });
  });

  it('describes both bounds, and never calls a bound a measurement', () => {
    const tracker = createBudgetTracker({
      maxUnitsPerRun: 1_000,
      maxTotalUnits: 2_000,
      maxCostUsdPerRun: 0.25,
      maxCostUsd: 1.5,
    });
    const described = tracker.describe();
    expect(described).toMatch(/per-session 1000 unit\(s\) \/ \$0\.25/);
    expect(described).toMatch(/total 2000 unit\(s\) \/ \$1\.50/);
    expect(described).toMatch(/stopped when a spending cap is set|stops the run/);
  });
});

describe('the runtime catalogue gate', () => {
  const probe = (overrides: Partial<ArmEnvironmentProbe> = {}): ArmEnvironmentProbe => ({
    cli: 'opencode-cli',
    runtimeVersion: '2.0.24',
    isolatedConfigHome: 'C:/tmp/iso/config',
    isolatedDataHome: 'C:/tmp/iso/data',
    modelRequested: 'opencode/gpt-5.4-mini',
    requestedRuntime: 'service',
    storedCredentials: 2,
    isolatedPaths: { config: 'C:/tmp/iso/config/opencode', data: 'C:/tmp/iso/data/opencode' },
    unisolatedPaths: { config: 'C:/Users/dev/.config/opencode', data: 'C:/Users/dev/.local/share/opencode' },
    isolatedStore: true,
    isolatedConfigSources: ['C:/tmp/iso/config/opencode'],
    unisolatedConfigSources: ['C:/Users/dev/.config/opencode/opencode.jsonc'],
    standaloneCatalogue: 0,
    standaloneModelListed: false,
    serviceCatalogue: 42,
    serviceModelListed: true,
    pricing: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    modelStatus: 'active',
    contextLimit: 400_000,
    notes: [],
    ...overrides,
  });

  it('allows a runtime whose catalogue lists the model', () => {
    expect(probeCanRunModel(probe(), 'service')).toMatchObject({ ok: true, reason: 'ok' });
  });

  it('distinguishes an empty catalogue from a bad identifier', () => {
    // The empty catalogue is the missing-account case: no identifier could work here. Stage 1U's
    // pilot logged this as "Model unavailable: <our model id>" and it was read as a bad id.
    const empty = probeCanRunModel(probe(), 'standalone');
    expect(empty.reason).toBe('no-catalogue');
    expect(empty.detail).toMatch(/missing-account case, not a bad model identifier/);

    const unlisted = probeCanRunModel(probe({ serviceModelListed: false }), 'service');
    expect(unlisted.reason).toBe('model-not-listed');
    expect(unlisted.detail).toMatch(/does not offer `opencode\/gpt-5\.4-mini`/);
    expect(unlisted.detail).toMatch(/identifier or its provider is the problem/);
  });

  it('refuses when no runtime reported a catalogue at all', () => {
    const verdict = probeCanRunModel(
      probe({ serviceCatalogue: 0, serviceModelListed: false }),
      'service',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('no-catalogue');
    expect(verdict.detail).toMatch(/no running service reported a model catalogue/);
  });
});

describe('the isolation proof', () => {
  const probe = (overrides: Partial<ArmEnvironmentProbe> = {}): ArmEnvironmentProbe => ({
    cli: 'opencode-cli',
    runtimeVersion: '2.0.24',
    isolatedConfigHome: 'C:\\tmp\\iso\\config',
    isolatedDataHome: 'C:\\tmp\\iso\\data',
    modelRequested: 'opencode/gpt-5.4-mini',
    requestedRuntime: 'standalone',
    storedCredentials: 0,
    isolatedStore: true,
    isolatedConfigSources: ['C:\\tmp\\iso\\config\\opencode'],
    unisolatedConfigSources: [
      'C:\\Users\\dev\\.config\\opencode\\opencode.jsonc',
      'C:\\Users\\dev\\.config\\opencode',
    ],
    isolatedPaths: {
      config: 'C:\\tmp\\iso\\config\\opencode',
      data: 'C:\\tmp\\iso\\data\\opencode',
    },
    unisolatedPaths: {
      config: 'C:\\Users\\dev\\.config\\opencode',
      data: 'C:\\Users\\dev\\.local\\share\\opencode',
    },
    standaloneCatalogue: 0,
    standaloneModelListed: false,
    serviceCatalogue: 42,
    serviceModelListed: true,
    pricing: undefined,
    modelStatus: undefined,
    contextLimit: undefined,
    notes: [],
    ...overrides,
  });

  it('is proven when the runtime reports the isolated homes, the control reports others, and the store is there', () => {
    const verdict = isolationVerdict(probe());
    expect(verdict).toMatchObject({ applicable: true, proven: true });
    expect(verdict.detail).toMatch(/used the isolated config and data homes/);
    expect(verdict.detail).toMatch(/all inside the isolated directory/);
    expect(verdict.detail).toMatch(/left its store in the isolated data home/);
  });

  it('is not proven when the private server loads a configuration source outside the isolated root', () => {
    // This is the case that matters most: directories can look isolated while a session still obeys
    // the developer's own configuration file.
    const verdict = isolationVerdict(
      probe({
        isolatedConfigSources: [
          'C:\\tmp\\iso\\config\\opencode',
          'C:\\Users\\dev\\.config\\opencode\\opencode.jsonc',
        ],
      }),
    );
    expect(verdict.proven).toBe(false);
    expect(verdict.detail).toMatch(/loads 1 configuration source\(s\) outside the isolated directory/);
  });

  it('is not proven when the private server reports no configuration source at all', () => {
    const verdict = isolationVerdict(probe({ isolatedConfigSources: [] }));
    expect(verdict.proven).toBe(false);
    expect(verdict.detail).toMatch(/reported no configuration source at all/);
  });

  it('is not applicable on the service runtime, and says why instead of pretending', () => {
    const verdict = isolationVerdict(probe(), 'service');
    expect(verdict.applicable).toBe(false);
    expect(verdict.proven).toBe(false);
    expect(verdict.detail).toMatch(/not applicable on the background service/);
  });

  it('is not proven when the isolated data home holds no runtime store', () => {
    const verdict = isolationVerdict(probe({ isolatedStore: false }));
    expect(verdict.proven).toBe(false);
    expect(verdict.detail).toMatch(/holds no runtime store/);
  });

  it('is not proven when the private server ignored the overrides', () => {
    const verdict = isolationVerdict(
      probe({
        isolatedPaths: {
          config: 'C:\\Users\\dev\\.config\\opencode',
          data: 'C:\\Users\\dev\\.local\\share\\opencode',
        },
      }),
    );
    expect(verdict.proven).toBe(false);
    expect(verdict.detail).toMatch(/ignored the isolated home/);
  });

  it('is not proven when the two answers are identical, because then the check cannot distinguish them', () => {
    const verdict = isolationVerdict(
      probe({
        unisolatedPaths: {
          config: 'C:\\tmp\\iso\\config\\opencode',
          data: 'C:\\tmp\\iso\\data\\opencode',
        },
      }),
    );
    expect(verdict.proven).toBe(false);
    expect(verdict.detail).toMatch(/cannot distinguish the two and proves nothing/);
  });

  it('is not proven when the runtime reported no directories at all', () => {
    const verdict = isolationVerdict(
      probe({ isolatedPaths: { config: undefined, data: undefined } }),
    );
    expect(verdict.proven).toBe(false);
    expect(verdict.detail).toMatch(/did not report its own config and data directories/);
  });
});

describe('the live-run guards', () => {
  const input = (overrides: Partial<LiveGuardInput> = {}): LiveGuardInput => ({
    approveLive: true,
    model: 'opencode/gpt-5.4-mini',
    runtime: 'service',
    cliPath: 'opencode-cli.exe',
    cliPresent: true,
    maxRuns: 6,
    planArmRuns: 6,
    maxUnitsPerRun: 1_500_000,
    maxUnits: 6_000_000,
    maxCostUsdPerRun: 0.5,
    maxCostUsd: 2,
    timeoutMs: 600_000,
    ...overrides,
  });

  it('allows a bounded, approved, attributable run', () => {
    expect(liveRunRefusals(input())).toEqual([]);
  });

  it('refuses without explicit approval, a model, or a present CLI', () => {
    expect(liveRunRefusals(input({ approveLive: false })).join(' ')).toMatch(/--approve-live/);
    expect(liveRunRefusals(input({ model: undefined })).join(' ')).toMatch(/requires --model/);
    expect(liveRunRefusals(input({ cliPresent: false })).join(' ')).toMatch(/was not found/);
  });

  it('refuses a plan larger than the run cap', () => {
    expect(liveRunRefusals(input({ maxRuns: 5 })).join(' ')).toMatch(/without --max-runs/);
    expect(liveRunRefusals(input({ maxRuns: undefined })).join(' ')).toMatch(/without --max-runs/);
  });

  it('refuses to start when a hard limit could not be enforced', () => {
    const bothOff = liveRunRefusals(
      input({
        maxUnitsPerRun: undefined,
        maxCostUsdPerRun: undefined,
        maxUnits: undefined,
        maxCostUsd: undefined,
      }),
    ).join(' ');
    expect(bothOff).toMatch(/no per-session cap is configured/);
    expect(bothOff).toMatch(/no total cap is configured/);

    // One bound is not enough: a total-only cap cannot stop one runaway session, and a
    // per-session-only cap cannot bound the sequence.
    const totalOnly = liveRunRefusals(
      input({ maxUnitsPerRun: undefined, maxCostUsdPerRun: undefined }),
    ).join(' ');
    expect(totalOnly).toMatch(/no per-session cap is configured/);
    expect(totalOnly).not.toMatch(/no total cap is configured/);

    const perSessionOnly = liveRunRefusals(input({ maxUnits: undefined, maxCostUsd: undefined })).join(
      ' ',
    );
    expect(perSessionOnly).toMatch(/no total cap is configured/);
    expect(perSessionOnly).not.toMatch(/no per-session cap is configured/);

    // Either currency counts on its own: units where cost is unreported, cost where units are not
    // the concern.
    expect(
      liveRunRefusals(
        input({
          maxUnitsPerRun: undefined,
          maxUnits: undefined,
          maxCostUsdPerRun: 0.5,
          maxCostUsd: 2,
        }),
      ),
    ).toEqual([]);
    expect(
      liveRunRefusals(
        input({
          maxCostUsdPerRun: undefined,
          maxCostUsd: undefined,
          maxUnitsPerRun: 1_500_000,
          maxUnits: 6_000_000,
        }),
      ),
    ).toEqual([]);
  });

  it('prints the bounds an authorization is about to be spent against', () => {
    const described = describeLiveBounds(input());
    expect(described).toMatch(/per session 1500000 unit\(s\) \/ \$0\.50/);
    expect(described).toMatch(/total 6000000 unit\(s\) \/ \$2\.00/);
    expect(described).toMatch(/session timeout 600000 ms/);
    expect(described).toMatch(/at most 6 arm run\(s\)/);
    // The bounds line must say what is enforced in-session and what is not: on the
    // service runtime the spending cap gets a native interrupt, and nowhere does an
    // in-session request-count or output-token limit exist.
    expect(described).toMatch(/caps are checked after each session/);
    expect(described).toMatch(/native session\.interrupt/);
    expect(described).toMatch(/no in-session request-count or output-token limit is enforced/);

    // On the private server there is no native interrupt to call, and the line says so
    // rather than claiming a bound that is not in force.
    const standalone = describeLiveBounds(input({ runtime: 'standalone' }));
    expect(standalone).toMatch(/the native interrupt targets the background service/);
    expect(standalone).not.toMatch(/when the cap is crossed/);
  });
});

describe('live harness engagement', () => {
  const control = syntheticObservation({
    arm: 'control',
    taskPassed: true,
    inputTokens: 100,
    outputTokens: 50,
  });
  const treatment = syntheticObservation({
    arm: 'treatment',
    taskPassed: true,
    inputTokens: 100,
    outputTokens: 50,
  });

  it('accepts a session the repository-local plugin actually reached', () => {
    expect(checkLiveEngagement(control)).toMatchObject({ measurable: true, stop: false });
    expect(checkLiveEngagement(treatment)).toMatchObject({ measurable: true, stop: false });
    expect(checkLiveEngagement(treatment).detail).toMatch(/the pass attempted 2 of them/);
    expect(checkLiveEngagement(control).detail).toMatch(/containment guard registered its tool hook/);
  });

  it('refuses a session with no containment evidence at all', () => {
    const verdict = checkLiveEngagement({ ...control, containment: undefined });
    expect(verdict).toMatchObject({ measurable: false, stop: true });
    expect(verdict.detail).toMatch(/no containment evidence/);
  });

  it('refuses a session whose containment guard never registered its tool hook', () => {
    const verdict = checkLiveEngagement({
      ...control,
      containment: {
        guard: 'capability-missing',
        rootKnown: true,
        blockedCalls: 0,
        allowedCalls: 0,
        blockedByTool: {},
        permissionRules: undefined,
        configDigest: undefined,
      },
    });
    expect(verdict).toMatchObject({ measurable: false, stop: true });
    expect(verdict.detail).toMatch(/did not register its tool hook/);
  });

  it('refuses a session whose workspace was never determined, because nothing was checked', () => {
    const verdict = checkLiveEngagement({
      ...control,
      containment: {
        guard: 'loaded',
        rootKnown: false,
        blockedCalls: 0,
        allowedCalls: 0,
        blockedByTool: {},
        permissionRules: undefined,
        configDigest: undefined,
      },
    });
    expect(verdict).toMatchObject({ measurable: false, stop: true });
    expect(verdict.detail).toMatch(/could not determine the session workspace/);
  });

  it('stops the plan when no session ever saw the plugin', () => {
    // This is Stage 1U's shape turned into a check: a well-formed artifact for a session
    // that could not have measured anything.
    const silent: Level2ArmObservation = {
      ...treatment,
      wire: { ...treatment.wire, source: 'none', requests: [], hookInvocations: 0 },
    };
    const verdict = checkLiveEngagement(silent);
    expect(verdict.measurable).toBe(false);
    expect(verdict.stop).toBe(true);
    expect(verdict.detail).toMatch(/did not reach the runtime/);
  });

  it('refuses a treatment run whose switch never reached the plugin', () => {
    const noApply: Level2ArmObservation = {
      ...treatment,
      apply: undefined,
      mechanism: 'no-opportunity',
    };
    const verdict = checkLiveEngagement(noApply);
    expect(verdict.measurable).toBe(false);
    expect(verdict.detail).toMatch(/compare the pass off against the pass off/);
  });

  it('refuses a control run that carries apply evidence, because then the pair is not declared', () => {
    const contaminated: Level2ArmObservation = {
      ...control,
      apply: {
        requestsAttempted: 2,
        requestsApplied: 1,
        elidedOccurrences: 1,
        elidedBytes: 512,
        markerBytes: 48,
      },
    };
    const verdict = checkLiveEngagement(contaminated);
    expect(verdict.measurable).toBe(false);
    expect(verdict.detail).toMatch(/the pass was on in both/);
  });

  it('does not treat a coding failure as a harness failure', () => {
    const failed = syntheticObservation({
      arm: 'treatment',
      taskPassed: false,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(checkLiveEngagement(failed).measurable).toBe(true);
  });
});

describe('the experiment report', () => {
  it('summarizes deltas as a distribution, including a mixed sign', () => {
    expect(describeDistribution([-100, -200, -300])).toMatchObject({
      samples: 3,
      median: -200,
      min: -300,
      max: -100,
      consistentSign: true,
    });
    expect(describeDistribution([-100, 50]).consistentSign).toBe(false);
    expect(describeDistribution([])).toMatchObject({ samples: 0, median: 0 });
  });

  it('compares a fired pair per field and excludes a refused pair from the deltas', () => {
    const plan = buildPlan({
      pairsPerTask: 1,
      tasks: [LEVEL2_TASKS[0] as (typeof LEVEL2_TASKS)[number]],
      declarationFingerprint: resolveLevel2Declaration().fingerprint,
      allowIncomplete: true,
    });
    const task = LEVEL2_TASKS[0];
    if (task === undefined) throw new Error('no task');

    const experiment = buildExperiment(
      [
        syntheticObservation({ arm: 'control', taskId: task.id, taskPassed: true, inputTokens: 1_000, outputTokens: 200 }),
        syntheticObservation({ arm: 'treatment', taskId: task.id, taskPassed: true, inputTokens: 900, outputTokens: 200 }),
      ],
      plan,
      [task],
    );

    expect(experiment.pairs).toHaveLength(1);
    expect(experiment.pairs[0]?.mechanism).toBe('fired');
    expect(experiment.pairs[0]?.verdict).not.toBe('invalid');
    const input = experiment.tasks[0]?.fields.find((field) => field.field === 'inputTokens');
    expect(input !== undefined && isAvailable(input.delta)).toBe(true);
    expect(input !== undefined && isAvailable(input.delta) ? input.delta.value.median : undefined).toBe(-100);
    expect(experiment.meetsMinimumSamples).toBe(false);

    // A pair whose treatment failed the task is not comparable, so it contributes no
    // delta: refusal must not leak a number into the report.
    const refused = buildExperiment(
      [
        syntheticObservation({ arm: 'control', taskId: task.id, taskPassed: true, inputTokens: 1_000, outputTokens: 200 }),
        syntheticObservation({ arm: 'treatment', taskId: task.id, taskPassed: false, inputTokens: 900, outputTokens: 200 }),
      ],
      plan,
      [task],
    );
    expect(refused.pairs[0]?.correctnessRegression).toBe(true);
    expect(
      refused.tasks[0]?.fields.every((field) => !isAvailable(field.delta)),
    ).toBe(true);
  });

  it('refuses to form a pair whose arms disagree about the instruction', () => {
    const task = LEVEL2_TASKS[0];
    if (task === undefined) throw new Error('no task');
    const plan = buildPlan({
      pairsPerTask: 1,
      tasks: [task],
      declarationFingerprint: resolveLevel2Declaration().fingerprint,
      allowIncomplete: true,
    });
    const experiment = buildExperiment(
      [
        syntheticObservation({ arm: 'control', taskId: task.id, taskPassed: true, inputTokens: 1_000, outputTokens: 200 }),
        syntheticObservation({
          arm: 'treatment',
          taskId: task.id,
          taskPassed: true,
          inputTokens: 900,
          outputTokens: 200,
          promptHash: digest('a different instruction'),
        }),
      ],
      plan,
      [task],
    );

    expect(experiment.pairs).toHaveLength(0);
    expect(experiment.notes.join(' ')).toMatch(/input identity/);
  });
});
