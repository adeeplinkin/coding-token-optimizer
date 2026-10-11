/**
 * The declared controlled comparison Level 2 runs under (Stage 1S contract).
 *
 * The control arm is the same plugin with the pass off; the treatment arm is the
 * same plugin with the pass on. That is the *one* permitted axis, and declaring it
 * is what lets `compareRuns` treat the pair as one experiment instead of rejecting
 * it for having two different optimizer configurations.
 *
 * The declaration is data, not code: it is fingerprinted, recorded in both arms'
 * provenance, and re-verified from that provenance when the report is built.
 */
import { createHash } from 'node:crypto';
import { validateVariantDeclaration } from '../variant.js';
import type { DeclaredVariant } from '../types.js';
import type { Level2Arm, Level2Declaration } from './types.js';

/**
 * Optimizer configurations the arms record.
 *
 * They name the two settings of the *same* configuration: the shipped plugin with
 * `DR_TOKEN_SAFE_MODE` off, and the shipped plugin with it set to `apply`.
 */
export const LEVEL2_CONTROL_CONFIGURATION = 'opencode-observer:safe-mode=off';
export const LEVEL2_TREATMENT_CONFIGURATION = 'opencode-observer:safe-mode=apply';

/** Stable id of the experiment, shared by both arms. */
export const LEVEL2_DECLARATION_ID = 'safe-mode-v1-exact-duplicate-tool-result-elision';

/** The declaration as a value, before validation. */
export const LEVEL2_DECLARED_VARIANT: DeclaredVariant = {
  declarationId: LEVEL2_DECLARATION_ID,
  axis: 'optimizer-configuration',
  control: {
    variantId: 'control',
    role: 'baseline',
    optimizerConfiguration: LEVEL2_CONTROL_CONFIGURATION,
  },
  treatment: {
    variantId: 'safe-mode-v1',
    role: 'candidate',
    optimizerConfiguration: LEVEL2_TREATMENT_CONFIGURATION,
  },
};

/** SHA-256 over the declaration's own fields, in a fixed order. */
export function fingerprintDeclaration(declaration: DeclaredVariant): string {
  return createHash('sha256')
    .update(
      [
        declaration.declarationId,
        declaration.axis,
        declaration.control.variantId,
        declaration.control.role,
        declaration.control.optimizerConfiguration,
        declaration.treatment.variantId,
        declaration.treatment.role,
        declaration.treatment.optimizerConfiguration,
      ].join('\n'),
      'utf8',
    )
    .digest('hex');
}

/**
 * The validated declaration and its fingerprint.
 *
 * Validation runs through the Stage 1S validator, so a mistake in this file (a
 * swapped role, one arm reused for both) fails here rather than producing a pair
 * the comparison contract would then refuse in a less obvious way.
 */
export function resolveLevel2Declaration(): Level2Declaration {
  const declaration = validateVariantDeclaration(LEVEL2_DECLARED_VARIANT);
  return { declaration, fingerprint: fingerprintDeclaration(declaration) };
}

/** The optimizer configuration an arm must record. */
export function configurationFor(arm: Level2Arm): string {
  return arm === 'control' ? LEVEL2_CONTROL_CONFIGURATION : LEVEL2_TREATMENT_CONFIGURATION;
}

/** The declared role an arm must record. */
export function roleFor(arm: Level2Arm): 'baseline' | 'candidate' {
  return arm === 'control' ? 'baseline' : 'candidate';
}

/**
 * The value of `DR_TOKEN_SAFE_MODE` an arm runs with.
 *
 * The control arm passes an explicit `off` rather than nothing, so both arms are
 * configured by the same mechanism and neither depends on a default.
 */
export function safeModeSettingFor(arm: Level2Arm): 'off' | 'apply' {
  return arm === 'control' ? 'off' : 'apply';
}
