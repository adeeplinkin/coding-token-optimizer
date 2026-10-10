/**
 * Safe Mode **M1 opportunity analyzer** — observation only.
 *
 * This module answers one measurement question about an assembled OpenCode
 * request: how often does it contain *exact duplicate* tool-result content that
 * the Stage 1O Safe Mode strategy could elide, and how large are those
 * duplicates? It is the measurement half of
 * [docs/SAFE_MODE_DESIGN.md](../../../docs/SAFE_MODE_DESIGN.md) §11's M1
 * milestone and it never transforms anything.
 *
 * ## Equivalence, stated for the analyzer
 *
 * A duplicate is counted only when two tool-result parts **of the same tool**
 * carry the **exact same string** — direct string equality, never a hash
 * comparison and never a similarity score — and the earlier copy is therefore
 * still present in the same request *by construction* (the analyzer removes
 * nothing). That is the whole safety argument: detecting a duplicate never
 * depends on a cache, on ordering between requests, or on any state that could
 * go stale.
 *
 * ## Eligibility, and what this hook cannot see
 *
 * An occurrence (the later copy of a detected duplicate) is **eligible** when
 * every condition the design lists that is *observable on the request payload*
 * holds: same tool and on the read-only allowlist (E2), byte-identical text
 * (E3), earlier copy present (E4), a non-error result (E5), at or above the
 * minimum size (E6), the marker prefix absent anywhere examined (E7), and the
 * whole scan inside its work budget (E9). E1 is the integration's capability
 * check, not an analyzer rule.
 *
 * **E8 is not observable here.** The published `SessionContext` that
 * `session.hook("context")` delivers carries no `kind` member (the runtime
 * exposes the request kind on the model-call hook instead), so a request cannot
 * prove itself `primary` at this point. Eligibility recorded by this module is
 * therefore *content-level*: it says "this duplicate passes every check the
 * assembled payload can prove". The primary-only gate stays an apply-time
 * requirement and the summary says so in its notes — the analyzer never assumes
 * a value it cannot read.
 *
 * "Eligible" is **not** a savings claim: candidate characters/bytes describe the
 * request, and tokens are never derived from them.
 *
 * ## Privacy, bounds and failure posture
 *
 * - The return value contains counts only. No tool text, path, digest of
 *   content, session id or prompt fragment leaves this module, and nothing is
 *   retained after it returns.
 * - Every scan is bounded by {@link OpportunityLimits}: messages, parts per
 *   message, tool-result parts, characters per result and total characters read
 *   per request. A bound stops work and marks the analysis `bounded`; it never
 *   grows.
 * - Read-only, and fail-open at the edges: a payload that is not request-shaped
 *   returns `undefined` (the caller records that honestly instead of inventing
 *   an all-zero reading), a part whose payload cannot be read exactly is
 *   *excluded* rather than guessed at, and a throwing accessor inside one part
 *   excludes that part without losing the request.
 */

/** Tool ids whose repeated results the v1 strategy may elide (design E2). */
export const SAFE_MODE_TOOL_ALLOWLIST: readonly string[] = ['read'];

/**
 * Marker prefix that disqualifies a whole request when any examined part
 * already contains it (design E7).
 *
 * Matches the first segment of the design's versioned marker text; the analyzer
 * only ever *checks* for it.
 */
export const SAFE_MODE_MARKER_PREFIX = 'dr-token/safe-mode/';

/**
 * Bounds on one request analysis.
 *
 * The defaults are deliberately generous for real work (a long session's
 * assembled request is tens of thousands of characters) and strict enough that a
 * pathological request cannot make the analyzer grow without limit.
 */
