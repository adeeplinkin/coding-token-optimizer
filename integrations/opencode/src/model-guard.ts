/**
 * Pre-transmission **model guard** for a harness-run OpenCode session (Stage 1U).
 *
 * ## The problem this closes
 *
 * The free-only policy restricts the *provider* (`enabled_providers: ["opencode"]`), and the
 * benchmark's evidence gates refuse a run whose requests named anything else — but both are
 * **after the fact**: the provider restriction still admits every model that provider offers
 * (free and paid alike), and an evidence gate can invalidate a measurement without preventing
 * the request it measures. This module is the missing pre-transmission check: it looks at the
 * model a request is about to use and, when that model is not explicitly approved, **aborts the
 * request before it is dispatched**.
 *
 * ## Why this is a supported mechanism, not a trick
 *
 * Three independent facts, all recorded in this repository:
 *
 * 1. `ctx.session.hook("model.request")` is part of the **published** V2 session contract
 *    (`SessionHooks` in `@opencode/plugin@2.0.24`); the payload carries the request's own
 *    `kind`, its `model`, its `baseURL` and its `headers`.
 * 2. The hook fires **before** the request is built and sent. Read out of the pinned
 *    `opencode-cli.exe` 2.0.24 (`sha256 37cafb7e…4d37fc`), the dispatch site is
 *    `U = yield* e.trigger("session", "model.request", { ...l, baseURL, headers })`, and the
 *    returned object is what the runtime then uses for the route and the headers —
 *    `ee = U.baseURL !== undefined && U.baseURL !== X ? pe.model.route.with({ endpoint: { baseURL: U.baseURL } }) : pe.model.route`.
 *    There is no HTTP request before this point.
 * 3. The hook dispatcher runs callbacks with **no `try`/`catch`** — `yield* h.callback(f)` in the
 *    plugin-hooks trigger — so an exception propagates out of the dispatch site. That is the same
 *    property the vendor's own documented example relies on when it throws from
 *    `tool.execute.before` to *block* a tool, and it is why the observer's own rule has always been
 *    "never throw from a hook": a throw stops the operation it interrupts.
 *
 * So a refusal here is a **thrown error**, exactly like the containment guard's refusal, and the
 * operation it interrupts is the model request — before any provider is contacted.
 *
 * ## What it refuses, and why exactly this
 *
 * | Request | Decision |
 * | --- | --- |
 * | `kind` is one of the runtime's declared kinds and the model is an approved id | allowed |
 * | the model is not an approved id (a paid model, another provider's model, an unknown id) | refused — `model-not-approved` |
 * | the model cannot be read out of the payload at all | refused — `model-unreadable` |
 * | `kind` is missing, or is not one of the runtime's declared kinds | refused — `request-kind-absent` / `request-kind-unsupported` |
 * | `kind` is `primary` but the model is an approved *auxiliary* | refused — `primary-model-substituted` |
 * | the guard was constructed without a usable policy | every request refused — `not-configured` |
 *
 * Two deliberate omissions, both stated rather than hidden:
 *
 * - **No provider filter.** The published hook options can filter a registration by `providerID`.
 *   This guard passes no options, so it sees *every* request whatever the provider: a filter would
 *   make a request from a provider the filter does not name skip the guard entirely, which is the
 *   opposite of fail-closed.
 * - **No rewrite.** A refusal does not substitute an approved model. Silently running a different
 *   model than the one the session asked for would produce a measurement that describes neither
 *   model, which is the failure mode this whole policy exists to prevent.
 *
 * What the guard cannot promise is stated in the docs: it covers requests the runtime dispatches
 * through this hook on the pinned revision, and a host that does not expose the hook is recorded
 * as a missing capability so the harness refuses the run instead of assuming enforcement.
 *
 * The guard emits content-free evidence (counts, request kinds, model **identifiers**, reasons)
 * through a caller-supplied sink, and never writes a file of its own.
 */
import { defineOpenCodeV2Plugin } from './types-v2.js';
import type {
  OpenCodeV2Plugin,
  OpenCodeV2PluginContext,
  OpenCodeV2SessionModelRequest,
} from './types-v2.js';

/** Plugin id used in `Plugin.define({ id, setup })`. */
export const MODEL_GUARD_PLUGIN_ID = 'dr-token-model-guard';

/** The request kinds the pinned runtime declares (`SessionRequestKind`). */
export const MODEL_GUARD_REQUEST_KINDS: readonly string[] = [
  'primary',
  'compaction',
  'title',
  'generate',
];

