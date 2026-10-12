import { describe, expect, it } from 'vitest';

/**
 * Let the registration promise chain settle.
 *
 * The guard registers the hook inside `setup` and records the outcome when that promise settles, as
 * the containment guard does. Against the real runtime the two are ordered — measured in the probe,
 * `hook-registered` is written before the first request is dispatched, because the request that
 * follows a plugin load takes many turns of the loop to assemble — but a unit test that asserts on the
 * evidence file has to give the chain a turn rather than assume it.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
import {
  MODEL_GUARD_PLUGIN_ID,
  MODEL_GUARD_REQUEST_KINDS,
  createModelGuardPluginV2,
  evaluateModelRequest,
  normalizeModelId,
  summarizeModelGuardEvidence,
} from '../src/index.js';
import type {
  ModelGuardEvidenceLine,
  ModelGuardPolicy,
  OpenCodeV2PluginContext,
  OpenCodeV2SessionModelRequest,
} from '../src/index.js';

/**
 * The pre-transmission model guard, tested at both seams.
 *
 * The decision is pure, so it is tested directly: no runtime, no provider, no filesystem. The plugin
 * is then driven through a small but faithful V2 session context — `setup(ctx)` with a real
 * `session.hook("model.request", …)` registration, and the payload the pinned runtime hands over —
 * so a refused request is a *thrown* request, exactly as the runtime's dispatch site receives it, and
 * the refusal is recorded before the throw rather than after it.
 *
 * Why these tests matter more than most: the guard is the only layer in the harness that can stop a
 * request, and the failure it prevents is invisible in every other way. A session on a paid model
 * produces ordinary tokens, an ordinary artifact and an ordinary comparison. The enforcement proof
 * against the installed runtime lives in the benchmark probe; what is pinned here is the policy it
 * enforces and the shape of the refusal itself.
 */

const PRIMARY = 'opencode/mimo-v2.6-flash-free';
const AUXILIARY = 'opencode/muse-spark-1.3-contributor-free';
const PAID = 'opencode/gpt-5.4-mini';

function policy(overrides: Partial<ModelGuardPolicy> = {}): ModelGuardPolicy {
  return {
    primary: PRIMARY,
    approved: [PRIMARY, AUXILIARY],
    allowedKinds: [...MODEL_GUARD_REQUEST_KINDS],
    policyDigest: 'test-digest',
    ...overrides,
  };
}

/** One captured registration, so a test can invoke the hook the runtime would invoke. */
interface CapturedHook {
  readonly name: string;
  readonly callback: (input: OpenCodeV2SessionModelRequest) => Promise<void> | void;
}

/**
 * A minimal session context: exactly the one capability the guard registers on.
 *
 * `omitSession` exists because the interesting failure is a host that offers no session domain at
 * all — the guard must record that as a missing capability rather than as an armed one.
 */
function context(options: { readonly omitSession?: boolean } = {}): {
  readonly ctx: OpenCodeV2PluginContext;
  readonly hooks: readonly CapturedHook[];
} {
  const hooks: CapturedHook[] = [];
  const ctx = {
    ...(options.omitSession === true
      ? {}
      : {
          session: {
            hook: async (name: never, callback: never) => {
              hooks.push({ name: String(name), callback });
              return { dispose: async () => undefined };
            },
          },
        }),
    options: {},
  } as unknown as OpenCodeV2PluginContext;
  return { ctx, hooks };
}

/** Run the plugin's setup and return what it registered. */
async function setup(
  options: Parameters<typeof createModelGuardPluginV2>[0] = {},
): Promise<{ readonly hooks: readonly CapturedHook[]; readonly lines: ModelGuardEvidenceLine[] }> {
  const lines: ModelGuardEvidenceLine[] = [];
  const { ctx, hooks } = context();
  const plugin = createModelGuardPluginV2({ onEvidence: (line) => lines.push(line), ...options });
  await plugin.setup(ctx);
  return { hooks, lines };
}

