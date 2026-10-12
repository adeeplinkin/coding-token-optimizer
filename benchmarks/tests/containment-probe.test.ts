import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CLI_PATH, runContainmentProbe } from '../src/level2/index.js';
import type { ContainmentProbeRun } from '../src/level2/index.js';

/**
 * Containment **enforcement**, at the real plugin/tool boundary.
 *
 * The unit tests prove the policy function; the rehearsal proves the guard loads. Neither can show
 * that a prohibited call is actually refused by the installed runtime — that is what these do, in
 * one real scripted session per case, with the provider's own capture and the filesystem as the
 * observations rather than the guard's report of itself.
 *
 * Two cases, and the second is the one a green-looking harness would get wrong:
 *
 * - a healthy session refuses every prohibited call, allows the permitted ones, and the
 *   benchmark's own engagement gate *accepts* it (the positive control);
 * - a session whose guard never registered is still a complete, well-formed run — and the same
 *   gate refuses it instead of publishing an unenforced session.
 *
 * These spawn the pinned OpenCode runtime against a loopback scripted provider: no model is called,
 * no credential is read and nothing is billed. Where the runtime is not installed they skip rather
 * than pass, and the suite's summary reports them as skipped.
 */

const INTEGRATIONS = fileURLToPath(new URL('../../integrations/opencode/', import.meta.url));
const PLUGIN_MODULE = join(INTEGRATIONS, 'dist', 'index.js');
const cliPresent = existsSync(DEFAULT_CLI_PATH);
const pluginBuilt = existsSync(PLUGIN_MODULE);

/** Work root for both cases; removed afterwards, since the findings point at it. */
let workRoot = '';
/** A plugin module that exports everything the arm driver needs *except* the guard factory. */
let brokenGuardModule = '';
/** A plugin module whose governor loop throws at start, as a wiring fault would. */
let throwingGovernorModule = '';

function refusedSteps(run: ContainmentProbeRun) {
  return run.steps.filter((step) => step.expectation === 'refused');
}

