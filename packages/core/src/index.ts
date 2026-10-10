/**
 * Public API of the Dr. Token shared optimizer core.
 *
 * Stage 1A: typed contracts plus a pass-through engine. No optimization pass
 * is implemented and no token savings are produced or claimed.
 */
export { OptimizerEngine } from './engine.js';
export type { OptimizerEngineOptions } from './engine.js';
export type {
  EvidenceClass,
  OptimizationDecision,
  OptimizationDecisionAction,
  OptimizationMode,
  OptimizationRequest,
  OptimizationResult,
  OptimizerPass,
  PassOutcome,
} from './types.js';
