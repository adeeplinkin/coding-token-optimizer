/**
 * Shared optimizer contracts for Dr. Token.
 *
 * These types define the boundary between the shared engine and future
 * coding-harness adapters (OpenCode, Codex, Freebuff).
 *
 * Stage 1A status: contracts and a pass-through engine only. No optimization
 * pass exists yet, no token savings are produced, and none may be claimed.
 */

/**
 * Optimization mode identifiers.
 *
 * All three modes are identifiers only at this stage: the engine echoes the
 * requested mode but none of them change behavior yet.
 *
 * Development and benchmarking order: `safe` first, then `aggressive`, then
 * `balanced`.
 */
export type OptimizationMode = 'safe' | 'aggressive' | 'balanced';

/**
 * Evidence classification for an optimization decision.
 *
 * - `none` — nothing was measured; no savings claim is possible.
 * - `estimated` — a heuristic estimate that was not verified by measurement.
 * - `measured` — tokens were counted from actual harness input and output.
 * - `benchmark-verified` — measured under a controlled benchmark comparison.
 *
 * Stage 1A always uses `none`. Savings must never be presented as measured
 * unless they actually were.
 */
export type EvidenceClass = 'none' | 'estimated' | 'measured' | 'benchmark-verified';

/**
 * A single request to the optimizer.
 */
export interface OptimizationRequest {
  /**
   * The exact original context as received from the coding harness. The
   * engine preserves it character-for-character and never logs it.
   */
  readonly context: string;
  /** Requested optimization mode (identifier only in Stage 1A). */
  readonly mode: OptimizationMode;
  /**
   * Global bypass setting. Set to `false` to disable optimization: the
   * original context is then returned unchanged and no pass runs.
   */
  readonly optimizationEnabled: boolean;
}

/** What a single decision step did. */
export type OptimizationDecisionAction =
  /** Optimization was skipped because the global bypass is enabled. */
  | 'bypassed'
  /** The input was accepted and returned unchanged. */
  | 'pass-through'
  /** A pass returned a different context and the engine adopted it. */
  | 'applied'
  /** A pass failed or returned an unusable result; the original context was restored. */
  | 'failed';

/**
 * A structured record of what happened while processing a request.
 *
 * `reason` must be a short, static explanation and must never embed raw
 * context, prompts, secrets, or source code.
 */
export interface OptimizationDecision {
  /** Identifier of the pass that produced the decision, or `engine`. */
  readonly passId: string;
  readonly action: OptimizationDecisionAction;
  /** Short human-readable explanation. Never contains request content. */
  readonly reason: string;
  /** Whether the context was left identical to its step input. */
  readonly contextUnchanged: boolean;
  /** Evidence classification; `none` until real measurement exists. */
  readonly evidence: EvidenceClass;
}

/**
 * The result the optimizer hands back to a harness adapter.
 */
export interface OptimizationResult {
  /**
   * The context the harness should use. For pass-through, bypass, and failure
   * fallback this is exactly `request.context`.
   */
  readonly context: string;
  /** True when `context` is exactly the original request context. */
  readonly contextUnchanged: boolean;
  /** The mode that was requested. */
  readonly mode: OptimizationMode;
  /** True when the global bypass flag disabled optimization. */
  readonly bypassed: boolean;
  /** Ordered record of engine and pass decisions. */
  readonly decisions: readonly OptimizationDecision[];
}

/**
 * What an optimizer pass returns for one run.
 */
export interface PassOutcome {
  /** The context after this pass (may be identical to the input). */
  readonly context: string;
  /** True only when the pass deliberately produced a different context. */
  readonly changed: boolean;
  /** Short reason; must not embed context content. */
  readonly reason: string;
  /** Evidence class that applies to anything this pass claims. */
  readonly evidence: EvidenceClass;
}

/**
 * A single, independently testable optimization step.
 *
 * Passes run in registration order. A pass must return the input context
 * unchanged whenever it cannot safely improve the context, and must never
 * discard instructions, source code, errors, or other context. Passes never
 * touch the filesystem: the optimizer only transforms the context it is
 * given, in memory.
 */
export interface OptimizerPass {
  /** Stable identifier used in decisions. */
  readonly id: string;
  /** Short description of what the pass does. */
  readonly description: string;
  /** Run the pass on the current context. */
  run(context: string, request: OptimizationRequest): PassOutcome | Promise<PassOutcome>;
}
