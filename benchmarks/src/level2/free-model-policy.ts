/**
 * The **free-only model policy** the Level 2 benchmark is pinned to.
 *
 * The decision this module encodes is permanent for the current plan: the paired coding
 * experiment runs on **genuinely free** models only, and a model is free only when every
 * usage category the runtime prices — input, output, cache read and cache write — is
 * **explicitly zero** in the runtime's own price row. A `-free` suffix in an identifier is
 * not evidence of anything, which is why the checks below are about the reported price row
 * and about the runtime's own resolved configuration rather than about a name.
 *
 * Three separate questions are answered here, and keeping them separate is the point:
 *
 * 1. **Which configuration must a session run under** — {@link freeOnlyModelConfig}. One
 *    object, produced by one function with no arm parameter, so the control and the
 *    treatment arm cannot be configured differently by accident: there is no way to ask
 *    this module for a per-arm configuration.
 * 2. **May this model be used at all** — {@link freeOnlyPriceRefusals}. It refuses a
 *    model the runtime does not list, a model whose price row is absent, and a model whose
 *    row is anything other than zero in every tier. It is evaluated *before* a live session
 *    is spawned, so a paid or unverifiable model costs nothing to discover.
 * 3. **Did the runtime actually apply it** — {@link resolvedPolicyRefusals}. The runtime
 *    normalizes and validates configuration, and it silently *omits* a key it does not
 *    recognize rather than failing, so a written file is not evidence that a setting took
 *    effect. The driver therefore asks the pinned runtime what it resolved and this function
 *    checks the answer.
 *
 * Everything here is a pure function over plain values, so the whole policy is testable
 * offline, without a runtime, a credential or a model call.
 */
import { digest } from './repos.js';

/** The only provider a free-only session may use. */
export const FREE_ONLY_PROVIDER = 'opencode';

/**
 * The measured free primary model.
 *
 * `opencode/mimo-v2.6-flash-free`: the runtime's own price row is zero in all four tiers,
 * it advertises tool support, and this account has completed 1,452 inference steps on it at
 * a reported cost of $0.00 — accessibility is observed, not inferred from the catalogue.
 */
export const FREE_ONLY_PRIMARY_MODEL = 'opencode/mimo-v2.6-flash-free';

/**
 * The measured free backup, and the model configured for **auxiliary** calls.
 *
 * `opencode/muse-spark-1.3-contributor-free` has 381 completed steps on this account at a
 * reported cost of $0.00. It is used for the runtime's auxiliary requests (the title agent)
 * rather than the primary, so an unavoidable auxiliary call cannot compete with the measured
 * model's free quota.
 */
export const FREE_ONLY_AUXILIARY_MODEL = 'opencode/muse-spark-1.3-contributor-free';

/**
 * Every model id a free-only session may name.
 *
 * Nothing outside this list is acceptable, whatever its price row says: widening the
 * experiment's model set is a deliberate policy change, not a runtime detail.
 */
export const FREE_ONLY_APPROVED_MODELS: readonly string[] = [
  FREE_ONLY_PRIMARY_MODEL,
  FREE_ONLY_AUXILIARY_MODEL,
];

/**
 * The usage categories that must each be explicitly zero.
 *
 * Cache write is deliberately included. It is the category public documentation is weakest
 * on, it is part of the runtime's own price row, and a model that is free for reads while
 * charging for writes is not a free model.
 */
export const FREE_ONLY_PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/** One of the priced usage categories. */
export type FreeOnlyPriceField = (typeof FREE_ONLY_PRICE_FIELDS)[number];

/**
 * The hook name the pinned runtime dispatches **every** model request to.
 *
 * One name, one payload per request, with the request's own kind inside it. Stage 1T read the
 * runtime's single dispatch site out of the shipped binary and confirmed it live: `context`
 * fires for primary requests, `compaction`/`generate`/`title` for their own kinds, and
 * `model.request` for all of them with `kind` in its payload
 * (`docs/SAFE_MODE_1T_APPLY_VALIDATION.md` §3.3b–c).
 *
 * It is a policy constant rather than a driver detail because a run's claim that "no auxiliary
 * request was composed" is only as good as the channel it was counted on: the driver registers
 * this hook, the benchmark side checks the counts came from it, and both read the same *name*
 * from this one place. A synthetic per-kind name (`model.request:title`) is accepted by the
 * runtime without error and never called — measured — so a count taken that way is a zero that
 * means nothing, which is the exact failure this constant prevents.
 */