describe('the model-guard decision', () => {
  it('allows the approved primary for a primary request', () => {
    const decision = evaluateModelRequest({ kind: 'primary', model: PRIMARY }, policy());
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.model).toBe(PRIMARY);
  });

  it('allows the approved auxiliary for an auxiliary request', () => {
    // The auxiliary is approved *as* an auxiliary: the guard bounds models, not kinds. Whether the
    // run may compose an auxiliary request at all is the benchmark's decision, taken from the
    // request-kind counts, and conflating the two here would hide which rule refused a run.
    for (const kind of ['title', 'compaction', 'generate']) {
      expect(evaluateModelRequest({ kind, model: AUXILIARY }, policy()).allow).toBe(true);
    }
  });

  it('refuses every model that is not on the approval list, whatever the request kind', () => {
    for (const kind of MODEL_GUARD_REQUEST_KINDS) {
      const decision = evaluateModelRequest({ kind, model: PAID }, policy());
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('model-not-approved');
      expect(decision.model).toBe(PAID);
    }
  });

  it('refuses a same-provider free model that the policy does not approve', () => {
    // The case the provider restriction cannot see: `opencode` is the allowed provider, and this is
    // one of its zero-priced models. Being free is not the question — being *approved* is.
    const decision = evaluateModelRequest({ kind: 'primary', model: 'opencode/exo-free' }, policy());
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('model-not-approved');
  });

  it('refuses another provider model that is zero-priced under its own provider', () => {
    const decision = evaluateModelRequest({ kind: 'primary', model: 'other-provider/free' }, policy());
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('model-not-approved');
  });

  it('refuses a primary request that names the approved auxiliary', () => {
    // Substitution inside the approved set: the agent loop running the auxiliary while the
    // configuration pins the primary. The model is approved; the *role* is not.
    const decision = evaluateModelRequest({ kind: 'primary', model: AUXILIARY }, policy());
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('primary-model-substituted');
  });

  it('refuses a request whose kind is missing or outside the runtime vocabulary', () => {
    expect(evaluateModelRequest({ model: PRIMARY }, policy()).reason).toBe('request-kind-absent');
    const unknown = evaluateModelRequest({ kind: 'hypothetical', model: PRIMARY }, policy());
    expect(unknown.allow).toBe(false);
    expect(unknown.reason).toBe('request-kind-unsupported');
    // Fail closed rather than guessing "probably primary": an unrecognized kind is exactly the case
    // where a wrong assumption would hide a request the policy does not allow.
    expect(evaluateModelRequest({ kind: '', model: PRIMARY }, policy()).allow).toBe(false);
  });

  it('refuses a request whose model cannot be read at all', () => {
    for (const model of [undefined, null, '', '   ', 42, [], {}, { providerID: 'opencode' }, { model: 'x' }]) {
      const decision = evaluateModelRequest({ kind: 'primary', model }, policy());
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('model-unreadable');
    }
  });

  it('refuses everything when it was constructed without a usable envelope', () => {
    for (const broken of [
      { primary: '', approved: [PRIMARY], allowedKinds: [...MODEL_GUARD_REQUEST_KINDS] },
      { primary: PRIMARY, approved: [], allowedKinds: [...MODEL_GUARD_REQUEST_KINDS] },
      { primary: PRIMARY, approved: [PRIMARY], allowedKinds: [] },
    ]) {
      const decision = evaluateModelRequest(
        { kind: 'primary', model: PRIMARY },
        policy(broken as Partial<ModelGuardPolicy>),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('not-configured');
    }
  });

  it('treats a bare model id as matching only when it is an approved id', () => {
    // The runtime hands the hook a structured reference, but a string `provider/id` is a shape the
    // guard also accepts; a bare id with no provider is not, because it cannot be attributed.
    expect(evaluateModelRequest({ kind: 'primary', model: 'mimo-v2.6-flash-free' }, policy()).allow).toBe(false);
    expect(evaluateModelRequest({ kind: 'primary', model: PRIMARY }, policy()).allow).toBe(true);
  });
});

