import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CLI_PATH,
  FREE_ONLY_APPROVED_MODELS,
  FREE_ONLY_AUXILIARY_MODEL,
  FREE_ONLY_PRIMARY_MODEL,
  MODEL_GUARD_PROBE_PLUGIN,
  PROBE_UNAPPROVED_MODEL,
  modelGuardProbeAvailable,
  modelRefToId,
  runModelGuardProbe,
} from '../src/level2/index.js';
import type { ModelGuardProbeRun } from '../src/level2/index.js';

/**
 * Pre-transmission enforcement, measured at the endpoint.
 *
 * The unit tests prove the guard's decision is the one the policy describes; the rehearsal proves
 * the guard travels through the installed runtime and is loaded by both arms. Neither can show the
 * thing this stage exists for: that a request naming a model outside the approved envelope is
 * **stopped before it is dispatched**. So each case here is a real scripted session against a
 * loopback provider, and the observation is the provider's own record of what it received — not the
 * guard's account of itself.
 *
 * Two cases carry the argument, and both are needed:
 *
 * - the guarded case must show a refusal **and an empty endpoint capture**;
 * - the unguarded control must show the same model **arriving** at the endpoint.
 *
 * Without the second, an empty capture could just mean the runtime never had the model; without the
 * first, there is nothing enforcing. These spawn the pinned runtime with no credential and no model
 * call, so nothing is billed. Where the runtime is not installed, or the plugin is not built, the
 * suite skips rather than passing.
 */

const available = modelGuardProbeAvailable();

/** Work root for the matrix; removed afterwards, since the findings point at it. */
let workRoot = '';

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'dr-token-model-guard-probe-'));
});

afterAll(async () => {
  if (workRoot.length > 0) {
    await rm(workRoot, { recursive: true, force: true });
  }
});