export const MODEL_REQUEST_HOOK = 'model.request';

/** The runtime's own kind for a request on the primary agent loop. */
export const PRIMARY_REQUEST_KIND = 'primary';

/**
 * Every request kind that is not the primary loop.
 *
 * The title agent's request is auxiliary work the measured model would otherwise pay for, and a
 * compaction request replaces the very conversation the pass is measured on. A free-only run
 * must compose none of them, which is why they are named here rather than inferred from
 * "everything else".
 */
export const AUXILIARY_REQUEST_KINDS: readonly string[] = ['compaction', 'title', 'generate'];

/** Every request kind the pinned runtime reports, primary first. */
export const REQUEST_KINDS: readonly string[] = [PRIMARY_REQUEST_KIND, ...AUXILIARY_REQUEST_KINDS];

/**
 * The kinds that must not appear in a free-only run's request counts.
 *
 * Anything not the primary kind is auxiliary, including a kind this module has never heard of:
 * an unrecognized kind is exactly the case where guessing "probably primary" would hide a
 * request the policy does not allow.
 */
export function auxiliaryRequestKinds(kinds: Readonly<Record<string, number>>): readonly string[] {
  return Object.keys(kinds).filter((kind) => kind !== PRIMARY_REQUEST_KIND);
}

/** A price row in USD per million tokens, each tier independently optional. */
export interface ModelPriceRow {
  readonly input: number | undefined;
  readonly output: number | undefined;
  readonly cacheRead: number | undefined;
  readonly cacheWrite: number | undefined;
}

/**
 * The config fragment a free-only arm's repository receives.
 *
 * Every key is one the pinned runtime was measured to accept and normalize (see
 * `docs/SAFE_MODE_1U_FREE_ONLY.md` §2):
 *
 * - `model` — the primary, so a session that is not told otherwise still resolves a free
 *   model;
 * - `small_model` — the legacy key the runtime maps to `agents.title.model`, i.e. the model
 *   for its auxiliary title request. Configuring it is what makes an auxiliary call that
 *   does happen free rather than merely unlikely;
 * - `enabled_providers` — the runtime turns this into a `provider.use` policy that denies
 *   **every** provider and allows only {@link FREE_ONLY_PROVIDER}, so a paid provider
 *   cannot be substituted or fallen back to;
 * - `autoupdate` — a runtime that updated itself mid-experiment would stop being the pinned
 *   revision;
 * - `share` — no session content leaves the machine;
 * - `compaction.auto` — automatic compaction is off, so no summarization request is
 *   composed and a session cannot silently replace the conversation the pass is measured on.
 */
export interface FreeOnlyModelConfig {
  readonly model: string;
  readonly small_model: string;
  readonly enabled_providers: readonly string[];
  readonly autoupdate: boolean;
  readonly share: string;
  readonly compaction: { readonly auto: boolean };
}

/**
 * The one configuration both arms receive.
 *
 * There is no `arm` parameter and there must never be one: the control and treatment arms are
 * separated by the Safe Mode switch alone, and a configuration that could differ per arm
 * would make every pair uncomparable.
 */
export function freeOnlyModelConfig(
  primary: string = FREE_ONLY_PRIMARY_MODEL,
  auxiliary: string = FREE_ONLY_AUXILIARY_MODEL,
): FreeOnlyModelConfig {
  return {
    model: primary,
    small_model: auxiliary,
    enabled_providers: [FREE_ONLY_PROVIDER],
    autoupdate: false,
    share: 'disabled',
    compaction: { auto: false },
  };
}

/**
 * The canonical text of a configuration, for a digest.
 *
 * Key order is fixed by construction (the object is built here), so the digest is stable
 * across processes and can be compared between the two arms' artifacts.
 */
