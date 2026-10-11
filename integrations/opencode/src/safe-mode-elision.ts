/**
 * Safe Mode pass `safe.exact-duplicate-tool-result-elision`, version 1 — the first Dr. Token
 * transformation. **Disabled by default; apply requires an explicit opt-in.**
 *
 * ## What it does
 *
 * When the host is assembling a model request, if two tool-result parts of a *read-only* tool inside
 * the **same** request carry **byte-identical** model-visible text, the **later** part's text is
 * replaced with a fixed, explicit marker — but only when the earlier identical text is *still present
 * in that same request*. Nothing else about the request is touched.
 *
 * Condition E3 + E4 together are the whole safety argument: at send time the removed text is present
 * elsewhere *in the same payload*, so no information the model was going to receive is lost
 * (design §4.2).
 *
 * ## Eligibility comes from the M1 analyzer
 *
 * This module does not restate the eligibility rules as its own authority. It asks
 * {@link analyseRequestOpportunities} — the Stage 1Q analyzer — how many occurrences are eligible,
 * and then walks the same payload to locate them. If the located count differs from the analyzer's
 * count the whole request is refused (`plan-mismatch`): the pass would rather do nothing than edit a
 * request it cannot account for. Refusals the analyzer already models (error results, non-allowlisted
 * tools, provider-executed results, payloads over the per-result bound, a marker already present
 * anywhere, a bounded scan) are inherited unchanged, and the 400-character threshold is the
 * analyzer's own default.
 *
 * ## The request-kind gate (E8)
 *
 * The `context` payload carries no `kind`, so the gate cannot read one. It is therefore expressed as
 * two positively verified facts and refuses when either is missing:
 *
 * 1. **`requestKindBasis`** — the caller states how it established that this is a primary model call.
 *    Only `context-hook` is accepted, and it is accepted because Stage 1T verified the kind → hook
 *    mapping at the runtime's single dispatch site (see below) *and* in a live session: `context`
 *    fired exactly once per `model.request` whose kind was `primary` (2 invocations, 2 primary
 *    requests), while the one title request fired the separate `title` hook and no `context` at all.
 *    Hook identity is not a timing guess or an event correlation: the host selects the hook by name.
 * 2. **payload shape** — the payload must be agent-loop shaped: a `messages` array, a non-empty
 *    `agent`, and a **non-empty** `tools` registry. A title payload lacks `agent` and `tools`; the
 *    live primary requests each declared 12 tool definitions. This is a second, independent barrier:
 *    a payload that declares no tools is not the primary agent loop, whichever hook delivered it.
 *
 * ### Why hook identity is a kind guarantee, not an inference
 *
 * The runtime's `SessionRequestKind` is `primary | compaction | title | generate`, and Stage 1T
 * verified — in the installed runtime itself, not only by observation — that the kind selects the
 * hook **name** at the single dispatch site:
 *
 * ```text
 * a = (c, d) => (f, D) => e.trigger("session", c, { ...f, agent: d, tools: D });
 * wb.of({
 *   primary:    (c) => s("primary",    c, a("context",    c.agent)),
 *   compaction: (c) => s("compaction", c, a("compaction", c.agent)),
 *   generate:   (c) => s("generate",   c, a("generate",   c.agent)),
 *   title:      (c) => s("title",      c, (d) => e.trigger("session", "title", d)),
 * })
 * ```
 *
 * (this readable form is reflowed from the minified text in `opencode-cli.exe` 2.0.24; the unedited
 * excerpt and the reproduction commands are in docs/SAFE_MODE_1T_APPLY_VALIDATION.md §3). There is
 * exactly one mapping site, it pairs each service method with exactly one hook name, and the only
 * method that triggers `context` is `primary`. `compaction` and `generate` trigger their own names;
 * `title` triggers `title`. A live session agrees: `context` fired once per `model.request` of kind
 * `primary`, and the title request fired `title` and no `context`.
 *
 * This paragraph is the whole reason E8 is enforceable here. It is worth being explicit about the two
 * residual assumptions, because they are *assumptions*, not measurements: a future runtime could map
 * kinds differently, and an experimental/undocumented path could trigger `context` for something that
 * is not the primary agent loop. Both are covered the same way — the payload must also be primary
 * agent-loop shaped, and anything unrecognised refuses rather than elides.
 *
 * Anything else refuses. A refusal is recorded, never guessed, and never becomes an exception in the
 * host's request builder.
 *
 * ## Idempotence, concurrency and reloads
 *
 * The pass keeps **no state**: the request is the cache (design §4.4). No cache, TTL, session map or
 * file is involved, so a retry, a host reload or a second request cannot inherit a stale decision.
 * Two guards make a repeated or concurrent application harmless:
 *
 * - the marker contains the M1 marker prefix `dr-token/safe-mode/`, so a request that already carries
 *   one is refused outright by E7 (`marker-collision`) — a second pass over the *same* payload does
 *   nothing;
 * - every write re-reads the value at its location and writes only when it still equals the text the
 *   plan was made from (`assignment-guard-failed` otherwise) — so a second plugin instance, a
 *   concurrent request or anything else that changed the value first makes this one skip.
 *
 * ## Privacy, bounds and failure posture
 *
 * The returned outcome holds counts, booleans and the kind basis — no tool text, path, digest, session
 * id or prompt fragment. The only assignment in the module is one `result.value` write inside the
 * documented loop; `system`, `options`, `tools`, tool-call inputs, permissions and tool identity are
 * never assigned, deleted or redefined. Read-only outside that loop, and fail-open at the edges: an
 * unreadable part is skipped, a failed write is contained, and the caller's payload is never left in a
 * half-edited state for a target that was refused.
 */