export interface OpportunityLimits {
  /** Messages examined per request. */
  readonly maxMessages: number;
  /** Content parts examined per message. */
  readonly maxPartsPerMessage: number;
  /** Tool-result parts examined per request. */
  readonly maxToolResultParts: number;
  /**
   * Characters a single tool-result text may hold and still be compared.
   *
   * A larger payload is **excluded** (`payload-too-large`), never truncated:
   * two truncated strings could compare equal while the full texts differ, so
   * truncation would manufacture false equivalence.
   */
  readonly maxCharactersPerToolResult: number;
  /** Total characters read per request, across every scanned part. */
  readonly maxCharactersPerRequest: number;
  /**
   * Minimum length for an occurrence to be eligible (design E6,
   * `minElidableChars`).
   *
   * Shorter duplicates are still *detected* and counted as ineligible.
   */
  readonly minEligibleCharacters: number;
}

/** Default bounds. See {@link OpportunityLimits} for the reasoning. */
export const DEFAULT_OPPORTUNITY_LIMITS: OpportunityLimits = {
  maxMessages: 4_000,
  maxPartsPerMessage: 500,
  maxToolResultParts: 500,
  maxCharactersPerToolResult: 1_000_000,
  maxCharactersPerRequest: 4_000_000,
  minEligibleCharacters: 400,
};

/**
 * Why a tool-result part could not take part in duplicate detection.
 *
 * Every reason is a *part-level* exclusion: the part is never compared, so it
 * can be neither a retained original nor an elidable duplicate. Stable and
 * content-free.
 */
export const OPPORTUNITY_PART_EXCLUSION_REASONS = [
  /** The part carried no usable tool identity (`name` missing or empty). */
  'tool-identity-missing',
  /** The result payload was absent or shaped in a way this analyzer cannot read exactly. */
  'result-malformed',
  /** The result is an error (`result.type === "error"`); errors are never elided (E5). */
  'result-error',
  /** The result type's model-visible text cannot be proven (`json`, `content`) — see the module note. */
  'result-type-unsupported',
  /** The text exceeded {@link OpportunityLimits.maxCharactersPerToolResult}; truncation would fake equality. */
  'payload-too-large',
  /** A processing bound was reached before this part could be examined. */
  'scan-bounded',
] as const;

export type OpportunityPartExclusionReason = (typeof OPPORTUNITY_PART_EXCLUSION_REASONS)[number];

/**
 * Why a detected duplicate occurrence is not eligible for the v1 elision.
 *
 * Only later copies of a detected duplicate carry one of these; the first copy
 * is never refused because it is always the one that would stay.
 */
export const OPPORTUNITY_OCCURRENCE_REFUSAL_REASONS = [
  /** The tool is not on the read-only allowlist, or the part declares a namespace (never the built-in `read`). */
  'tool-not-allowlisted',
  /** The part is provider-executed, so its result may carry provider-side state. */
  'provider-executed',
  /** Below the minimum eligible size (E6); still detected as a duplicate. */
  'below-minimum-characters',
  /** Some examined part already contained the marker prefix (E7); the whole request refuses. */
  'marker-collision',
  /** The scan hit a processing bound (E9); a bounded request refuses (fail-closed about eliding). */
  'scan-bounded',
] as const;

export type OpportunityOccurrenceRefusalReason =
  (typeof OPPORTUNITY_OCCURRENCE_REFUSAL_REASONS)[number];

/** All-zero part-exclusion counters, with every reason present. */
export function emptyPartExclusionCounts(): Record<OpportunityPartExclusionReason, number> {
  return {
    'tool-identity-missing': 0,
    'result-malformed': 0,
    'result-error': 0,
    'result-type-unsupported': 0,
    'payload-too-large': 0,
    'scan-bounded': 0,
  };
}

/** All-zero occurrence-refusal counters, with every reason present. */
export function emptyOccurrenceRefusalCounts(): Record<OpportunityOccurrenceRefusalReason, number> {
  return {
    'tool-not-allowlisted': 0,
    'provider-executed': 0,
    'below-minimum-characters': 0,
    'marker-collision': 0,
    'scan-bounded': 0,
  };
}