export function freeOnlyModelConfigText(config: FreeOnlyModelConfig): string {
  return `${JSON.stringify(
    {
      model: config.model,
      small_model: config.small_model,
      enabled_providers: [...config.enabled_providers],
      autoupdate: config.autoupdate,
      share: config.share,
      compaction: { auto: config.compaction.auto },
    },
    null,
    2,
  )}\n`;
}

/** SHA-256 of {@link freeOnlyModelConfigText}, as both arms record it. */
export function freeOnlyModelConfigDigest(config: FreeOnlyModelConfig): string {
  return digest(freeOnlyModelConfigText(config));
}

/**
 * True when a value is structurally the free-only configuration.
 *
 * Used on an **artifact**, where the object was written by another process: a run whose
 * recorded configuration is anything else — a paid primary, a missing provider restriction, a
 * missing compaction setting — is refused as a measurement rather than annotated.
 */
export function isFreeOnlyModelConfig(value: unknown, expected?: FreeOnlyModelConfig): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const want = expected ?? freeOnlyModelConfig();
  if (record['model'] !== want.model) return false;
  if (record['small_model'] !== want.small_model) return false;
  if (record['autoupdate'] !== false) return false;
  if (record['share'] !== 'disabled') return false;
  const providers = record['enabled_providers'];
  if (
    !Array.isArray(providers) ||
    providers.length !== want.enabled_providers.length ||
    !want.enabled_providers.every((provider, index) => providers[index] === provider)
  ) {
    return false;
  }
  const compaction = record['compaction'];
  if (typeof compaction !== 'object' || compaction === null || Array.isArray(compaction)) return false;
  return (compaction as Record<string, unknown>)['auto'] === false;
}

/** What one runtime's catalogue says about the model a run would use. */
export interface CataloguePriceFacts {
  /** The model identifier as the run names it (`provider/id`). */
  readonly model: string | undefined;
  /** The runtime that was asked: the isolated private server or the running service. */
  readonly runtime: 'service' | 'standalone';
  /** How many models that runtime reported; `0` means it reported no catalogue at all. */
  readonly catalogueSize: number;
  /** True when the catalogue lists the requested model. */
  readonly listed: boolean | undefined;
  /** The price row the runtime reports for it, or `undefined` when it reports none. */
  readonly priceRow: ModelPriceRow | undefined;
}

/** True when every price tier is present and exactly zero. */
export function isZeroPriceRow(row: ModelPriceRow | undefined): boolean {
  if (row === undefined) return false;
  return FREE_ONLY_PRICE_FIELDS.every((field) => row[field] === 0);
}

/**
 * Reasons this model may not be run. An empty list means the price is verified free.
 *
 * The three refusals are deliberately different sentences, because they need different
 * responses: an unlisted model is a wrong identifier or a wrong runtime, an absent row means
 * the runtime cannot price the model at all (so nothing can be shown to be free), and a
 * non-zero tier means the model is simply not free.
 */
export function freeOnlyPriceRefusals(facts: CataloguePriceFacts): readonly string[] {
  const problems: string[] = [];
  const model = facts.model ?? 'the requested model';
  if (facts.catalogueSize === 0) {
    return [
      `the ${facts.runtime} runtime reported no model catalogue at all, so nothing can be shown to be free (this is the missing-account case, not a model problem)`,
    ];
  }
  if (facts.listed !== true) {
    problems.push(
      `the ${facts.runtime} runtime reported ${String(facts.catalogueSize)} model(s) and does not offer \`${model}\`, so its price cannot be verified`,
    );
    return problems;
  }
  if (facts.priceRow === undefined) {
    problems.push(
      `the ${facts.runtime} runtime lists \`${model}\` but reports no price row for it, so no usage category can be shown to be free`,
    );
    return problems;
  }
  const notZero = FREE_ONLY_PRICE_FIELDS.filter((field) => facts.priceRow?.[field] !== 0);
  if (notZero.length > 0) {
    const detail = notZero
      .map((field) => `${field}=${describePrice(facts.priceRow?.[field])}`)
      .join(', ');
    problems.push(
      `\`${model}\` is not free: the ${facts.runtime} runtime prices ${detail} (USD per million token(s)); every applicable tier must be zero`,
    );
  }
  return problems;
}