/** Why a request was refused. Every value is a policy decision, never a guess. */
export type ModelGuardRefusalReason =
  | 'not-configured'
  | 'request-kind-absent'
  | 'request-kind-unsupported'
  | 'model-unreadable'
  | 'model-not-approved'
  | 'primary-model-substituted';

/** The approved envelope the guard enforces. Supplied by the caller (the arm driver). */
export interface ModelGuardPolicy {
  /** The one model a `primary` request may use, as `provider/id`. */
  readonly primary: string;
  /** Every model identifier a request may name, as `provider/id`. */
  readonly approved: readonly string[];
  /** The request kinds that may be dispatched at all. */
  readonly allowedKinds: readonly string[];
  /**
   * The digest of the benchmark's free-only policy this envelope was derived from.
   *
   * Recorded on every evidence line so the artifact can be checked against the policy that was
   * in force rather than against a policy the guard decided for itself.
   */
  readonly policyDigest: string;
}

/** One decision about one request. */
export interface ModelGuardDecision {
  readonly allow: boolean;
  readonly reason?: ModelGuardRefusalReason;
  /** The model identifier as normalized, when it could be read. */
  readonly model?: string;
  /** The request kind as reported, when it could be read. */
  readonly kind?: string;
  /** A content-free sentence for the record. */
  readonly detail: string;
}

/** One evidence line. Counts, kinds, model identifiers and reasons — never request content. */
export interface ModelGuardEvidenceLine {
  readonly kind:
    | 'loaded'
    | 'misconfigured'
    | 'hook-registered'
    | 'hook-capability-missing'
    | 'hook-registration-failed'
    | 'allowed'
    | 'refused';
  readonly at: string;
  readonly policyDigest?: string;
  readonly requestKind?: string;
  readonly model?: string;
  readonly reason?: ModelGuardRefusalReason;
}

/** What the guard's own evidence says happened, as the artifact records it. */
export interface ModelGuardEvidenceSummary {
  readonly loaded: boolean;
  readonly hookRegistered: boolean;
  readonly capabilityMissing: boolean;
  readonly invocations: number;
  readonly allowed: number;
  readonly refused: number;
  readonly refusals: readonly {
    readonly requestKind?: string;
    readonly model?: string;
    readonly reason: ModelGuardRefusalReason;
  }[];
  readonly policyDigest: string;
  /** True when the guard was constructed without a usable policy. */
  readonly misconfigured: boolean;
}

/**
 * Normalize a model reference the way the runtime reports it.
 *
 * Accepts what the pinned runtime hands over — an object (`{providerID, model}`, `{providerID,
 * modelID}`) or a string already in `provider/id` form — and returns `provider/id`, or `undefined`
 * when the value carries no usable identifier. Both halves are trimmed, and a blank half is
 * `undefined` rather than a name: `/mimo-…` attributes a model to no provider, which is not the same
 * model as any approved one.
 *
 * The canonical normalizer lives in the benchmark's free-only policy module; this one exists because
 * the shipped plugin may not depend on the benchmark package. The two are asserted equal, shape by
 * shape, by the model-guard probe's test — so a divergence is a failing test rather than a quiet
 * disagreement about what a model identifier is. The one deliberate difference is recorded there: a
 * **hook payload** may carry the model as a nested `{ id }`, which this accepts, while the config
 * document the policy reader parses does not, which is why they are compared over the shapes both
 * are handed.
 */
export function normalizeModelId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.includes('/') ? trimmed : undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = record['providerID'] ?? record['provider'];
  const model = record['model'] ?? record['modelID'] ?? record['id'];
  if (typeof provider !== 'string' || provider.trim().length === 0) return undefined;
  // `model` may itself be a nested `{ id }` in some payload variants; accept one level.
  const modelId =
    typeof model === 'string'
      ? model
      : typeof model === 'object' && model !== null
        ? (model as Record<string, unknown>)['id']
        : undefined;
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return undefined;
  // Both halves are trimmed, so ` opencode / mimo ` and `opencode/mimo` are the same model rather
  // than two identifiers that refuse against each other. The benchmark's policy module applies the
  // identical rule, and the model-guard probe's test asserts the two agree shape by shape.
  return `${provider.trim()}/${modelId.trim()}`;
}