/**
 * Content-free result of analysing one assembled request.
 *
 * Invariants a reader can rely on (and that tests assert):
 *
 * - `duplicateOccurrences` equals `eligibleOccurrences` plus the sum of
 *   {@link refusedOccurrences}: every detected occurrence is either eligible or
 *   refused with exactly one reason.
 * - `eligibleOccurrences` counts later copies that pass every payload-visible
 *   condition (and is zero when `markerCollision` or `bounded` is set).
 * - `candidateCharacters` / `candidateBytes` are sums over eligible occurrences
 *   only, and are properties of the request — never "saved" tokens.
 */
export interface RequestOpportunityAnalysis {
  /** Messages walked (a message that is not an object still counts as walked). */
  readonly messagesExamined: number;
  /** Parts walked: message content parts plus system parts. */
  readonly partsExamined: number;
  /** Tool-result parts encountered. */
  readonly toolResultParts: number;
  /** Tool-result parts whose exact text was read and could participate in comparison. */
  readonly comparedToolResultParts: number;
  /** Groups of two or more compared parts with byte-identical text for the same tool. */
  readonly duplicateGroups: number;
  /** Later copies in those groups (`sum(count - 1)`): the detected duplicate occurrences. */
  readonly duplicateOccurrences: number;
  /** Detected groups with at least one eligible occurrence. */
  readonly eligibleGroups: number;
  /** Occurrences eligible for the v1 elision, if (and only if) every payload-visible rule held. */
  readonly eligibleOccurrences: number;
  /**
   * Sum of ALL detected occurrences' string lengths (UTF-16 code units).
   *
   * This is the size of the duplicate content actually observed, including
   * occurrences refused for a content rule (for example below the minimum size
   * or a non-allowlisted tool) — the measurement half of M1.
   */
  readonly duplicateCharacters: number;
  /** Sum of ALL detected occurrences' UTF-8 byte lengths. */
  readonly duplicateBytes: number;
  /** Sum of the *eligible* occurrences' string lengths: the would-elide candidates. */
  readonly candidateCharacters: number;
  /** Sum of the eligible occurrences' UTF-8 byte lengths. */
  readonly candidateBytes: number;
  /** Parts excluded from comparison, by reason. */
  readonly excludedParts: Readonly<Record<OpportunityPartExclusionReason, number>>;
  /** Detected occurrences refused, by reason. */
  readonly refusedOccurrences: Readonly<Record<OpportunityOccurrenceRefusalReason, number>>;
  /** Some examined part already contained the Safe Mode marker prefix (E7). */
  readonly markerCollision: boolean;
  /** The scan hit a processing bound; counts are complete only up to the bound (E9). */
  readonly bounded: boolean;
}