import {
  DEFAULT_OPPORTUNITY_LIMITS,
  SAFE_MODE_MARKER_PREFIX,
  SAFE_MODE_TOOL_ALLOWLIST,
  analyseRequestOpportunities,
  type OpportunityLimits,
} from './opportunity.js';

/** Pass identity, as recorded by the design (§4.1). */
export const SAFE_MODE_ELISION_PASS_ID = 'safe.exact-duplicate-tool-result-elision';

/** Version of this pass. A new marker or rule change must bump it. */
export const SAFE_MODE_ELISION_VERSION = 1;

/**
 * The replacement text (design §4.3), verbatim.
 *
 * One line, versioned, unmistakable, content-free: it never claims to *be* tool output, never
 * summarizes or paraphrases the elided content, and states only what was verified before it was
 * written. It contains {@link SAFE_MODE_MARKER_PREFIX}, which is what makes a second pass over the
 * same request refuse instead of eliding the marker.
 */
export const SAFE_MODE_ELISION_MARKER =
  '[dr-token/safe-mode/v1: duplicate of an identical earlier tool result for the same target; the original content is still present above in this conversation and was not modified.]';

/**
 * How the caller established the request kind.
 *
 * `context-hook` is the only accepted basis (see the module note). `unknown` exists so a caller that
 * cannot state a basis has an honest value to pass instead of a guess.
 */
export const SAFE_MODE_REQUEST_KIND_BASES = ['context-hook', 'unknown'] as const;

export type SafeModeRequestKindBasis = (typeof SAFE_MODE_REQUEST_KIND_BASES)[number];

/** Why the pass did not transform, or did not transform everything it planned. */
export const SAFE_MODE_ELISION_REFUSAL_REASONS = [
  /** Applying was not explicitly opted into. The payload was not examined. */
  'disabled',
  /** The caller could not establish that this is a primary model call. */
  'request-kind-unverified',
  /** The payload is not agent-loop shaped, so it cannot be a primary request's context. */
  'payload-not-agent-loop-shaped',
  /** The payload is not request-shaped at all. */
  'not-request-shaped',
  /** Some examined part already contained the marker prefix (E7). */
  'marker-collision',
  /** The scan hit a processing bound (E9); a bounded request refuses. */
  'scan-bounded',
  /** The located occurrences did not match the analyzer's eligible count. Nothing was written. */
  'plan-mismatch',
  /** The value at a location no longer matched the planned text, so that write was skipped. */
  'assignment-guard-failed',
] as const;

export type SafeModeElisionRefusalReason = (typeof SAFE_MODE_ELISION_REFUSAL_REASONS)[number];