/** The acceptable spellings of an approved identifier, mirrored from the benchmark policy. */
function acceptableIds(approved: readonly string[]): readonly string[] {
  const ids = new Set<string>();
  for (const id of approved) {
    ids.add(id);
    const slash = id.lastIndexOf('/');
    if (slash >= 0 && slash < id.length - 1) ids.add(id.slice(slash + 1));
  }
  return [...ids];
}

/**
 * Decide one request. Pure, so every branch is unit-testable without a runtime.
 *
 * The order of the checks is deliberate: a request that cannot be read is refused before it can
 * be compared, and an unconfigured guard refuses everything rather than allowing by default.
 */
export function evaluateModelRequest(
  input: { readonly kind?: unknown; readonly model?: unknown },
  policy: ModelGuardPolicy,
): ModelGuardDecision {
  if (
    typeof policy.primary !== 'string' ||
    policy.primary.trim().length === 0 ||
    !Array.isArray(policy.approved) ||
    policy.approved.length === 0 ||
    !Array.isArray(policy.allowedKinds) ||
    policy.allowedKinds.length === 0
  ) {
    return {
      allow: false,
      reason: 'not-configured',
      detail:
        'the model guard was constructed without an approved model envelope, so no request can be shown to be inside it',
    };
  }
  const kind = typeof input.kind === 'string' && input.kind.trim().length > 0 ? input.kind : undefined;
  if (kind === undefined) {
    return {
      allow: false,
      reason: 'request-kind-absent',
      detail:
        'the request carries no request kind, so the guard cannot tell which model the policy allows for it',
    };
  }
  if (!policy.allowedKinds.includes(kind)) {
    return {
      allow: false,
      kind,
      reason: 'request-kind-unsupported',
      detail: `request kind \`${kind}\` is not one of the runtime's declared kinds (${policy.allowedKinds.join(', ')})`,
    };
  }
  const model = normalizeModelId(input.model);
  if (model === undefined) {
    return {
      allow: false,
      kind,
      reason: 'model-unreadable',
      detail:
        'the request names no readable model identifier, so the guard cannot show that it is an approved free model',
    };
  }
  if (!acceptableIds(policy.approved).includes(model)) {
    return {
      allow: false,
      kind,
      model,
      reason: 'model-not-approved',
      detail: `\`${model}\` is not one of the approved free models (${policy.approved.join(', ')})`,
    };
  }
  if (kind === 'primary' && model !== policy.primary) {
    return {
      allow: false,
      kind,
      model,
      reason: 'primary-model-substituted',
      detail: `the agent loop is running \`${model}\` while the free-only policy pins the primary model to \`${policy.primary}\``,
    };
  }
  return { allow: true, kind, model, detail: `\`${model}\` is approved for a \`${kind}\` request` };
}

/**
 * Summarize the guard's evidence lines.
 *
 * `loaded`/`hookRegistered` are the two facts the harness requires before it will treat a session
 * as one whose requests were bounded: the plugin ran, and the hook that refuses requests was
 * actually accepted by the runtime. A registration that failed is reported as a missing capability
 * rather than as an armed guard, because a hook the runtime never accepted cannot refuse anything.
 */
export function summarizeModelGuardEvidence(
  lines: readonly ModelGuardEvidenceLine[],
): ModelGuardEvidenceSummary {
  const refusals: {
    requestKind?: string;
    model?: string;
    reason: ModelGuardRefusalReason;
  }[] = [];
  let loaded = false;
  let hookRegistered = false;
  let capabilityMissing = false;
  let misconfigured = false;
  let allowed = 0;
  let policyDigest = '';
  for (const line of lines) {
    if (typeof line?.policyDigest === 'string' && line.policyDigest.length > 0) {
      policyDigest = line.policyDigest;
    }
    switch (line?.kind) {
      case 'loaded':
        loaded = true;
        break;
      case 'misconfigured':
        misconfigured = true;
        break;
      case 'hook-registered':
        hookRegistered = true;
        break;
      case 'hook-capability-missing':
      case 'hook-registration-failed':
        capabilityMissing = true;
        break;
      case 'allowed':
        allowed += 1;
        break;
      case 'refused':
        if (typeof line.reason === 'string') {
          refusals.push({
            ...(typeof line.requestKind === 'string' ? { requestKind: line.requestKind } : {}),
            ...(typeof line.model === 'string' ? { model: line.model } : {}),
            reason: line.reason,
          });
        }
        break;
      default:
        break;
    }
  }
  return {
    loaded,
    hookRegistered,
    capabilityMissing,
    invocations: allowed + refusals.length,
    allowed,
    refused: refusals.length,
    refusals,
    policyDigest,
    misconfigured,
  };
}