describe('the model-guard model reference normalizer', () => {
  it('reads every shape the runtime and the payload variants use', () => {
    expect(normalizeModelId('opencode/mimo-v2.6-flash-free')).toBe(PRIMARY);
    expect(normalizeModelId({ providerID: 'opencode', model: 'mimo-v2.6-flash-free' })).toBe(PRIMARY);
    expect(normalizeModelId({ providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' })).toBe(PRIMARY);
    expect(normalizeModelId({ provider: 'opencode', model: 'mimo-v2.6-flash-free' })).toBe(PRIMARY);
    expect(normalizeModelId({ providerID: 'opencode', model: { id: 'mimo-v2.6-flash-free' } })).toBe(PRIMARY);
  });

  it('returns undefined rather than a guess for a value it cannot attribute', () => {
    for (const value of [
      undefined,
      null,
      42,
      [],
      {},
      'mimo-v2.6-flash-free',
      { model: 'mimo-v2.6-flash-free' },
      { providerID: '', model: 'x' },
      { providerID: 'opencode', model: '' },
    ]) {
      expect(normalizeModelId(value)).toBeUndefined();
    }
  });
});

describe('the model-guard plugin', () => {
  it('registers the one hook the runtime dispatches every model request to, and no other', async () => {
    const { hooks, lines } = await setup({ policy: policy() });
    await settle();
    expect(hooks.map((hook) => hook.name)).toEqual(['model.request']);
    expect(lines.map((line) => line.kind)).toEqual(['loaded', 'hook-registered']);
  });

  it('records an allowed request without throwing, so legitimate work proceeds', async () => {
    const { hooks, lines } = await setup({ policy: policy() });
    await hooks[0]?.callback({ kind: 'primary', model: PRIMARY, sessionID: 'ses_1' });
    expect(lines.map((line) => line.kind)).toEqual(['loaded', 'hook-registered', 'allowed']);
    const allowed = lines[2];
    expect(allowed?.requestKind).toBe('primary');
    expect(allowed?.model).toBe(PRIMARY);
    expect(allowed?.policyDigest).toBe('test-digest');
  });

  it('throws on an unapproved model, and records the refusal before it throws', async () => {
    const { hooks, lines } = await setup({ policy: policy() });
    // Synchronous, exactly as the runtime's dispatch site receives it: the runtime awaits this
    // callback inside its request assembly, so a throw here propagates out of the dispatch and the
    // request is never built. `expect(...).rejects` would be the wrong assertion — there is no
    // promise to reject.
    expect(() => hooks[0]?.callback({ kind: 'primary', model: PAID })).toThrow(
      /dr-token model guard/,
    );
    // The evidence must survive the exception: the throw is what ends the request, so a refusal
    // recorded after it would never be written.
    const refusal = lines.find((line) => line.kind === 'refused');
    expect(refusal?.reason).toBe('model-not-approved');
    expect(refusal?.model).toBe(PAID);
    expect(refusal?.requestKind).toBe('primary');
  });

  it('says a throw is what stops the request, in the error the session surfaces', async () => {
    const { hooks } = await setup({ policy: policy() });
    expect(() => hooks[0]?.callback({ kind: 'primary', model: PAID })).toThrow(
      /refused before it was sent/,
    );
  });

  it('records a missing session capability rather than assuming it is armed', async () => {
    // Fail closed in the only way a plugin can: say so, and let the harness refuse the run. A host
    // that exposes no session domain cannot be shown to have accepted the callback.
    const lines: ModelGuardEvidenceLine[] = [];
    const { ctx, hooks } = context({ omitSession: true });
    const plugin = createModelGuardPluginV2({ policy: policy(), onEvidence: (line) => lines.push(line) });
    await plugin.setup(ctx);
    expect(hooks).toHaveLength(0);
    expect(lines.map((line) => line.kind)).toEqual(['loaded', 'hook-capability-missing']);
    expect(summarizeModelGuardEvidence(lines).capabilityMissing).toBe(true);
  });

  it('records a failed registration rather than a successful one', async () => {
    const lines: ModelGuardEvidenceLine[] = [];
    const plugin = createModelGuardPluginV2({ policy: policy(), onEvidence: (line) => lines.push(line) });
    await plugin.setup({
      session: {
        hook: async () => {
          throw new Error('the runtime refused this hook');
        },
      },
      options: {},
    } as unknown as OpenCodeV2PluginContext);
    await settle();
    expect(lines.map((line) => line.kind)).toEqual(['loaded', 'hook-registration-failed']);
    const summary = summarizeModelGuardEvidence(lines);
    expect(summary.hookRegistered).toBe(false);
    expect(summary.capabilityMissing).toBe(true);
  });

  it('records a misconfiguration and refuses every request when given no envelope', async () => {
    const { hooks, lines } = await setup();
    expect(lines.map((line) => line.kind)).toEqual(['loaded', 'misconfigured', 'hook-registered']);
    expect(() => hooks[0]?.callback({ kind: 'primary', model: PRIMARY })).toThrow(
      /without an approved model envelope/,
    );
    expect(summarizeModelGuardEvidence(lines).misconfigured).toBe(true);
  });

  it('registers no provider filter, so a request from any provider is still checked', async () => {
    // A registration filtered by provider would let a request from an unnamed provider skip the
    // guard entirely — the opposite of fail-closed. The guard passes no options and no filter.
    const { hooks } = await setup({ policy: policy() });
    expect(hooks).toHaveLength(1);
    expect(() => hooks[0]?.callback({ kind: 'primary', model: 'nowhere/paid' })).toThrow(
      /dr-token model guard/,
    );
  });

  it('emits only content-free evidence: counts, kinds, identifiers and reasons', async () => {
    const { hooks, lines } = await setup({ policy: policy() });
    await hooks[0]?.callback({
      kind: 'primary',
      baseURL: 'https://provider.example/v1',
      headers: { authorization: 'Bearer secret-value' },
      model: PRIMARY,
      sessionID: 'ses_secret',
    });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('provider.example');
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('ses_secret');
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        expect.arrayContaining(['at', 'kind']),
      );
      expect(Object.keys(line).length).toBeLessThanOrEqual(6);
    }
  });

  it('never writes a file of its own, even when the sink throws', async () => {
    const plugin = createModelGuardPluginV2({
      policy: policy(),
      onEvidence: () => {
        throw new Error('the caller sink failed');
      },
    });
    const { ctx, hooks } = context();
    // A sink failure must never change what the session does: setup completes and the hook still
    // refuses, because evidence is best effort and enforcement is not.
    await plugin.setup(ctx);
    expect(() => hooks[0]?.callback({ kind: 'primary', model: PAID })).toThrow(
      /dr-token model guard/,
    );
    await hooks[0]?.callback({ kind: 'primary', model: PRIMARY });
  });

  it('is its own plugin, with an id of its own', () => {
    expect(createModelGuardPluginV2({ policy: policy() }).id).toBe(MODEL_GUARD_PLUGIN_ID);
    expect(MODEL_GUARD_PLUGIN_ID).toBe('dr-token-model-guard');
  });
});

describe('the model-guard evidence summary', () => {
  it('separates loading from registration, and counts every decision', () => {
    const summary = summarizeModelGuardEvidence([
      { kind: 'loaded', at: 't', policyDigest: 'd' },
      { kind: 'hook-registered', at: 't', policyDigest: 'd' },
      { kind: 'allowed', at: 't', requestKind: 'primary', model: PRIMARY, policyDigest: 'd' },
      { kind: 'allowed', at: 't', requestKind: 'primary', model: PRIMARY, policyDigest: 'd' },
      { kind: 'refused', at: 't', requestKind: 'title', model: PAID, reason: 'model-not-approved', policyDigest: 'd' },
    ]);
    expect(summary.loaded).toBe(true);
    expect(summary.hookRegistered).toBe(true);
    expect(summary.capabilityMissing).toBe(false);
    expect(summary.allowed).toBe(2);
    expect(summary.refused).toBe(1);
    expect(summary.invocations).toBe(3);
    expect(summary.refusals).toEqual([
      { requestKind: 'title', model: PAID, reason: 'model-not-approved' },
    ]);
    expect(summary.policyDigest).toBe('d');
  });

  it('reports a plugin that loaded without registering as a missing capability, not as armed', () => {
    const summary = summarizeModelGuardEvidence([{ kind: 'loaded', at: 't' }]);
    expect(summary.loaded).toBe(true);
    expect(summary.hookRegistered).toBe(false);
    expect(summary.misconfigured).toBe(false);
  });

  it('ignores a refusal line with no reason rather than counting it as a decision', () => {
    const summary = summarizeModelGuardEvidence([
      { kind: 'loaded', at: 't' },
      { kind: 'refused', at: 't' },
    ]);
    expect(summary.refused).toBe(0);
    expect(summary.invocations).toBe(0);
  });

  it('is empty and unarmed for an empty record, which is what a missing file looks like', () => {
    const summary = summarizeModelGuardEvidence([]);
    expect(summary.loaded).toBe(false);
    expect(summary.hookRegistered).toBe(false);
    expect(summary.capabilityMissing).toBe(false);
    expect(summary.invocations).toBe(0);
    expect(summary.policyDigest).toBe('');
  });
});
