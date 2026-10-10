import { createHash } from 'node:crypto';
import { OptimizerEngine } from '@dr-token/core';
import type { OptimizationMode, OptimizationRequest, OptimizationResult } from '@dr-token/core';
import type {
  BenchmarkFixture,
  BenchmarkProvenance,
  BenchmarkRunRecord,
  BenchmarkRunRole,
  CorrectnessCheck,
  CorrectnessOutcome,
  OptimizationDecisionSummary,
  RunMetrics,
} from './types.js';
import {
  HARNESS_METRIC_UNAVAILABLE_NOTE,
  TOKENS_UNAVAILABLE_NOTE,
  measured,
  summarizeMetricEvidence,
  unavailable,
} from './measurement.js';
import { DR_TOKEN_CORE_VERSION, SYNTHETIC_HARNESS_ID, createProvenance } from './provenance.js';

/**
 * The minimal contract the benchmark runner needs from an optimizer.
 *
 * `OptimizerEngine` from `@dr-token/core` satisfies this. The runner accepts it
 * structurally so alternative or deliberately failing optimizers can be
 * injected in tests without changing the runner.
 */
export interface ContextOptimizer {
  optimize(request: OptimizationRequest): Promise<OptimizationResult>;
}

/** Options controlling one recorded run. */
export interface BenchmarkRunOptions {
  readonly role: BenchmarkRunRole;
  readonly mode: OptimizationMode;
  /** Optimizer to exercise. Defaults to a pass-through `OptimizerEngine`. */
  readonly optimizer?: ContextOptimizer;
  /** Short description of the optimizer configuration used for this run. */
  readonly optimizerConfiguration?: string;
  readonly harness?: string;
  readonly model?: string;
  readonly optimizerRevision?: string;
  readonly repositoryRevision?: string;
  /** Injectable clock, used so report timestamps can be fixed in tests. */
  readonly now?: () => Date;
}

/**
 * Name used when no optimization pass is configured.
 *
 * Stage 1B ships no passes, so baseline and candidate runs share this
 * configuration and the engine behaves as a pass-through.
 */
export const DEFAULT_OPTIMIZER_CONFIGURATION = 'pass-through';

/**
 * Run one fixture through the optimizer and record everything needed to judge
 * the result later.
 *
 * The run never stores fixture content: only hashes, lengths, labels, decision
 * actions and measurements are recorded.
 */
export async function runFixture(
  fixture: BenchmarkFixture,
  options: BenchmarkRunOptions,
): Promise<BenchmarkRunRecord> {
  const optimizer = options.optimizer ?? new OptimizerEngine();
  const optimizerConfiguration = options.optimizerConfiguration ?? DEFAULT_OPTIMIZER_CONFIGURATION;
  const optimizerRevision = options.optimizerRevision ?? DR_TOKEN_CORE_VERSION;
  const harness = options.harness ?? SYNTHETIC_HARNESS_ID;
  const clock = options.now ?? ((): Date => new Date());

  const startedAt = performance.now();
  let result: OptimizationResult | undefined;
  let optimizerFailure: string | undefined;

  try {
    result = await optimizer.optimize({
      context: fixture.context,
      mode: options.mode,
      optimizationEnabled: true,
    });
  } catch (error) {
    optimizerFailure = `The optimizer threw ${errorName(error)}; the original context was used as a fallback.`;
  }
  const durationMs = performance.now() - startedAt;

  if (result !== undefined && typeof result.context !== 'string') {
    optimizerFailure =
      'The optimizer returned a non-string context; the original context was used as a fallback.';
    result = undefined;
  }

  const output = result === undefined ? fixture.context : result.context;
  const decisions = result === undefined ? [] : result.decisions;
  const failedDecisions = decisions.filter((decision) => decision.action === 'failed');
  const optimizerErrors = failedDecisions.length + (optimizerFailure === undefined ? 0 : 1);

  const metrics: RunMetrics = {
    // Real harness token usage does not exist for synthetic fixtures, so these
    // stay unavailable instead of being estimated.
    inputTokens: unavailable(TOKENS_UNAVAILABLE_NOTE),
    outputTokens: unavailable(TOKENS_UNAVAILABLE_NOTE),
    totalTokens: unavailable(TOKENS_UNAVAILABLE_NOTE),
    toolCalls: unavailable(HARNESS_METRIC_UNAVAILABLE_NOTE),
    repeatedFileReads: unavailable(HARNESS_METRIC_UNAVAILABLE_NOTE),
    // Wall-clock duration is a real observation, but it varies between runs.
    durationMs: measured(durationMs),
    // Every optimizer error causes the engine to fall back to the original
    // context, so recovery attempts match the error count.
    recoveryAttempts: measured(optimizerErrors),
    optimizerErrors: measured(optimizerErrors),
  };

  const checks: CorrectnessCheck[] = [];
  checks.push({
    name: 'engine-completed',
    passed: optimizerFailure === undefined,
    detail: optimizerFailure ?? 'The optimizer returned a result.',
  });

  const preservedExactly = output === fixture.context;
  if (fixture.expectExactPreservation) {
    checks.push({
      name: 'context-preserved-exactly',
      passed: preservedExactly,
      detail: preservedExactly
        ? 'The output context is identical to the input context.'
        : 'The output context differs from the input context.',
    });
  }

  for (const required of fixture.requiredContent) {
    const present = output.includes(required.text);
    checks.push({
      name: `required-content:${required.label}`,
      passed: present,
      detail: present
        ? `Required content "${required.label}" is present.`
        : `Required content "${required.label}" is missing.`,
    });
  }

  if (result !== undefined) {
    const flagConsistent = result.contextUnchanged === preservedExactly;
    checks.push({
      name: 'unchanged-flag-consistent',
      passed: flagConsistent,
      detail: flagConsistent
        ? 'The result contextUnchanged flag matches the observed output.'
        : 'The result contextUnchanged flag contradicts the observed output.',
    });
  }

  const correctness: CorrectnessOutcome = {
    passed: checks.every((check) => check.passed),
    checks,
  };

  const optimizerDecisions: readonly OptimizationDecisionSummary[] = decisions.map((decision) => ({
    passId: decision.passId,
    action: decision.action,
    evidence: decision.evidence,
  }));

  const provenance: BenchmarkProvenance = createProvenance({
    fixtureId: fixture.id,
    role: options.role,
    mode: options.mode,
    harness,
    optimizerRevision,
    optimizerConfiguration,
    recordedAt: clock(),
    measurementEvidence: summarizeMetricEvidence(metrics),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.repositoryRevision === undefined
      ? {}
      : { repositoryRevision: options.repositoryRevision }),
  });

  return {
    runId: `${fixture.id}:${options.role}`,
    role: options.role,
    fixtureId: fixture.id,
    fixtureCategory: fixture.category,
    inputHash: hashContext(fixture.context),
    outputHash: hashContext(output),
    inputLength: fixture.context.length,
    outputLength: output.length,
    contextPreservedExactly: preservedExactly,
    correctness,
    metrics,
    provenance,
    optimizerDecisions,
  };
}

/** SHA-256 of a context string, used so reports never need the content itself. */
export function hashContext(context: string): string {
  return createHash('sha256').update(context, 'utf8').digest('hex');
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : 'an unknown error';
}
