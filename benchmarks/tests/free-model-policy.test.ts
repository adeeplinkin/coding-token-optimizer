import { describe, expect, it } from 'vitest';
import {
  FREE_ONLY_APPROVED_MODELS,
  FREE_ONLY_AUXILIARY_MODEL,
  FREE_ONLY_PRICE_FIELDS,
  FREE_ONLY_PRIMARY_MODEL,
  FREE_ONLY_PROVIDER,
  approvedModelRefusals,
  checkFreeOnlyPolicy,
  describePriceFacts,
  describeResolvedPolicy,
  digest,
  freeOnlyModelConfig,
  freeOnlyModelConfigDigest,
  freeOnlyModelConfigText,
  freeOnlyPolicyEvidence,
  modelGuardEvidence,
  freeOnlyPriceRefusals,
  freeOnlyRefusals,
  hasNoReportedUsage,
  intakeArmEvidence,
  endpointModelIds,
  isApprovedEndpointModel,
  isFreeOnlyModelConfig,
  isZeroPriceRow,
  modelRefToId,
  readResolvedModelPolicy,
  reportedCostUsd,
  resolvedPolicyRefusals,
  syntheticObservation,
} from '../src/level2/index.js';
import { createBudgetTracker } from '../src/level2/index.js';

/**
 * The free-only model policy.
 *
 * The decision these tests pin is permanent for the current benchmark plan: the paired
 * experiment runs on genuinely free models only. "Genuinely free" is not a naming convention and
 * not a catalogue listing — it is a price row the runtime itself reports as zero in **every**
 * applicable tier, checked before a session is spawned and re-derived from the artifact
 * afterwards. A model whose identifier contains `free` is not evidence of anything, so these tests
 * use one on purpose in the refusal cases.
 *
 * The other half of the policy is that the control and treatment arms cannot be configured
 * differently: {@link freeOnlyModelConfig} takes no arm parameter at all, and the tests below
 * prove the configuration the driver writes is the one the intake requires — including that a
 * substituted model, a re-enabled compaction or a second allowed provider is refused.
 */

const CANONICAL_TEXT_LENGTH = freeOnlyModelConfigText(freeOnlyModelConfig()).length;

describe('the free-only configuration', () => {
  it('pins the primary, the auxiliary model, one provider and no compaction', () => {
    const config = freeOnlyModelConfig();
    expect(config.model).toBe(FREE_ONLY_PRIMARY_MODEL);
    expect(config.small_model).toBe(FREE_ONLY_AUXILIARY_MODEL);
    expect(config.enabled_providers).toEqual([FREE_ONLY_PROVIDER]);
    expect(config.compaction).toEqual({ auto: false });
    expect(config.autoupdate).toBe(false);
    expect(config.share).toBe('disabled');
  });

  it('is one object for both arms: the policy cannot express a per-arm configuration', () => {
    // The function's signature is the guarantee: there is no arm parameter, no second argument
    // and no environment reading, so the two arms' repositories cannot differ.
    const first = freeOnlyModelConfig();
    const second = freeOnlyModelConfig();
    expect(freeOnlyModelConfigText(first)).toBe(freeOnlyModelConfigText(second));
    expect(freeOnlyModelConfigDigest(first)).toBe(freeOnlyModelConfigDigest(second));
    expect(freeOnlyModelConfigText(first).length).toBe(CANONICAL_TEXT_LENGTH);
    expect(digest(freeOnlyModelConfigText(first))).toBe(freeOnlyModelConfigDigest(first));
    expect(freeOnlyModelConfig.length).toBe(0);
  });

  it('accepts only the approved configuration, field by field', () => {
    expect(isFreeOnlyModelConfig(freeOnlyModelConfig())).toBe(true);
    expect(isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), model: 'opencode/gpt-5.4-mini' })).toBe(false);
    expect(
      isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), small_model: 'opencode/gpt-5.4-mini' }),
    ).toBe(false);
    expect(isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), compaction: { auto: true } })).toBe(false);
    expect(isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), compaction: {} })).toBe(false);
    expect(
      isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), enabled_providers: ['opencode', 'anthropic'] }),
    ).toBe(false);
    expect(isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), enabled_providers: [] })).toBe(false);
    expect(isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), autoupdate: true })).toBe(false);
    expect(isFreeOnlyModelConfig({ ...freeOnlyModelConfig(), share: 'auto' })).toBe(false);
    expect(isFreeOnlyModelConfig(undefined)).toBe(false);
    expect(isFreeOnlyModelConfig('opencode/mimo-v2.6-flash-free')).toBe(false);
  });
});