/** One price tier, printed so an absent value cannot be read as a zero. */
function describePrice(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : 'unreported';
}

/** Reasons this identifier may not be used at all, whatever the catalogue says. */
export function approvedModelRefusals(model: string | undefined): readonly string[] {
  if (model === undefined || model.trim().length === 0) {
    return ['no model was named, so the run cannot be attributed to an approved free model'];
  }
  if (!FREE_ONLY_APPROVED_MODELS.includes(model)) {
    return [
      `\`${model}\` is not one of the approved free models for this benchmark plan (${FREE_ONLY_APPROVED_MODELS.join(', ')}); changing the model set is a deliberate policy change, not a runtime detail`,
    ];
  }
  return [];
}

/**
 * The spellings of the approved models that a **provider endpoint** may legitimately name.
 *
 * The runtime's own request body names the model *without* its provider — the provider is what
 * the base URL the request was sent to stands for — so an approved `provider/id` reaches a
 * loopback endpoint as `id`. That is measured, not assumed: a Stage 1U rehearsal under the
 * pinned runtime captured bodies naming `mimo-v2.6-flash-free` while the configuration, the
 * hook payload and the runtime's resolved policy all named `opencode/mimo-v2.6-flash-free`.
 *
 * Both spellings are therefore acceptable *for an approved* id and nothing else is: the check
 * that uses this compares against the closed set, so a substituted model still fails — it is the
 * *allowed* set that is widened, never the question of whether a substitution happened. A
 * qualified-only comparison would fail a correct run (it did), and a suffix-only comparison
 * would accept any provider's model of the same name.
 */
export function endpointModelIds(
  approved: readonly string[] = FREE_ONLY_APPROVED_MODELS,
): readonly string[] {
  const ids = new Set<string>();
  for (const id of approved) {
    ids.add(id);
    const slash = id.lastIndexOf('/');
    if (slash >= 0 && slash < id.length - 1) ids.add(id.slice(slash + 1));
  }
  return [...ids];
}

/**
 * True when an endpoint-named model identifier is one of the approved models.
 *
 * `undefined` is false: a request whose body named no readable model is a request that cannot be
 * attributed to an approved model, which is exactly the case this must refuse rather than pass.
 */
export function isApprovedEndpointModel(
  id: string | undefined,
  approved: readonly string[] = FREE_ONLY_APPROVED_MODELS,
): boolean {
  return id !== undefined && endpointModelIds(approved).includes(id);
}

/**
 * The envelope the **pre-transmission model guard** enforces inside a session.
 *
 * Same policy, second enforcement point. The configuration and the price gate decide whether a run
 * may be *started*; this envelope decides whether a request assembled during the session may be
 * *sent* — the one thing neither of those can see, and the one case where a paid model inside an
 * allowed provider would already be on the wire before any evidence gate could refuse the run.
 *
 * `policyDigest` is the free-only configuration digest, so the guard's evidence is checked against
 * the exact policy that was in force rather than against a list the guard chose for itself.
 */
export interface FreeOnlyGuardPolicy {
  /** The one model a `primary` (agent loop) request may use. */
  readonly primary: string;
  /** Every model identifier a request may name. */
  readonly approved: readonly string[];
  /** The request kinds the runtime declares, and the only kinds that may be dispatched. */
  readonly allowedKinds: readonly string[];
  readonly policyDigest: string;
}

/**
 * The guard envelope for one model pair. Pure, so the driver and the benchmark cannot disagree.
 *
 * There is no `arm` parameter, for the same reason {@link freeOnlyModelConfig} has none: both arms
 * must be bounded identically, and a per-arm envelope would be an experiment difference.
 */