/** The marker phrases the probe placed: the guard's evidence may not carry their text. */
function canaries(run: ContainmentProbeRun): readonly string[] {
  return run.canaries;
}

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'dr-token-containment-probe-'));
  // The broken-guard module: the observer and the governor helpers still resolve, so the session
  // is a normal one in every respect except that the containment guard cannot be constructed.
  brokenGuardModule = join(workRoot, 'broken-guard-module.mjs');
  const pluginUrl = pathToFileURL(PLUGIN_MODULE).href;
  await writeFile(
    brokenGuardModule,
    [
      `import * as real from ${JSON.stringify(pluginUrl)};`,
      `export { default } from ${JSON.stringify(pluginUrl)};`,
      'export const startCostGovernor = real.startCostGovernor;',
      'export const decideCostGovernor = real.decideCostGovernor;',
      'export const latestSessionCostUsd = real.latestSessionCostUsd;',
      'export const planGovernorArming = real.planGovernorArming;',
      'export const summarizeContainmentEvidence = real.summarizeContainmentEvidence;',
      'export const CONTAINMENT_DENIED_TOOLS = real.CONTAINMENT_DENIED_TOOLS;',
      'export const createOpenCodeObserverPluginV2 = real.createOpenCodeObserverPluginV2;',
      'export const createSummaryFileSink = real.createSummaryFileSink;',
      // The pre-transmission model guard is intact, so the only missing capability is the containment
      // guard itself: the driver starts the session and the session runs, which is exactly the shape
      // that used to look enforceable.
      'export const createModelGuardPluginV2 = real.createModelGuardPluginV2;',
      'export const summarizeModelGuardEvidence = real.summarizeModelGuardEvidence;',
      '// createContainmentGuardPluginV2 is deliberately not exported.',
      '',
    ].join('\n'),
    'utf8',
  );

  throwingGovernorModule = join(workRoot, 'throwing-governor-module.mjs');
  await writeFile(
    throwingGovernorModule,
    [
      `import * as real from ${JSON.stringify(pluginUrl)};`,
      `export { default } from ${JSON.stringify(pluginUrl)};`,
      'export const decideCostGovernor = real.decideCostGovernor;',
      'export const latestSessionCostUsd = real.latestSessionCostUsd;',
      'export const planGovernorArming = real.planGovernorArming;',
      'export const summarizeContainmentEvidence = real.summarizeContainmentEvidence;',
      'export const CONTAINMENT_DENIED_TOOLS = real.CONTAINMENT_DENIED_TOOLS;',
      'export const createContainmentGuardPluginV2 = real.createContainmentGuardPluginV2;',
      'export const createOpenCodeObserverPluginV2 = real.createOpenCodeObserverPluginV2;',
      'export const createSummaryFileSink = real.createSummaryFileSink;',
      // The model guard and the containment guard are both intact: the fault under test is the
      // governor's, so the driver must reach the governor start rather than refuse on a guard.
      'export const createModelGuardPluginV2 = real.createModelGuardPluginV2;',
      'export const summarizeModelGuardEvidence = real.summarizeModelGuardEvidence;',
      '// The planner will say this build can arm, and then the start throws, as a wiring fault did.',
      'export const startCostGovernor = () => {',
      "  throw new Error('the governor loop could not start (probe fault)');",
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterAll(async () => {
  if (workRoot.length > 0) {
    await rm(workRoot, { recursive: true, force: true });
  }
});

describe.skipIf(!cliPresent || !pluginBuilt)(
  'containment enforcement at the real plugin boundary (requires the built plugin and the installed runtime)',
  () => {
    /** One healthy session, used by the assertions below so it runs once. */
    let healthy: ContainmentProbeRun | undefined;

    beforeAll(async () => {
      healthy = await runContainmentProbe({
        workspaceRoot: workRoot,
        cliPath: DEFAULT_CLI_PATH,
        arm: 'control',
        timeoutMs: 120_000,
      });
    }, 180_000);

    it('runs a real session whose artifact is this run’s own, complete output', () => {
      expect(healthy).toBeDefined();
      expect(healthy?.provenanceOk).toBe(true);
      expect(healthy?.invalidReason).toBeUndefined();
      expect(healthy?.runtimeVersion).toBeDefined();
      expect(healthy?.engagement).toBeDefined();
    });

    it('permits in-workspace work, so the refusals below cannot pass vacuously', () => {
      const read = healthy?.steps.find((step) => step.id === 'read-inside');
      expect(read?.outcome).toBe('content');
      expect(read?.allowedTextReachedProvider).toBe(true);
      expect(healthy?.allowedWriteCreated).toBe(true);
    });

    it('refuses every prohibited call, with the guard’s own refusal in the result the provider saw', () => {
      const refused = refusedSteps(healthy as ContainmentProbeRun);
      expect(refused.length).toBeGreaterThanOrEqual(7);
      for (const step of refused) {
        expect(step.outcome, `${step.id} was not refused`).toBe('refusal');
        // The refusal is the guard's: its wording is what the runtime sent on to the provider, so
        // this is an observation from outside the guard rather than the guard's own log.
        expect(step.refusedByGuard, `${step.id} was refused by something else`).toBe(true);
        // A call the tool's own schema rejected never reaches the guard, and must never be
        // mistaken for a policy refusal.
        expect(step.argumentSchemaFailure, `${step.id} never reached the tool`).toBe(false);
        expect(step.forbiddenTextReachedProvider, `${step.id} delivered forbidden text`).toBe(false);
      }
    });

    it('leaves no trace: no shell marker, no escaped write, no escaped patch, no fetch', () => {
      for (const step of refusedSteps(healthy as ContainmentProbeRun)) {
        expect(step.sideEffectCreated, `${step.id} left a side effect`).toBe(false);
      }
      expect(healthy?.fetchTargetsReceived).toEqual([]);
    });

    it('records the refusal classes in the guard’s own evidence', () => {
      expect(healthy?.guard).toBe('loaded');
      expect(healthy?.rootKnown).toBe(true);
      expect(healthy?.blockedCalls).toBeGreaterThanOrEqual(7);
      // Both classes are exercised at the real boundary: the named denied tools, and the path
      // policy for an absolute path and a traversal.
      expect(healthy?.guardBlockReasons).toContain('denied-tool');
      expect(healthy?.guardBlockReasons).toContain('path-outside-workspace');
      for (const tool of ['read', 'write', 'bash', 'apply_patch', 'webfetch', 'task']) {
        expect(Object.keys(healthy?.blockedByTool ?? {}), `${tool} was never refused`).toContain(tool);
      }
    });

    it('keeps the guard’s evidence content-free, with no path and no argument value', () => {
      const evidence = (healthy?.guardEvidenceLines ?? []).join('\n');
      expect(evidence.length).toBeGreaterThan(0);
      for (const canary of canaries(healthy as ContainmentProbeRun)) {
        expect(evidence).not.toContain(canary);
      }
      // The refused paths and commands the session asked for must not appear either.
      expect(evidence).not.toContain('canary-outside-the-workspace');
      expect(evidence).not.toContain('canary-one-level-up');
      expect(evidence).not.toContain('shell-escape-marker');
      expect(evidence).not.toContain('probe-shell-escape');
      expect(evidence).not.toContain('escaped');
    });

    it('is accepted by the benchmark’s own engagement gate (the positive control)', () => {
      // Without this, every refusal above could be the gate refusing a session for some unrelated
      // reason, and the enforcement evidence would mean nothing.
      expect(healthy?.engagement?.measurable).toBe(true);
      expect(healthy?.engagement?.stop).toBe(false);
    });

    it('stops the client when the spending governor cannot start, and refuses the run', async () => {
      // The planner says this build can arm, and the start then throws — the wiring fault that
      // left a spending cap unenforced in Stage 1V. The driver must stop the session rather than
      // run one with an unenforceable bound, and the artifact must say so.
      const faulted = await runContainmentProbe({
        workspaceRoot: workRoot,
        cliPath: DEFAULT_CLI_PATH,
        arm: 'control',
        pluginModule: throwingGovernorModule,
        timeoutMs: 120_000,
      });

      expect(faulted.governor?.armed).toBe(false);
      expect(faulted.governor?.reason ?? '').toContain('failed to start');
      // No session ever reached the provider: the client was stopped at the start path.
      expect(faulted.sessionsObserved).toBe(0);
      expect(faulted.steps.every((step) => step.outcome === 'absent')).toBe(true);
      expect(faulted.fetchTargetsReceived).toEqual([]);
      // And the run cannot be published: a stopped session is not a measurement of zero tokens.
      expect(faulted.provenanceOk).toBe(false);
      expect(faulted.invalidReason).toBe('session-exit-nonzero');
      expect(faulted.engagement).toBeUndefined();
    }, 180_000);

    it('refuses a session whose guard never registered, though its artifact is whole', async () => {
      const broken = await runContainmentProbe({
        workspaceRoot: workRoot,
        cliPath: DEFAULT_CLI_PATH,
        arm: 'control',
        pluginModule: brokenGuardModule,
        timeoutMs: 120_000,
      });

      // The session itself completed: this is exactly the shape that used to be publishable.
      expect(broken.provenanceOk).toBe(true);
      // No tool hook registered, so nothing enforced the policy for that session.
      expect(broken.guard).not.toBe('loaded');
      expect(broken.blockedCalls).toBe(0);
      expect(broken.allowedCalls).toBe(0);
      // And the benchmark refuses it rather than accepting a misleading "guard loaded" result.
      expect(broken.engagement?.measurable).toBe(false);
      expect(broken.engagement?.stop).toBe(true);
      expect(broken.engagement?.detail.length ?? 0).toBeGreaterThan(0);
    }, 180_000);
  },
);