describe('the approval list', () => {
  it('approves the measured primary and the measured backup, and nothing else', () => {
    expect(FREE_ONLY_APPROVED_MODELS).toContain(FREE_ONLY_PRIMARY_MODEL);
    expect(FREE_ONLY_APPROVED_MODELS).toContain(FREE_ONLY_AUXILIARY_MODEL);
    expect(approvedModelRefusals(FREE_ONLY_PRIMARY_MODEL)).toEqual([]);
    expect(approvedModelRefusals(FREE_ONLY_AUXILIARY_MODEL)).toEqual([]);
  });

  it('refuses an unapproved model even when its identifier says free', () => {
    // The whole point: a name is not evidence. `some-other-free-model` is refused because it is
    // not in the approved set, not because of what its price row says.
    const refusals = approvedModelRefusals('opencode/some-other-free-model');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/not one of the approved free models/);
    expect(approvedModelRefusals('opencode/gpt-5.4-mini')).toHaveLength(1);
    expect(approvedModelRefusals(undefined)).toHaveLength(1);
    expect(approvedModelRefusals('   ')).toHaveLength(1);
  });
});

describe('the price row', () => {
  const facts = (over: Partial<Parameters<typeof freeOnlyPriceRefusals>[0]> = {}) => ({
    model: FREE_ONLY_PRIMARY_MODEL,
    runtime: 'service' as const,
    catalogueSize: 42,
    listed: true,
    priceRow: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...over,
  });

  it('accepts a row that is zero in every applicable tier', () => {
    expect(freeOnlyPriceRefusals(facts())).toEqual([]);
    expect(freeOnlyRefusals(facts())).toEqual([]);
    expect(isZeroPriceRow({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(true);
    expect(FREE_ONLY_PRICE_FIELDS).toContain('cacheWrite');
  });

  it('refuses a row with any non-zero tier, naming the tier and its value', () => {
    for (const field of FREE_ONLY_PRICE_FIELDS) {
      const row = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [field]: 0.5 };
      const refusals = freeOnlyPriceRefusals(facts({ priceRow: row }));
      expect(refusals, `${field} must be checked`).toHaveLength(1);
      expect(refusals[0]).toContain(field);
      expect(refusals[0]).toMatch(/not free/);
    }
    expect(isZeroPriceRow({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0.01 })).toBe(false);
  });

  it('refuses a missing or partial price row rather than reading absence as zero', () => {
    expect(freeOnlyPriceRefusals(facts({ priceRow: undefined }))).toHaveLength(1);
    expect(freeOnlyPriceRefusals(facts({ priceRow: undefined }))[0]).toMatch(/no price row/);
    const partial = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: undefined,
    };
    const refusals = freeOnlyPriceRefusals(facts({ priceRow: partial as never }));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/cacheWrite=unreported/);
  });

  it('refuses an unlisted model and a runtime with no catalogue at all', () => {
    const unlisted = freeOnlyPriceRefusals(facts({ listed: false }));
    expect(unlisted).toHaveLength(1);
    expect(unlisted[0]).toMatch(/does not offer/);
    const empty = freeOnlyPriceRefusals(facts({ catalogueSize: 0, listed: false }));
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatch(/no model catalogue at all/);
  });

  it('describes the facts without letting an unreported tier read as a zero', () => {
    expect(describePriceFacts(facts())).toMatch(/FREE$/);
    expect(describePriceFacts(facts({ priceRow: undefined }))).toMatch(/NOT VERIFIED FREE/);
    expect(
      describePriceFacts(facts({ priceRow: { input: 0.75, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    ).toMatch(/input 0\.75/);
    expect(
      describePriceFacts(
        facts({ priceRow: { input: 0, output: 0, cacheRead: 0, cacheWrite: undefined } as never }),
      ),
    ).toMatch(/cacheWrite unreported/);
  });
});

describe('the runtime resolved configuration', () => {
  const resolved = {
    source: 'api config.get --standalone (this repository\u2019s own document)',
    found: true,
    model: FREE_ONLY_PRIMARY_MODEL,
    titleModel: FREE_ONLY_AUXILIARY_MODEL,
    compactionAuto: false,
    providersAllowed: [FREE_ONLY_PROVIDER],
    providersDeniedAll: true,
    update: 'disable',
    share: 'disabled',
    error: undefined,
  };

  it('accepts the configuration the runtime resolved from the policy', () => {
    expect(resolvedPolicyRefusals(resolved)).toEqual([]);
  });

  it('refuses every setting whose omission would widen the envelope', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['a substituted primary', { ...resolved, model: 'opencode/gpt-5.4-mini' }],
      ['a paid auxiliary model', { ...resolved, titleModel: 'opencode/gpt-5.4-mini' }],
      ['a dropped auxiliary key', { ...resolved, titleModel: undefined }],
      ['a dropped compaction key', { ...resolved, compactionAuto: undefined }],
      ['compaction left on', { ...resolved, compactionAuto: true }],
      ['a second allowed provider', { ...resolved, providersAllowed: ['opencode', 'anthropic'] }],
      ['a missing deny-others rule', { ...resolved, providersDeniedAll: false }],
      ['an unreported configuration', { ...resolved, found: false, error: 'no document' }],
      ['automatic updates', { ...resolved, update: 'auto' }],
    ];
    for (const [label, value] of cases) {
      const refusals = resolvedPolicyRefusals(value as never);
      expect(refusals, label).toHaveLength(1);
    }
  });

  it('reads a recorded block back, and treats an unreadable one as absent', () => {
    expect(readResolvedModelPolicy(resolved)).toMatchObject({
      found: true,
      model: FREE_ONLY_PRIMARY_MODEL,
      compactionAuto: false,
    });
    expect(readResolvedModelPolicy(undefined)).toBeUndefined();
    expect(readResolvedModelPolicy('a string')).toBeUndefined();
    expect(describeResolvedPolicy(resolved)).toMatch(/primary opencode\/mimo-v2\.6-flash-free/);
    expect(describeResolvedPolicy({ ...resolved, found: false })).toMatch(/not reported/);
  });

  it('normalizes a model reference the way the runtime reports it', () => {
    expect(modelRefToId({ providerID: 'opencode', model: 'mimo-v2.6-flash-free' })).toBe(
      FREE_ONLY_PRIMARY_MODEL,
    );
    expect(modelRefToId({ providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' })).toBe(
      FREE_ONLY_PRIMARY_MODEL,
    );
    expect(modelRefToId({ providerID: 'opencode', id: 'mimo-v2.6-flash-free' })).toBe(
      FREE_ONLY_PRIMARY_MODEL,
    );
    expect(modelRefToId('opencode/mimo-v2.6-flash-free')).toBe(FREE_ONLY_PRIMARY_MODEL);
    expect(modelRefToId({ providerID: 'opencode' })).toBeUndefined();
    expect(modelRefToId(undefined)).toBeUndefined();
  });

  /**
   * The spelling a **provider endpoint** sees.
   *
   * Measured on the pinned runtime: the outbound body names the model without its provider
   * (`mimo-v2.6-flash-free`) while the configuration, the hook payload and the runtime's resolved
   * policy all name `opencode/mimo-v2.6-flash-free`. A wire check that demanded the qualified
   * spelling therefore failed a *correct* rehearsal run, and one that accepted any suffix would
   * accept a substitution. These tests pin the closed set that resolves both failures at once.
   */
  it('accepts exactly the approved ids and their endpoint spellings, and nothing else', () => {
    expect(endpointModelIds()).toEqual([
      FREE_ONLY_PRIMARY_MODEL,
      'mimo-v2.6-flash-free',
      FREE_ONLY_AUXILIARY_MODEL,
      'muse-spark-1.3-contributor-free',
    ]);
    // Both spellings of an approved model are accepted…
    expect(isApprovedEndpointModel(FREE_ONLY_PRIMARY_MODEL)).toBe(true);
    expect(isApprovedEndpointModel('mimo-v2.6-flash-free')).toBe(true);
    // …and the set is closed. A different model, a near-miss name and the `free`-suffixed id the
    // refusal cases use are all outside it.
    expect(isApprovedEndpointModel('opencode/gpt-5.4-mini')).toBe(false);
    expect(isApprovedEndpointModel('gpt-5.4-mini-free')).toBe(false);
    expect(isApprovedEndpointModel('mimo-v2.6-flash-free-turbo')).toBe(false);
    expect(isApprovedEndpointModel('anthropic/mimo-v2.6-flash-free')).toBe(false);
    // An absent identifier is refused rather than treated as "no model named, so nothing to check".
    expect(isApprovedEndpointModel(undefined)).toBe(false);
    expect(isApprovedEndpointModel('')).toBe(false);
  });

  it('can be narrowed to the primary, so an auxiliary model cannot stand in for it', () => {
    const primaryOnly = [FREE_ONLY_PRIMARY_MODEL];
    expect(endpointModelIds(primaryOnly)).toEqual([FREE_ONLY_PRIMARY_MODEL, 'mimo-v2.6-flash-free']);
    expect(isApprovedEndpointModel('mimo-v2.6-flash-free', primaryOnly)).toBe(true);
    // The approved *auxiliary* model is approved for auxiliary calls, not for the agent loop.
    expect(isApprovedEndpointModel('muse-spark-1.3-contributor-free', primaryOnly)).toBe(false);
    expect(isApprovedEndpointModel(FREE_ONLY_AUXILIARY_MODEL, primaryOnly)).toBe(false);
  });
});

describe('the intake gate', () => {
  const ARTIFACT_TASK = 'repeated-reads-catalogue';
  const NONCE = 'free-only-nonce';
  const artifact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 1,
    taskId: ARTIFACT_TASK,
    arm: 'treatment',
    runId: `${ARTIFACT_TASK}:p0:treatment`,
    runNonce: NONCE,
    complete: true,
    pairIndex: 0,
    attempt: 1,
    startedAt: '2026-10-12T00:00:00.000Z',
    durationMs: 1_000,
    harness: 'opencode-coding-task',
    optimizerRevision: '0.0.0',
    repositoryRevision: digest('repo'),
    promptHash: digest('prompt'),
    model: FREE_ONLY_PRIMARY_MODEL,
    mode: 'live',
    exitCode: 0,
    timedOut: false,
    sessionCleanExit: true,
    modelUnavailable: false,
    grading: {
      passed: true,
      command: 'node --test',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      outputDigest: digest('grading'),
      outputExcerpt: '',
      checks: [],
    },
    usage: { inputTokens: 1_000, outputTokens: 200, costUsd: 0 },
    behaviour: { toolCalls: 4, repeatedFileReads: 1 },
    modelPolicy: freeOnlyPolicyEvidence(),
    // The layer that bounds the *requests* rather than the configuration. Absent here, and every
    // refusal below would be reported as the guard refusing a run for the wrong reason.
    modelGuard: modelGuardEvidence(),
    ...overrides,
  });
  const intakeOf = (value: Record<string, unknown>, mode: 'live' | 'rehearse' = 'live') =>
    intakeArmEvidence({
      driverExitCode: 0,
      artifactPreexisting: false,
      artifactText: JSON.stringify(value),
      expectedRunNonce: NONCE,
      expectedMode: mode,
      expected: { taskId: ARTIFACT_TASK, arm: 'treatment', pairIndex: 0 },
    });

  it('accepts a verified free-only run (the positive control)', () => {
    const outcome = intakeOf(artifact());
    expect(outcome.problems).toEqual([]);
    expect(outcome.accepted).toBe(true);
    expect(outcome.observation?.modelPolicy?.primaryModel).toBe(FREE_ONLY_PRIMARY_MODEL);
    expect(outcome.observation?.modelPolicy?.priceVerifiedFree).toBe(true);
    expect(outcome.observation?.modelPolicy?.requests.auxiliaryRequests).toBe(0);
  });

  it('refuses a run whose recorded configuration is not the approved one', () => {
    for (const config of [
      { ...freeOnlyModelConfig(), model: 'opencode/gpt-5.4-mini' },
      { ...freeOnlyModelConfig(), small_model: 'opencode/gpt-5.4-mini' },
      { ...freeOnlyModelConfig(), compaction: { auto: true } },
      { ...freeOnlyModelConfig(), enabled_providers: ['opencode', 'anthropic'] },
      { model: FREE_ONLY_PRIMARY_MODEL },
    ]) {
      const outcome = intakeOf(artifact({ modelPolicy: { ...freeOnlyPolicyEvidence(), config } }));
      expect(outcome.accepted).toBe(false);
      expect(outcome.invalidReason).toBe('model-policy-unverified');
    }
  });

  it('refuses a run whose price was not verified free', () => {
    const paid = intakeOf(
      artifact({
        modelPolicy: {
          ...freeOnlyPolicyEvidence(),
          priceRow: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
        },
      }),
    );
    expect(paid.accepted).toBe(false);
    expect(paid.invalidReason).toBe('model-policy-unverified');

    // The same substitution with the driver's own flag claiming otherwise: the verdict is
    // recomputed from the row, so a claim in a field cannot override the numbers.
    const claimedFree = intakeOf(
      artifact({
        modelPolicy: {
          ...freeOnlyPolicyEvidence(),
          priceVerifiedFree: true,
          priceRow: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.01 },
        },
      }),
    );
    expect(claimedFree.accepted).toBe(false);

    // A flag with no row behind it is refused: the row is what can be audited, and a claimed-free
    // run with nothing to check is exactly the artifact a mistake would leave.
    const flagOnly = intakeOf(
      artifact({ modelPolicy: { ...freeOnlyPolicyEvidence(), priceRow: null } }),
    );
    expect(flagOnly.accepted).toBe(false);
    expect(flagOnly.invalidReason).toBe('model-policy-unverified');
    const missingRow = intakeOf(
      artifact({
        modelPolicy: { ...freeOnlyPolicyEvidence(), priceVerifiedFree: false, priceRow: null },
      }),
    );
    expect(missingRow.accepted).toBe(false);
  });

  it('refuses a run that did not suppress title generation, or that composed an auxiliary request', () => {
    const unsuppressed = intakeOf(
      artifact({ modelPolicy: { ...freeOnlyPolicyEvidence(), titleGenerationSuppressed: false } }),
    );
    expect(unsuppressed.accepted).toBe(false);
    expect(unsuppressed.invalidReason).toBe('model-policy-unverified');

    const auxiliary = intakeOf(
      artifact({
        modelPolicy: {
          ...freeOnlyPolicyEvidence(),
          requests: {
            source: 'model-request-hooks',
            kindsRegistered: ['primary', 'compaction', 'title', 'generate'],
            kinds: { primary: 2, title: 1 },
            modelsNamed: { [FREE_ONLY_PRIMARY_MODEL]: 3 },
            registrationFailures: [],
            auxiliaryRequests: 1,
          },
        },
      }),
    );
    expect(auxiliary.accepted).toBe(false);
    expect(auxiliary.invalidReason).toBe('model-policy-unverified');

    const compaction = intakeOf(
      artifact({
        modelPolicy: {
          ...freeOnlyPolicyEvidence(),
          requests: {
            source: 'model-request-hooks',
            kindsRegistered: ['primary', 'compaction', 'title', 'generate'],
            kinds: { primary: 1, compaction: 1 },
            modelsNamed: { [FREE_ONLY_PRIMARY_MODEL]: 2 },
            registrationFailures: [],
            auxiliaryRequests: 1,
          },
        },
      }),
    );
    expect(compaction.accepted).toBe(false);
  });

  it('refuses a run that records a pre-spawn policy refusal, or no policy at all', () => {
    const refused = intakeOf(
      artifact({ modelPolicy: { ...freeOnlyPolicyEvidence(), refusals: ['the model is not free'] } }),
    );
    expect(refused.accepted).toBe(false);
    const absent = intakeOf(artifact({ modelPolicy: undefined }));
    expect(absent.accepted).toBe(false);
    expect(absent.invalidReason).toBe('model-policy-unverified');
    expect(
      checkFreeOnlyPolicy({ mode: 'live' }).invalidReason,
    ).toBe('model-policy-unverified');
  });

  it('accepts a rehearsal that records why no price row was checked, but never a live run', () => {
    const rehearsalPolicy = {
      ...freeOnlyPolicyEvidence(),
      catalogueSource: 'not-checked',
      priceVerifiedFree: false,
      priceRow: null,
      priceCheckSkippedReason: 'a rehearsal spends nothing and holds no account catalogue',
    };
    expect(intakeOf(artifact({ mode: 'rehearse', modelPolicy: rehearsalPolicy }), 'rehearse').accepted).toBe(
      true,
    );
    // The same artifact as a live run: a live run has no excuse for an unverified price.
    expect(intakeOf(artifact({ modelPolicy: rehearsalPolicy })).accepted).toBe(false);
  });
});

describe('token reporting at zero cost', () => {
  it('keeps a reported zero cost as a value, and keeps the token fields with it', () => {
    const free = {
      ...syntheticObservation({ arm: 'control', taskPassed: true, inputTokens: 1_482, outputTokens: 96 }),
      usage: {
        inputTokens: 1_482,
        outputTokens: 96,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
      },
    };
    expect(reportedCostUsd(free)).toBe(0);
    expect(hasNoReportedUsage(free)).toBe(false);
    // A capped run is not stopped by a reported zero: this is the difference between a free
    // session and an unmeasured one, and getting it wrong would stop every free-only run.
    const decision = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: undefined,
      maxCostUsdPerRun: 0.5,
      maxCostUsd: 1,
    }).observe(free);
    expect(decision.allowed).toBe(true);

    // The control: an unreported cost under the same caps does stop the run.
    const unmeasured = {
      ...free,
      usage: { ...free.usage, costUsd: undefined },
    };
    const stopped = createBudgetTracker({
      maxUnitsPerRun: undefined,
      maxTotalUnits: undefined,
      maxCostUsdPerRun: 0.5,
      maxCostUsd: 1,
    }).observe(unmeasured);
    expect(stopped.allowed).toBe(false);
    expect(stopped.reason).toBe('cost-unreported');
  });
});