/** One duplicate group's mutable accounting. */
interface GroupState {
  readonly text: string;
  readonly length: number;
  occurrences: number;
  contentEligible: number;
  readonly refusals: Record<OpportunityOccurrenceRefusalReason, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUsableName(value: unknown): string | undefined {
  // A whitespace-only name is not an identity; the raw string is returned so a
  // name with meaningful surrounding whitespace still groups exactly.
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

/** Read the scanable text of a system part or a `text`/`reasoning` content part. */
function readPartText(part: unknown): string | undefined {
  if (typeof part === 'string') {
    return part;
  }
  if (!isRecord(part)) {
    return undefined;
  }
  const text = part['text'];
  return typeof text === 'string' ? text : undefined;
}

/**
 * Analyse one assembled request for exact duplicate tool-result opportunities.
 *
 * Pure, synchronous, read-only and deterministic: the same payload always yields
 * the same counts, and the input is never assigned to, reordered or retained.
 * Returns `undefined` when the payload is not request-shaped (not an object, or
 * an object with neither a `messages` nor a `system` array) so the caller can
 * record an unanalysable request instead of a fabricated empty one.
 */
export function analyseRequestOpportunities(
  context: unknown,
  limits: OpportunityLimits = DEFAULT_OPPORTUNITY_LIMITS,
): RequestOpportunityAnalysis | undefined {
  if (!isRecord(context)) {
    return undefined;
  }
  const messages = Array.isArray(context['messages']) ? context['messages'] : undefined;
  const system = Array.isArray(context['system']) ? context['system'] : undefined;
  // Not request-shaped: neither member is an array, so there is nothing that
  // could be analysed — report that instead of an all-zero reading.
  if (messages === undefined && system === undefined) {
    return undefined;
  }

  const excludedParts = emptyPartExclusionCounts();
  const refusedOccurrences = emptyOccurrenceRefusalCounts();

  let messagesExamined = 0;
  let partsExamined = 0;
  let toolResultParts = 0;
  let comparedToolResultParts = 0;
  let markerCollision = false;
  let bounded = false;
  let charactersRead = 0;
  let stop = false;

  // Identity -> (exact text -> group). The text itself is the inner key, so
  // equality is JavaScript string equality on the original value, with no
  // concatenated copy and no hash in the comparison path.
  const groups = new Map<string, Map<string, GroupState>>();

  const budgetAllows = (length: number): boolean =>
    charactersRead + length <= limits.maxCharactersPerRequest;

  /** Scan one already-budgeted string for the marker prefix (E7). */
  const noteMarker = (text: string): void => {
    if (text.includes(SAFE_MODE_MARKER_PREFIX)) {
      markerCollision = true;
    }
  };

  /** Record one tool-result part into the duplicate groups. */
  const handleToolResult = (part: Record<string, unknown>): void => {
    const name = readUsableName(part['name']);
    if (name === undefined) {
      excludedParts['tool-identity-missing'] += 1;
      return;
    }

    const result = isRecord(part['result']) ? part['result'] : undefined;
    if (result === undefined) {
      excludedParts['result-malformed'] += 1;
      return;
    }
    const resultType = result['type'];
    if (resultType === 'error') {
      excludedParts['result-error'] += 1;
      return;
    }
    if (resultType !== 'text') {
      // `json` and `content` results are contract-supported, but their
      // model-visible rendering is decided by the host's serialization, which
      // this hook cannot read — so their exact text cannot be proven and they
      // are never compared. Anything else is malformed.
      if (resultType === 'json' || resultType === 'content') {
        excludedParts['result-type-unsupported'] += 1;
      } else {
        excludedParts['result-malformed'] += 1;
      }
      return;
    }

    const value = result['value'];
    if (typeof value !== 'string') {
      excludedParts['result-malformed'] += 1;
      return;
    }
    if (value.length > limits.maxCharactersPerToolResult) {
      excludedParts['payload-too-large'] += 1;
      return;
    }
    if (!budgetAllows(value.length)) {
      excludedParts['scan-bounded'] += 1;
      bounded = true;
      stop = true;
      return;
    }
    charactersRead += value.length;
    comparedToolResultParts += 1;
    noteMarker(value);

    const namespace = typeof part['namespace'] === 'string' ? part['namespace'] : '';
    // Identity includes the tool name *and* namespace: identical text from a
    // different tool is not the same content and must never group.
    const identity = `${name}\u0000${namespace}`;
    let byText = groups.get(identity);
    if (byText === undefined) {
      byText = new Map();
      groups.set(identity, byText);
    }
    const existing = byText.get(value);
    if (existing === undefined) {
      byText.set(value, {
        text: value,
        length: value.length,
        occurrences: 0,
        contentEligible: 0,
        refusals: emptyOccurrenceRefusalCounts(),
      });
      return;
    }

    existing.occurrences += 1;
    if (namespace.length > 0 || !SAFE_MODE_TOOL_ALLOWLIST.includes(name)) {
      existing.refusals['tool-not-allowlisted'] += 1;
      return;
    }
    if (part['providerExecuted'] === true) {
      existing.refusals['provider-executed'] += 1;
      return;
    }
    if (value.length < limits.minEligibleCharacters) {
      existing.refusals['below-minimum-characters'] += 1;
      return;
    }
    existing.contentEligible += 1;
  };

  // System parts are scanned for the marker prefix (E7 covers the whole
  // request); they can never hold a tool result.
  if (system !== undefined && !stop) {
    const systemLimit = Math.min(system.length, limits.maxPartsPerMessage);
    if (system.length > systemLimit) {
      bounded = true;
    }
    for (let index = 0; index < systemLimit && !stop; index += 1) {
      partsExamined += 1;
      const text = readPartText(system[index]);
      if (text === undefined) {
        continue;
      }
      if (!budgetAllows(text.length)) {
        bounded = true;
        stop = true;
        break;
      }
      charactersRead += text.length;
      noteMarker(text);
    }
  }

  if (messages !== undefined && !stop) {
    const messageLimit = Math.min(messages.length, limits.maxMessages);
    if (messages.length > messageLimit) {
      bounded = true;
    }
    for (let messageIndex = 0; messageIndex < messageLimit && !stop; messageIndex += 1) {
      messagesExamined += 1;
      const message = messages[messageIndex];
      if (!isRecord(message)) {
        continue;
      }
      const content = Array.isArray(message['content']) ? message['content'] : [];
      const partLimit = Math.min(content.length, limits.maxPartsPerMessage);
      if (content.length > partLimit) {
        bounded = true;
      }
      for (let partIndex = 0; partIndex < partLimit && !stop; partIndex += 1) {
        partsExamined += 1;
        const part = content[partIndex];
        if (!isRecord(part)) {
          continue;
        }
        const type = typeof part['type'] === 'string' ? part['type'] : undefined;
        if (type === 'tool-result') {
          toolResultParts += 1;
          if (toolResultParts > limits.maxToolResultParts) {
            bounded = true;
            stop = true;
            break;
          }
          try {
            handleToolResult(part);
          } catch {
            // One unreadable part (for example a throwing accessor) excludes
            // itself; it must not lose the rest of the request.
            excludedParts['result-malformed'] += 1;
          }
          continue;
        }
        if (type === 'text' || type === 'reasoning') {
          const text = readPartText(part);
          if (text === undefined) {
            continue;
          }
          if (!budgetAllows(text.length)) {
            bounded = true;
            stop = true;
            break;
          }
          charactersRead += text.length;
          noteMarker(text);
        }
      }
    }
  }

  let duplicateGroups = 0;
  let duplicateOccurrences = 0;
  let eligibleGroups = 0;
  let eligibleOccurrences = 0;
  let duplicateCharacters = 0;
  let duplicateBytes = 0;
  let candidateCharacters = 0;
  let candidateBytes = 0;
  let encoder: TextEncoder | undefined;

  for (const byText of groups.values()) {
    for (const group of byText.values()) {
      if (group.occurrences === 0) {
        continue;
      }
      duplicateGroups += 1;
      duplicateOccurrences += group.occurrences;
      for (const reason of OPPORTUNITY_OCCURRENCE_REFUSAL_REASONS) {
        refusedOccurrences[reason] += group.refusals[reason];
      }

      // Bytes are encoded once per detected group; the text itself is already
      // held as the group key, so this adds no copy of the content.
      encoder ??= new TextEncoder();
      const groupBytes = encoder.encode(group.text).length;
      duplicateCharacters += group.length * group.occurrences;
      duplicateBytes += groupBytes * group.occurrences;

      // Request-level gates are applied after the walk, because a marker or a
      // bound discovered later in the request still refuses every elision in it
      // (fail-closed about transforming).
      let eligible = group.contentEligible;
      if (markerCollision) {
        refusedOccurrences['marker-collision'] += eligible;
        eligible = 0;
      } else if (bounded) {
        refusedOccurrences['scan-bounded'] += eligible;
        eligible = 0;
      }
      if (eligible === 0) {
        continue;
      }
      eligibleGroups += 1;
      eligibleOccurrences += eligible;
      candidateCharacters += group.length * eligible;
      candidateBytes += groupBytes * eligible;
    }
  }

  return {
    messagesExamined,
    partsExamined,
    toolResultParts,
    comparedToolResultParts,
    duplicateGroups,
    duplicateOccurrences,
    eligibleGroups,
    eligibleOccurrences,
    duplicateCharacters,
    duplicateBytes,
    candidateCharacters,
    candidateBytes,
    excludedParts,
    refusedOccurrences,
    markerCollision,
    bounded,
  };
}