describe.skipIf(!available)(
  'pre-transmission model-guard enforcement (requires the built plugin and the installed runtime)',
  () => {
    /** The whole matrix, run once, so the assertions below read the same sessions. */
    let run: ModelGuardProbeRun | undefined;

    beforeAll(async () => {
      run = await runModelGuardProbe({
        workspaceRoot: workRoot,
        cliPath: DEFAULT_CLI_PATH,
        timeoutMs: 120_000,
      });
    }, 600_000);

    const cases = (): ModelGuardProbeRun['cases'] => run?.cases ?? [];

    it('runs every case of the matrix to the outcome it was designed for', () => {
      expect(cases().length).toBeGreaterThanOrEqual(6);
      for (const probeCase of cases()) {
        expect(probeCase.outcome, `${probeCase.id}: ${probeCase.outputTail.join(' | ')}`).toBe(
          probeCase.expected,
        );
      }
      // Nothing about the matrix is inconclusive: a case that could not be classified would leave
      // the properties below unproven without saying so.
      expect(cases().filter((probeCase) => probeCase.outcome === 'inconclusive')).toEqual([]);
      expect(run?.notes).toEqual([]);
    });

    it('refuses an unapproved model of the same provider before it is transmitted', () => {
      const guarded = cases().find((probeCase) => probeCase.id === 'unapproved-model-guarded');
      expect(guarded?.guard).toBe(true);
      // The plugin ran, and the runtime accepted the one hook that refuses a request. Both, because
      // a plugin without the hook bounds nothing.
      expect(guarded?.guardLoaded).toBe(true);
      expect(guarded?.guardHookRegistered).toBe(true);
      expect(guarded?.guardMisconfigured).toBe(false);
      // The refusal names the model and the reason, from the guard's own record.
      expect(guarded?.guardRefusals.some((entry) => entry.startsWith('model-not-approved@primary'))).toBe(
        true,
      );
      // And the endpoint — the only observation that is not the guard's self-report — never received
      // a request at all.
      expect(guarded?.endpointRequests).toBe(0);
      expect(guarded?.endpointModels).toEqual([]);
      expect(guarded?.unauthorizedModelsAtEndpoint).toEqual([]);
      // The session ended because of the guard, not because the runtime could not resolve the model.
      expect(guarded?.runtimeRefusedModel).toBe(false);
      expect(guarded?.exitCode).not.toBe(0);
      expect(run?.unapprovedRefusedBeforeTransmission).toBe(true);
    });

    it('shows, in the unguarded control, that the runtime would have sent that model', () => {
      // This is what makes the case above evidence rather than coincidence: the same model, the same
      // session shape, the same endpoint, with the guard simply absent.
      const control = cases().find((probeCase) => probeCase.id === 'unapproved-model-unguarded');
      expect(control?.guard).toBe(false);
      expect(control?.endpointRequests).toBeGreaterThan(0);
      expect(control?.unauthorizedModelsAtEndpoint.length).toBeGreaterThan(0);
      expect(control?.guardRefusals).toEqual([]);
      expect(run?.unapprovedControlReachedEndpoint).toBe(true);
    });

    it('permits the approved models, so the refusals above cannot pass vacuously', () => {
      const primary = cases().find((probeCase) => probeCase.id === 'approved-primary');
      expect(primary?.outcome).toBe('transmitted-approved');
      expect(primary?.guardRefused).toBe(0);
      expect(primary?.guardAllowed).toBeGreaterThan(0);
      expect(primary?.endpointRequests).toBeGreaterThan(1);
      expect(primary?.endpointModels.every((id) => id === FREE_ONLY_PRIMARY_MODEL.split('/')[1])).toBe(
        true,
      );
      expect(run?.approvedPrimaryReachedEndpoint).toBe(true);

      // The approved auxiliary is permitted *for an auxiliary request*: the guard bounds models, and
      // the benchmark bounds request kinds. An auxiliary request on the approved auxiliary reaches
      // the endpoint, which is what keeps this layer from being a blanket refusal.
      const auxiliary = cases().find((probeCase) => probeCase.id === 'approved-auxiliary-as-title');
      expect(auxiliary?.guardRefused).toBe(0);
      expect(auxiliary?.endpointModels).toContain(FREE_ONLY_AUXILIARY_MODEL.split('/')[1]);
      expect(run?.approvedAuxiliaryReachedEndpoint).toBe(true);
    });

    it('refuses a request assembled mid-session, and lets the rest of the session run', () => {
      // The case the pre-spawn checks cannot see: the configuration, the command line and the
      // resolved policy are all inside the envelope, and the runtime still composes a request on a
      // model outside it. One request is stopped; the session continues on approved models.
      const substitution = cases().find((probeCase) => probeCase.id === 'unapproved-title-model-guarded');
      expect(substitution?.guardRefused).toBeGreaterThan(0);
      expect(substitution?.guardRefusals.some((entry) => entry.startsWith('model-not-approved@title'))).toBe(
        true,
      );
      expect(substitution?.unauthorizedModelsAtEndpoint).toEqual([]);
      expect(substitution?.endpointRequests).toBeGreaterThan(0);
      expect(run?.midSessionSubstitutionRefused).toBe(true);
    });

    it('reports an identifier no runtime knows as a resolution failure, not as a guard refusal', () => {
      // Two different mechanisms with the same visible symptom (a non-zero exit and an empty
      // endpoint): conflating them would let a typo in a model identifier read as enforcement.
      const unknown = cases().find((probeCase) => probeCase.id === 'unknown-model-guarded');
      expect(unknown?.runtimeRefusedModel).toBe(true);
      expect(unknown?.endpointRequests).toBe(0);
      expect(unknown?.guardRefusals).toEqual([]);
      expect(run?.unknownModelRefusedByRuntime).toBe(true);
    });

    it('never lets an unapproved model reach the endpoint while the guard is loaded', () => {
      for (const probeCase of cases().filter((entry) => entry.guard)) {
        expect(
          probeCase.unauthorizedModelsAtEndpoint,
          `${probeCase.id} delivered an unauthorized model to the endpoint`,
        ).toEqual([]);
      }
      expect(run?.noUnauthorizedModelEverReachedEndpoint).toBe(true);
    });

    it('gives the guard the envelope of the configuration it is protecting', () => {
      // The evidence has to name the policy, not merely a decision: a guard bounding a different
      // envelope than the run was configured with would be enforcement of the wrong thing, and the
      // artifact-side gate compares these digests for exactly that reason.
      for (const probeCase of cases().filter((entry) => entry.guard)) {
        expect(probeCase.guardPolicyDigest, `${probeCase.id} recorded no policy digest`).toMatch(
          /^[0-9a-f]{64}$/,
        );
      }
    });

    it('agrees with the benchmark policy about what a model identifier is', async () => {
      // The guard carries its own normalizer because the plugin package may not depend on the
      // benchmark package. Two implementations of "which model is this" is how a paid model slips
      // past a check that believes it is looking at something else, so they are compared directly,
      // over every shape either has been handed.
      const plugin: Record<string, unknown> = (await import(
        pathToFileURL(MODEL_GUARD_PROBE_PLUGIN).href
      )) as Record<string, unknown>;
      const normalize = plugin['normalizeModelId'];
      expect(typeof normalize).toBe('function');
      /** The shapes **both** are handed: what the runtime writes into a payload or a config. */
      const shared: readonly unknown[] = [
        { providerID: 'opencode', model: 'mimo-v2.6-flash-free' },
        { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' },
        { provider: 'opencode', model: 'mimo-v2.6-flash-free' },
        { providerID: 'opencode', id: 'mimo-v2.6-flash-free' },
        { providerID: 'opencode', model: '' },
        { providerID: '', model: 'x' },
        { providerID: '   ', model: '   ' },
        { providerID: ' opencode ', model: ' mimo-v2.6-flash-free ' },
        { providerID: 'opencode' },
        { model: 'mimo-v2.6-flash-free' },
        {},
        null,
        42,
        [],
        'opencode/mimo-v2.6-flash-free',
        '  opencode/mimo-v2.6-flash-free  ',
        'mimo-v2.6-flash-free',
        '',
      ];
      for (const shape of shared) {
        expect(
          (normalize as (value: unknown) => string | undefined)(shape),
          `the guard and the policy disagree about ${JSON.stringify(shape)}`,
        ).toBe(modelRefToId(shape));
      }
      // The one deliberate difference, pinned rather than hidden: a hook payload may carry the model
      // as a nested `{ id }`, which the guard accepts, while the configuration document the policy
      // reader parses always names it as a string. The guard is the more permissive of the two *only*
      // on this shape, and the config reader's `undefined` is the refusal that shape deserves there.
      const nested = { providerID: 'opencode', model: { id: 'mimo-v2.6-flash-free' } };
      expect((normalize as (value: unknown) => string | undefined)(nested)).toBe(
        FREE_ONLY_PRIMARY_MODEL,
      );
      expect(modelRefToId(nested)).toBeUndefined();
    });

    it('names the approved pair in the guard’s envelope, and nothing else', () => {
      // The envelope the probe hands over is the policy's own, so this also pins that the probe is
      // testing the shipped policy rather than a convenient local copy.
      expect([...FREE_ONLY_APPROVED_MODELS]).toEqual([
        FREE_ONLY_PRIMARY_MODEL,
        FREE_ONLY_AUXILIARY_MODEL,
      ]);
      const guarded = cases().filter((entry) => entry.guard);
      expect(guarded.length).toBeGreaterThan(0);
      // The probe's own constant is outside the pair: a case that refused the *approved* model
      // would be evidence of over-refusal, not of enforcement.
      expect(FREE_ONLY_APPROVED_MODELS).not.toContain(PROBE_UNAPPROVED_MODEL);
    });
  },
);