/** Options for {@link createModelGuardPluginV2}. */
export interface ModelGuardOptions {
  /** The approved envelope. Omitted or empty means every request is refused. */
  readonly policy?: ModelGuardPolicy;
  /**
   * Receives each evidence line.
   *
   * The sink belongs to the caller, not to this package: the generated project-local plugin file
   * (written by the arm driver, outside this package) appends the lines to its own JSONL file, so
   * the observation package keeps its rule that only its opt-in summary sink writes anything.
   */
  readonly onEvidence?: (line: ModelGuardEvidenceLine) => void;
  /** Test seam: clock for the `at` field. */
  readonly now?: () => string;
}

/** An empty policy, used when the caller supplies none: it refuses everything. */
const UNCONFIGURED_POLICY: ModelGuardPolicy = {
  primary: '',
  approved: [],
  allowedKinds: [],
  policyDigest: '',
};

/**
 * Create the guard plugin definition.
 *
 * Deliberately a separate plugin from the observer and from the containment guard: this one
 * changes what the runtime may send, and keeping the three contracts apart keeps each of them
 * checkable on its own.
 */
export function createModelGuardPluginV2(options: ModelGuardOptions = {}): OpenCodeV2Plugin {
  return defineOpenCodeV2Plugin({
    id: MODEL_GUARD_PLUGIN_ID,
    setup(context: OpenCodeV2PluginContext) {
      const now = options.now ?? (() => new Date().toISOString());
      const policy = options.policy ?? UNCONFIGURED_POLICY;
      const configured =
        typeof policy.primary === 'string' &&
        policy.primary.trim().length > 0 &&
        Array.isArray(policy.approved) &&
        policy.approved.length > 0 &&
        Array.isArray(policy.allowedKinds) &&
        policy.allowedKinds.length > 0;

      const emit = (line: ModelGuardEvidenceLine): void => {
        try {
          options.onEvidence?.(line);
        } catch {
          // Evidence is best effort: a sink failure must never change what the session does.
        }
      };

      emit({ kind: 'loaded', at: now(), policyDigest: policy.policyDigest });
      if (!configured) {
        emit({ kind: 'misconfigured', at: now(), policyDigest: policy.policyDigest });
      }

      const session = context?.session;
      if (typeof session?.hook !== 'function') {
        // Fail closed in the only way a plugin can: say so. The harness refuses a session whose
        // guard never registered rather than assuming the requests were bounded.
        emit({
          kind: 'hook-capability-missing',
          at: now(),
          policyDigest: policy.policyDigest,
        });
        return () => undefined;
      }

      // No options argument: see the module doc — a provider filter would make a request from
      // another provider skip the guard entirely.
      void session
        .hook('model.request', (payload: OpenCodeV2SessionModelRequest) => {
          let decision: ModelGuardDecision;
          try {
            decision = evaluateModelRequest(
              { kind: payload?.kind, model: payload?.model },
              policy,
            );
          } catch (error) {
            // The evaluator is pure and total; if it ever throws, the request is refused rather
            // than allowed, because an unclassifiable request is exactly the case this exists for.
            decision = {
              allow: false,
              reason: 'model-unreadable',
              detail: `the request could not be classified (${error instanceof Error ? error.name : 'unknown error'})`,
            };
          }
          if (decision.allow) {
            emit({
              kind: 'allowed',
              at: now(),
              policyDigest: policy.policyDigest,
              ...(decision.kind === undefined ? {} : { requestKind: decision.kind }),
              ...(decision.model === undefined ? {} : { model: decision.model }),
            });
            return;
          }
          // Recorded before the throw: the evidence must exist even though the exception ends the
          // request, and the throw is what stops it from being dispatched.
          emit({
            kind: 'refused',
            at: now(),
            policyDigest: policy.policyDigest,
            ...(decision.kind === undefined ? {} : { requestKind: decision.kind }),
            ...(decision.model === undefined ? {} : { model: decision.model }),
            reason: decision.reason ?? 'model-not-approved',
          });
          throw new Error(`dr-token model guard: ${decision.detail}. The request was refused before it was sent.`);
        })
        .then(() => {
          emit({ kind: 'hook-registered', at: now(), policyDigest: policy.policyDigest });
        })
        .catch(() => {
          emit({ kind: 'hook-registration-failed', at: now(), policyDigest: policy.policyDigest });
        });

      return () => undefined;
    },
  });
}