export function modelGuardPolicy(
  primary: string = FREE_ONLY_PRIMARY_MODEL,
  auxiliary: string = FREE_ONLY_AUXILIARY_MODEL,
): FreeOnlyGuardPolicy {
  const config = freeOnlyModelConfig(primary, auxiliary);
  return {
    primary: config.model,
    approved: [config.model, config.small_model],
    // Every kind the runtime declares. An unknown kind is refused by the guard (fail closed), which
    // is why this list has to be the runtime's own vocabulary rather than "everything we expect".
    allowedKinds: [...REQUEST_KINDS],
    policyDigest: freeOnlyModelConfigDigest(config),
  };
}

/** The whole pre-spawn verdict for one model: approved, listed, and zero in every tier. */
export function freeOnlyRefusals(facts: CataloguePriceFacts): readonly string[] {
  return [...approvedModelRefusals(facts.model), ...freeOnlyPriceRefusals(facts)];
}

/** The price facts as one printable line, for a preflight. */
export function describePriceFacts(facts: CataloguePriceFacts): string {
  const price =
    facts.priceRow === undefined
      ? 'no price row reported'
      : FREE_ONLY_PRICE_FIELDS.map((field) => `${field} ${describePrice(facts.priceRow?.[field])}`).join(
          ' / ',
        );
  return `${facts.runtime} catalogue ${String(facts.catalogueSize)} model(s), \`${facts.model ?? 'none'}\` ${
    facts.listed === true ? 'listed' : facts.listed === false ? 'NOT listed' : 'unprobed'
  }, ${price} (USD per million token(s)) — ${isZeroPriceRow(facts.priceRow) ? 'FREE' : 'NOT VERIFIED FREE'}`;
}

/**
 * What the pinned runtime resolved for one repository, as its own `config.get` reports it.
 *
 * Read from the document the driver itself wrote, not from a summary of the whole
 * configuration: the question is whether *these* keys survived the runtime's normalization.
 * A key the runtime does not recognize is omitted from this answer, which is what makes the
 * reading evidence rather than a restatement of intent.
 */
export interface ResolvedModelPolicyFacts {
  /** Exactly which read-only call produced this, so the claim names its source. */
  readonly source: string;
  /** True when the runtime reported a document for this repository's own config file. */
  readonly found: boolean;
  /** The primary the runtime resolved, as `provider/id`. */
  readonly model: string | undefined;
  /** The model the runtime resolved for its auxiliary title agent. */
  readonly titleModel: string | undefined;
  /** `compaction.auto` as resolved, or `undefined` when the key was omitted. */
  readonly compactionAuto: boolean | undefined;
  /** Providers the resolved `provider.use` policy allows. */
  readonly providersAllowed: readonly string[];
  /** True when the resolved policy denies every provider and allows only the free one. */
  readonly providersDeniedAll: boolean;
  /** `update` as resolved from `autoupdate`, or `undefined` when the key was omitted. */
  readonly update: string | undefined;
  readonly share: string | undefined;
  readonly error: string | undefined;
}

/**
 * Join a resolved model reference (`{providerID, model}`) the way a caller names a model.
 *
 * A reference that carries an empty or blank half is `undefined` rather than a name: `/mimo-…`
 * attributes a model to no provider at all, and a caller comparing it with the approved ids would
 * refuse *everything* while believing it had read a model. This is the **same rule the shipped
 * model guard applies** to the payload the runtime hands a hook, and the two are asserted equal over
 * a matrix of shapes by the model-guard probe's test — two implementations of "which model is this"
 * is exactly how a request on one model is checked against the identity of another.
 */
export function modelRefToId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.includes('/') ? trimmed : undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = record['providerID'] ?? record['provider'];
  const model = record['model'] ?? record['modelID'] ?? record['id'];
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  if (provider.trim().length === 0 || model.trim().length === 0) return undefined;
  return `${provider.trim()}/${model.trim()}`;
}

/**
 * Reasons a live session must not start under this resolved configuration.
 *
 * These are the checks that make "the runtime applied it" a fact rather than an assumption.
 * Each one is a setting whose silent omission would let a request leave the free-only
 * envelope: the primary model, the auxiliary model, the provider restriction, and
 * compaction.
 */
