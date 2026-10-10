import type {
  EvidenceClass,
  OptimizationDecision,
  OptimizationDecisionAction,
  OptimizationMode,
  OptimizationRequest,
  OptimizationResult,
  OptimizerPass,
  PassOutcome,
} from './types.js';

/** Options for constructing an {@link OptimizerEngine}. */
export interface OptimizerEngineOptions {
  /**
   * Optimizer passes, executed in registration order after the request has
   * passed the bypass check. Stage 1A ships no passes: until real passes
   * exist, the engine is a pure pass-through.
   */
  readonly passes?: readonly OptimizerPass[];
}

const ENGINE_PASS_ID = 'engine';

const EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  'none',
  'estimated',
  'measured',
  'benchmark-verified',
];

function isEvidenceClass(value: unknown): value is EvidenceClass {
  return typeof value === 'string' && (EVIDENCE_CLASSES as readonly string[]).includes(value);
}

function isValidOutcome(value: unknown): value is PassOutcome {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['context'] === 'string' &&
    typeof candidate['changed'] === 'boolean' &&
    typeof candidate['reason'] === 'string' &&
    isEvidenceClass(candidate['evidence'])
  );
}

function passIdOf(pass: OptimizerPass): string {
  return typeof pass.id === 'string' && pass.id.length > 0 ? pass.id : 'unknown-pass';
}

/**
 * Returns a safe description of a thrown value.
 *
 * Deliberately omits the error message: a poorly written pass could embed
 * context content or secrets in it, and those must never be surfaced.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return 'unknown error';
}

function decision(
  passId: string,
  action: OptimizationDecisionAction,
  reason: string,
  contextUnchanged: boolean,
  evidence: EvidenceClass,
): OptimizationDecision {
  return { passId, action, reason, contextUnchanged, evidence };
}

/**
 * Pass-through optimizer engine.
 *
 * Stage 1A behavior:
 * - With no registered passes (the only configuration shipped), it returns the
 *   original context exactly as received, preserves whitespace, Unicode, code
 *   and formatting, and records a structured pass-through decision.
 * - When the global bypass is enabled it skips every pass and records a
 *   `bypassed` decision.
 * - If a registered pass throws or returns an unusable outcome, the engine
 *   discards all partial work and returns the original request context.
 * - It never writes files, never logs context, and never reports token
 *   savings; decisions carry `evidence: 'none'`.
 */
export class OptimizerEngine {
  readonly #passes: readonly OptimizerPass[];

  constructor(options: OptimizerEngineOptions = {}) {
    this.#passes = options.passes ?? [];
  }

  /**
   * Run the optimizer pipeline for one request.
   *
   * @throws TypeError if `request.context` is not a string. That is an
   * adapter/programming error, not an optimization problem, so it fails
   * loudly instead of returning an untrustworthy result.
   */
  async optimize(request: OptimizationRequest): Promise<OptimizationResult> {
    if (typeof request.context !== 'string') {
      throw new TypeError('OptimizationRequest.context must be a string');
    }

    const mode: OptimizationMode = request.mode;

    if (!request.optimizationEnabled) {
      return {
        context: request.context,
        contextUnchanged: true,
        mode,
        bypassed: true,
        decisions: [
          decision(
            ENGINE_PASS_ID,
            'bypassed',
            'Optimization is disabled by the global bypass; the original context is returned unchanged.',
            true,
            'none',
          ),
        ],
      };
    }

    if (this.#passes.length === 0) {
      return {
        context: request.context,
        contextUnchanged: true,
        mode,
        bypassed: false,
        decisions: [
          decision(
            ENGINE_PASS_ID,
            'pass-through',
            'No optimizer passes are registered; the original context is returned unchanged.',
            true,
            'none',
          ),
        ],
      };
    }

    const decisions: OptimizationDecision[] = [];
    let current = request.context;

    for (const pass of this.#passes) {
      const passId = passIdOf(pass);

      let outcome: PassOutcome;
      try {
        outcome = await pass.run(current, request);
      } catch (error) {
        decisions.push(
          decision(
            passId,
            'failed',
            `Pass "${passId}" failed with ${describeError(error)}; the original context was returned unchanged.`,
            true,
            'none',
          ),
        );
        return {
          context: request.context,
          contextUnchanged: true,
          mode,
          bypassed: false,
          decisions,
        };
      }

      if (!isValidOutcome(outcome)) {
        decisions.push(
          decision(
            passId,
            'failed',
            `Pass "${passId}" returned an unusable outcome; the original context was returned unchanged.`,
            true,
            'none',
          ),
        );
        return {
          context: request.context,
          contextUnchanged: true,
          mode,
          bypassed: false,
          decisions,
        };
      }

      if (outcome.changed && outcome.context !== current) {
        current = outcome.context;
        decisions.push(
          decision(
            passId,
            'applied',
            outcome.reason.length > 0 ? outcome.reason : `Pass "${passId}" changed the context.`,
            false,
            outcome.evidence,
          ),
        );
      } else if (outcome.changed) {
        decisions.push(
          decision(
            passId,
            'pass-through',
            `Pass "${passId}" reported a change but returned identical content; treated as unchanged.`,
            true,
            outcome.evidence,
          ),
        );
      } else {
        decisions.push(
          decision(
            passId,
            'pass-through',
            outcome.reason.length > 0 ? outcome.reason : `Pass "${passId}" left the context unchanged.`,
            true,
            outcome.evidence,
          ),
        );
      }
    }

    return {
      context: current,
      contextUnchanged: current === request.context,
      mode,
      bypassed: false,
      decisions,
    };
  }
}