/** Statements that must travel with any number this module reports. */
export const SAFE_MODE_ELISION_NOTES: readonly string[] = [
  'Safe Mode apply: eligible duplicate tool-result text was replaced by the versioned marker. This is a request-size change, not a token measurement.',
  'Characters and bytes removed or written are properties of the assembled request. No token figure is derived from them, and no saving is claimed.',
  'The elided text was byte-identical to an earlier copy still present in the same request; error, malformed, oversized, provider-executed and non-allowlisted results are never elided.',
];

/** All-zero refusal counters, with every reason present. */
export function emptyElisionRefusals(): Record<SafeModeElisionRefusalReason, number> {
  return {
    disabled: 0,
    'request-kind-unverified': 0,
    'payload-not-agent-loop-shaped': 0,
    'not-request-shaped': 0,
    'marker-collision': 0,
    'scan-bounded': 0,
    'plan-mismatch': 0,
    'assignment-guard-failed': 0,
  };
}

/** Options for one application attempt. */
export interface SafeModeElisionOptions {
  /** How the caller established that this request is a primary model call. */
  readonly requestKindBasis: SafeModeRequestKindBasis;
  /** Explicit opt-in. Anything other than `true` leaves the payload untouched. */
  readonly enabled?: boolean;
  /** Bounds for the scan; defaults to the M1 analyzer's defaults (400-character threshold). */
  readonly limits?: Partial<OpportunityLimits>;
}

/**
 * Content-free result of one application attempt.
 *
 * `attempted` is true only when the payload passed every request-level gate and was scanned;
 * `applied` is true only when at least one marker was written. `elided*` describe the text that was
 * replaced, `marker*` the text written in its place — request-size facts, never tokens.
 */
export interface SafeModeElisionOutcome {
  readonly passId: string;
  readonly version: number;
  readonly requestKindBasis: SafeModeRequestKindBasis;
  readonly attempted: boolean;
  readonly applied: boolean;
  /** Occurrences whose text was replaced by the marker. */
  readonly elidedOccurrences: number;
  /** UTF-16 code units of the replaced text. */
  readonly elidedCharacters: number;
  /** UTF-8 bytes of the replaced text. */
  readonly elidedBytes: number;
  /** Markers written (always equal to {@link elidedOccurrences} when nothing threw). */
  readonly markerWrites: number;
  /** UTF-8 bytes of the marker text that was written. */
  readonly markerBytes: number;
  /** Refusals encountered, by reason. */
  readonly refused: Readonly<Record<SafeModeElisionRefusalReason, number>>;
  /** The statements above, carried so no number can be read without them. */
  readonly notes: readonly string[];
}

/** One planned replacement, located in the payload but not yet written. */
interface ElisionTarget {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly expectedText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the payload is shaped like a primary agent-loop `SessionContext`.
 *
 * Verified against the live runtime in Stage 1T: the `context` payload carries `agent`, `tools` and
 * `messages`, while the `title` payload carries only `messages`, `model`, `options`, `sessionID` and
 * `system`. The tool registry must be **non-empty**: every observed primary request declared tools
 * (12 of them), and a request that declares none is not the agent loop, so it is refused rather than
 * assumed to be one.
 */
export function isAgentLoopContextPayload(context: unknown): boolean {
  if (!isRecord(context)) {
    return false;
  }
  if (!Array.isArray(context['messages'])) {
    return false;
  }
  const agent = context['agent'];
  if (typeof agent !== 'string' || agent.trim().length === 0) {
    return false;
  }
  const tools = context['tools'];
  return isRecord(tools) && Object.keys(tools).length > 0;
}

function resolveLimits(overrides: Partial<OpportunityLimits> | undefined): OpportunityLimits {
  const provided = overrides ?? {};
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    maxMessages: positive(provided.maxMessages, DEFAULT_OPPORTUNITY_LIMITS.maxMessages),
    maxPartsPerMessage: positive(
      provided.maxPartsPerMessage,
      DEFAULT_OPPORTUNITY_LIMITS.maxPartsPerMessage,
    ),
    maxToolResultParts: positive(
      provided.maxToolResultParts,
      DEFAULT_OPPORTUNITY_LIMITS.maxToolResultParts,
    ),
    maxCharactersPerToolResult: positive(
      provided.maxCharactersPerToolResult,
      DEFAULT_OPPORTUNITY_LIMITS.maxCharactersPerToolResult,
    ),
    maxCharactersPerRequest: positive(
      provided.maxCharactersPerRequest,
      DEFAULT_OPPORTUNITY_LIMITS.maxCharactersPerRequest,
    ),
    minEligibleCharacters: positive(
      provided.minEligibleCharacters,
      DEFAULT_OPPORTUNITY_LIMITS.minEligibleCharacters,
    ),
  };
}