export function resolvedPolicyRefusals(
  resolved: ResolvedModelPolicyFacts,
  expected: FreeOnlyModelConfig = freeOnlyModelConfig(),
): readonly string[] {
  const problems: string[] = [];
  if (!resolved.found) {
    return [
      `the runtime did not report a resolved configuration for this repository (${resolved.error ?? 'no reason reported'}), so none of the free-only settings can be shown to have taken effect`,
    ];
  }
  if (resolved.model !== expected.model) {
    problems.push(
      `the runtime resolved primary model \`${resolved.model ?? 'none'}\` while the run requires \`${expected.model}\``,
    );
  }
  const title = resolved.titleModel;
  if (title === undefined || !FREE_ONLY_APPROVED_MODELS.includes(title)) {
    problems.push(
      `the runtime resolved auxiliary (title) model \`${title ?? 'none'}\`, which is not one of the approved free models (${FREE_ONLY_APPROVED_MODELS.join(', ')})`,
    );
  }
  const allowed = resolved.providersAllowed;
  const onlyFreeProvider =
    resolved.providersDeniedAll &&
    allowed.length === 1 &&
    allowed[0] === FREE_ONLY_PROVIDER;
  if (!onlyFreeProvider) {
    problems.push(
      `the runtime resolved a provider-use policy that is not "deny every provider except ${FREE_ONLY_PROVIDER}" (denies-all=${String(resolved.providersDeniedAll)}, allows=[${allowed.join(', ') || 'none'}]), so a paid provider could be substituted or fallen back to`,
    );
  }
  if (resolved.compactionAuto !== false) {
    problems.push(
      `the runtime resolved \`compaction.auto\` as ${resolved.compactionAuto === undefined ? 'absent (the key was not recognized or was dropped)' : String(resolved.compactionAuto)}, so automatic compaction is not disabled`,
    );
  }
  if (resolved.update === 'auto') {
    problems.push('the runtime resolved automatic updates as enabled, so the pinned revision is not pinned');
  }
  return problems;
}

/**
 * Read a recorded resolved-policy block back into the shape the checks use.
 *
 * Absent is absent: an unreadable block returns `undefined` so the caller refuses rather than
 * checking a default. The model references are normalized to `provider/id` here, so the value
 * the runtime reported can be compared with the identifiers the policy names.
 */
export function readResolvedModelPolicy(value: unknown): ResolvedModelPolicyFacts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = record['providersAllowed'];
  return {
    source: typeof record['source'] === 'string' ? record['source'] : 'unrecorded',
    found: record['found'] === true,
    model: typeof record['model'] === 'string' ? record['model'] : undefined,
    titleModel: typeof record['titleModel'] === 'string' ? record['titleModel'] : undefined,
    compactionAuto:
      typeof record['compactionAuto'] === 'boolean' ? record['compactionAuto'] : undefined,
    providersAllowed: Array.isArray(allowed)
      ? allowed.filter((entry): entry is string => typeof entry === 'string')
      : [],
    providersDeniedAll: record['providersDeniedAll'] === true,
    update: typeof record['update'] === 'string' ? record['update'] : undefined,
    share: typeof record['share'] === 'string' ? record['share'] : undefined,
    error: typeof record['error'] === 'string' ? record['error'] : undefined,
  };
}

/** One line describing the resolved configuration, for an artifact note or a preflight. */
export function describeResolvedPolicy(resolved: ResolvedModelPolicyFacts): string {
  if (!resolved.found) {
    return `not reported (${resolved.error ?? 'no reason recorded'})`;
  }
  return (
    `primary ${resolved.model ?? 'none'}, auxiliary ${resolved.titleModel ?? 'none'}, ` +
    `providers allowed [${resolved.providersAllowed.join(', ') || 'none'}]` +
    `${resolved.providersDeniedAll ? ' with every other provider denied' : ' with NO deny-others rule'}, ` +
    `compaction.auto ${resolved.compactionAuto === undefined ? 'absent' : String(resolved.compactionAuto)}, ` +
    `update ${resolved.update ?? 'unreported'}, share ${resolved.share ?? 'unreported'}`
  );
}
