/**
 * Declared controlled comparisons (Stage 1S).
 *
 * The benchmark framework refuses to compare runs whose recorded optimizer
 * configuration differs, because two different configurations are normally two
 * different experiments. A Safe Mode A/B measurement needs exactly the opposite:
 * one arm with the optimization disabled and one with it enabled.
 *
 * The fix is to *declare* the experiment rather than weaken the guard. A
 * declaration names the permitted optimization difference (the axis) and both
 * arms; everything else must still be identical. The recorded provenance of both
 * runs is re-verified in `compareRuns`, so a declaration can never make
 * incomparable runs comparable — it can only make the one declared difference
 * permitted.
 *
 * This module contains no optimization logic and produces no token estimate.
 */
import type {
  BenchmarkRunRole,
  DeclaredVariant,
  DeclaredVariantArm,
  OptimizationVariantAxis,
  VariantProvenance,
} from './types.js';

/** Optimization axes a declared variant may move. Only one exists today. */
export const OPTIMIZATION_VARIANT_AXES: readonly OptimizationVariantAxis[] = [
  'optimizer-configuration',
];

const DECLARATION_KEYS: readonly string[] = ['declarationId', 'axis', 'control', 'treatment'];
const ARM_KEYS: readonly string[] = ['variantId', 'role', 'optimizerConfiguration'];
const ROLES: readonly BenchmarkRunRole[] = ['baseline', 'candidate'];

/** Raised when declared variant metadata is missing, malformed or inconsistent. */
export class InvalidVariantDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVariantDeclarationError';
  }
}

/**
 * Validate a variant declaration, including values that did not come from
 * TypeScript (for example JSON read from disk).
 *
 * Every rejection names the offending field. Declarations hold configuration
 * labels only, never fixture content, so echoing a label is safe and makes the
 * failure diagnosable.
 */
export function validateVariantDeclaration(value: unknown): DeclaredVariant {
  const record = requireObject('The variant declaration', value);
  rejectUnknownKeys('The variant declaration', record, DECLARATION_KEYS);
  for (const key of DECLARATION_KEYS) {
    if (!(key in record)) {
      throw new InvalidVariantDeclarationError(
        `The variant declaration is missing the "${key}" field.`,
      );
    }
  }

  const declarationId = requireLabel('declarationId', record['declarationId']);
  const axis = requireAxis(record['axis']);
  const control = validateArm('control', record['control']);
  const treatment = validateArm('treatment', record['treatment']);

  if (control.role !== 'baseline') {
    throw new InvalidVariantDeclarationError(
      `The declared control arm must be recorded as the baseline; it declares role "${control.role}".`,
    );
  }
  if (treatment.role !== 'candidate') {
    throw new InvalidVariantDeclarationError(
      `The declared treatment arm must be recorded as the candidate; it declares role "${treatment.role}".`,
    );
  }
  if (control.variantId === treatment.variantId) {
    throw new InvalidVariantDeclarationError(
      `The declared arms must use different variant identifiers; both declare "${control.variantId}".`,
    );
  }
  if (control.optimizerConfiguration === treatment.optimizerConfiguration) {
    throw new InvalidVariantDeclarationError(
      `The declared arms must record different optimizer configurations; a controlled comparison requires exactly one permitted optimization difference.`,
    );
  }

  return { declarationId, axis, control, treatment };
}

/** Provenance to record for one arm of a validated declaration. */
export function variantProvenanceFor(
  declaration: DeclaredVariant,
  role: BenchmarkRunRole,
): VariantProvenance {
  const arm = role === 'baseline' ? declaration.control : declaration.treatment;
  return {
    declarationId: declaration.declarationId,
    variantId: arm.variantId,
    axis: declaration.axis,
    role,
  };
}

/**
 * The declared arm for a run role. Both roles always have exactly one arm,
 * because validation pins the control arm to `baseline` and the treatment arm
 * to `candidate`.
 */
export function variantArmFor(
  declaration: DeclaredVariant,
  role: BenchmarkRunRole,
): DeclaredVariantArm {
  return role === 'baseline' ? declaration.control : declaration.treatment;
}

function validateArm(label: string, value: unknown): DeclaredVariantArm {
  const record = requireObject(`The declared ${label} arm`, value);
  rejectUnknownKeys(`The declared ${label} arm`, record, ARM_KEYS);
  for (const key of ARM_KEYS) {
    if (!(key in record)) {
      throw new InvalidVariantDeclarationError(
        `The declared ${label} arm is missing the "${key}" field.`,
      );
    }
  }

  const variantId = requireLabel(`${label}.variantId`, record['variantId']);
  const optimizerConfiguration = requireLabel(
    `${label}.optimizerConfiguration`,
    record['optimizerConfiguration'],
  );

  const role = record['role'];
  if (typeof role !== 'string' || !ROLES.includes(role as BenchmarkRunRole)) {
    throw new InvalidVariantDeclarationError(
      `The declared ${label} arm field "role" must be one of: ${ROLES.join(', ')}.`,
    );
  }

  return { variantId, role: role as BenchmarkRunRole, optimizerConfiguration };
}

function requireAxis(value: unknown): OptimizationVariantAxis {
  if (
    typeof value !== 'string' ||
    !OPTIMIZATION_VARIANT_AXES.includes(value as OptimizationVariantAxis)
  ) {
    throw new InvalidVariantDeclarationError(
      `The variant declaration field "axis" must be one of: ${OPTIMIZATION_VARIANT_AXES.join(', ')}.`,
    );
  }
  return value as OptimizationVariantAxis;
}

function requireLabel(label: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidVariantDeclarationError(
      `The variant declaration field "${label}" must be a non-empty string.`,
    );
  }
  return value;
}

function requireObject(label: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidVariantDeclarationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  label: string,
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    throw new InvalidVariantDeclarationError(
      `${label} declares unknown field(s): ${unknownKeys.join(', ')}.`,
    );
  }
}