/** The payload's message list, or `undefined` when it has none. */
function messagesOf(context: Record<string, unknown>): readonly unknown[] | undefined {
  const messages = context['messages'];
  return Array.isArray(messages) ? messages : undefined;
}

/**
 * Locate the later, eligible copies of byte-identical tool results, in request order.
 *
 * The walk mirrors the M1 analyzer (same bounds, same identity rule, same payload-level exclusions)
 * and additionally records *where* each eligible occurrence is. Its result is never trusted on its
 * own: the caller compares its length against the analyzer's `eligibleOccurrences` and refuses the
 * whole request when they differ.
 */
function locateElidableDuplicates(
  context: Record<string, unknown>,
  limits: OpportunityLimits,
): readonly ElisionTarget[] {
  const messages = messagesOf(context);
  if (messages === undefined) {
    return [];
  }

  const targets: ElisionTarget[] = [];
  // identity -> exact text -> number of copies seen so far.
  const seen = new Map<string, Map<string, number>>();
  let charactersRead = 0;
  let toolResultParts = 0;
  let stop = false;

  const messageLimit = Math.min(messages.length, limits.maxMessages);
  for (let messageIndex = 0; messageIndex < messageLimit && !stop; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message)) {
      continue;
    }
    const content = Array.isArray(message['content']) ? message['content'] : [];
    const partLimit = Math.min(content.length, limits.maxPartsPerMessage);
    for (let partIndex = 0; partIndex < partLimit && !stop; partIndex += 1) {
      const part = content[partIndex];
      if (!isRecord(part)) {
        continue;
      }
      if (part['type'] !== 'tool-result') {
        continue;
      }
      toolResultParts += 1;
      if (toolResultParts > limits.maxToolResultParts) {
        stop = true;
        break;
      }

      let name: string;
      let value: string;
      let namespace: string;
      let providerExecuted: boolean;
      try {
        const rawName = part['name'];
        if (typeof rawName !== 'string' || rawName.trim().length === 0) {
          continue;
        }
        name = rawName;
        const result = part['result'];
        if (!isRecord(result)) {
          continue;
        }
        const resultType = result['type'];
        if (resultType !== 'text') {
          // Error results are never elided (E5); `json`/`content` results have a model-visible
          // rendering this hook cannot prove. Both are simply not candidates.
          continue;
        }
        const rawValue = result['value'];
        if (typeof rawValue !== 'string') {
          continue;
        }
        value = rawValue;
        if (value.length > limits.maxCharactersPerToolResult) {
          continue;
        }
        if (charactersRead + value.length > limits.maxCharactersPerRequest) {
          stop = true;
          break;
        }
        charactersRead += value.length;
        namespace = typeof part['namespace'] === 'string' ? part['namespace'] : '';
        providerExecuted = part['providerExecuted'] === true;
      } catch {
        // A throwing accessor makes this one part unreadable; it is skipped, not guessed at.
        continue;
      }

      const identity = `${name}\u0000${namespace}`;
      let byText = seen.get(identity);
      if (byText === undefined) {
        byText = new Map<string, number>();
        seen.set(identity, byText);
      }
      const copies = byText.get(value);
      if (copies === undefined) {
        byText.set(value, 1);
        continue;
      }
      byText.set(value, copies + 1);

      const eligible =
        namespace.length === 0 &&
        SAFE_MODE_TOOL_ALLOWLIST.includes(name) &&
        !providerExecuted &&
        value.length >= limits.minEligibleCharacters;
      if (!eligible) {
        continue;
      }
      targets.push({ messageIndex, partIndex, expectedText: value });
    }
  }

  return targets;
}

/**
 * Apply exact duplicate tool-result elision to one assembled request.
 *
 * Pure with respect to everything except the payload's own duplicate tool-result text: the only
 * writes are the planned `result.value` replacements, each re-verified immediately before it is made.
 * Returns a content-free outcome even when it refuses, so a caller can always record what happened.
 */
export function applySafeModeElision(
  context: unknown,
  options: SafeModeElisionOptions,
): SafeModeElisionOutcome {
  const refused = emptyElisionRefusals();
  const limits = resolveLimits(options.limits);
  const outcome = (
    fields: Partial<SafeModeElisionOutcome> & Pick<SafeModeElisionOutcome, 'attempted' | 'applied'>,
  ): SafeModeElisionOutcome => ({
    passId: SAFE_MODE_ELISION_PASS_ID,
    version: SAFE_MODE_ELISION_VERSION,
    requestKindBasis: options.requestKindBasis,
    elidedOccurrences: 0,
    elidedCharacters: 0,
    elidedBytes: 0,
    markerWrites: 0,
    markerBytes: 0,
    refused,
    notes: SAFE_MODE_ELISION_NOTES,
    ...fields,
  });

  if (options.enabled !== true) {
    refused.disabled += 1;
    return outcome({ attempted: false, applied: false });
  }

  if (options.requestKindBasis !== 'context-hook') {
    refused['request-kind-unverified'] += 1;
    return outcome({ attempted: false, applied: false });
  }

  if (!isAgentLoopContextPayload(context)) {
    refused['payload-not-agent-loop-shaped'] += 1;
    return outcome({ attempted: false, applied: false });
  }

  const payload = context as Record<string, unknown>;
  const analysis = analyseRequestOpportunities(payload, limits);
  if (analysis === undefined) {
    refused['not-request-shaped'] += 1;
    return outcome({ attempted: false, applied: false });
  }
  if (analysis.markerCollision) {
    refused['marker-collision'] += 1;
    return outcome({ attempted: true, applied: false });
  }
  if (analysis.bounded) {
    refused['scan-bounded'] += 1;
    return outcome({ attempted: true, applied: false });
  }
  if (analysis.eligibleOccurrences === 0) {
    return outcome({ attempted: true, applied: false });
  }

  const targets = locateElidableDuplicates(payload, limits);
  if (targets.length !== analysis.eligibleOccurrences) {
    // The analyzer and the locator disagree about this request. Nothing is written: an edit this
    // module cannot fully account for is exactly the edit it must not make.
    refused['plan-mismatch'] += 1;
    return outcome({ attempted: true, applied: false });
  }

  const messages = messagesOf(payload) ?? [];
  let elidedOccurrences = 0;
  let elidedCharacters = 0;
  let elidedBytes = 0;
  let markerWrites = 0;

  for (const target of targets) {
    const message = messages[target.messageIndex];
    const content = isRecord(message) && Array.isArray(message['content']) ? message['content'] : [];
    const part = content[target.partIndex];
    if (!isRecord(part)) {
      refused['assignment-guard-failed'] += 1;
      continue;
    }
    const result = part['result'];
    if (!isRecord(result) || result['value'] !== target.expectedText) {
      // Something else already changed this value (a second plugin instance, a concurrent pass, or a
      // host that rebuilt the part). Skipping is the only safe answer.
      refused['assignment-guard-failed'] += 1;
      continue;
    }

    try {
      result['value'] = SAFE_MODE_ELISION_MARKER;
    } catch {
      // A frozen or accessor-backed payload refuses the write instead of throwing into the host.
      refused['assignment-guard-failed'] += 1;
      continue;
    }

    elidedOccurrences += 1;
    elidedCharacters += target.expectedText.length;
    elidedBytes += utf8Length(target.expectedText);
    markerWrites += 1;
  }

  return outcome({
    attempted: true,
    applied: markerWrites > 0,
    elidedOccurrences,
    elidedCharacters,
    elidedBytes,
    markerWrites,
    markerBytes: markerWrites * utf8Length(SAFE_MODE_ELISION_MARKER),
  });
}

/** UTF-8 byte length of a string, without retaining a copy of it. */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
