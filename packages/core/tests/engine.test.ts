import { describe, expect, it } from 'vitest';
import { OptimizerEngine } from '../src/index.js';
import type { OptimizationRequest, OptimizerPass, PassOutcome } from '../src/index.js';

const ORDINARY_TEXT =
  'Summarize the failing build output, then fix the regression and run the tests again.';

const MULTILINE_SOURCE = [
  '// Dr. Token test fixture: intentionally mixed formatting.',
  'export function add(a: number, b: number): number {',
  '\tif (!Number.isFinite(a) || !Number.isFinite(b)) {',
  "\t\tthrow new Error('non-finite input');",
  '\t}',
  '',
  '\treturn a + b; // trailing comment',
  '}',
  '',
  'const QUERY = `SELECT *',
  'FROM files',
  "WHERE path = 'src/main.ts'`;",
].join('\n');

const WHITESPACE_TEXT =
  '  leading spaces\n\tindented with a tab\r\nwindows line ending\n\n   trailing spaces   \n\t\n';

const UNICODE_TEXT =
  'Emoji 👨‍👩‍👧‍👦, combining accent e\u0301, CJK 日本語, RTL مرحبًا, math ∑ λ ✓, astral 𝄞';

function request(overrides: Partial<OptimizationRequest> = {}): OptimizationRequest {
  return {
    context: overrides.context ?? ORDINARY_TEXT,
    mode: overrides.mode ?? 'safe',
    optimizationEnabled: overrides.optimizationEnabled ?? true,
  };
}

function testPass(id: string, run: OptimizerPass['run']): OptimizerPass {
  return { id, description: `test fixture pass "${id}"`, run };
}

const noOpEngine = new OptimizerEngine();

describe('pass-through behavior', () => {
  it('returns an empty context unchanged', async () => {
    const result = await noOpEngine.optimize(request({ context: '' }));

    expect(result.context).toBe('');
    expect(result.contextUnchanged).toBe(true);
    expect(result.bypassed).toBe(false);
  });

  it('returns ordinary text unchanged', async () => {
    const result = await noOpEngine.optimize(request());

    expect(result.context).toBe(ORDINARY_TEXT);
    expect(result.contextUnchanged).toBe(true);
  });

  it('returns multiline source code exactly', async () => {
    const result = await noOpEngine.optimize(request({ context: MULTILINE_SOURCE }));

    expect(result.context).toBe(MULTILINE_SOURCE);
    expect(result.context).toContain('\treturn a + b; // trailing comment');
    expect(result.context).toContain("WHERE path = 'src/main.ts'");
  });

  it('preserves whitespace exactly, including tabs, CRLF and trailing spaces', async () => {
    const result = await noOpEngine.optimize(request({ context: WHITESPACE_TEXT }));

    expect(result.context).toBe(WHITESPACE_TEXT);
    expect(result.context).toContain('\r\n');
  });

  it('preserves Unicode exactly without normalization', async () => {
    const result = await noOpEngine.optimize(request({ context: UNICODE_TEXT }));

    expect(result.context).toBe(UNICODE_TEXT);
    expect(result.context).toContain('e\u0301');
    expect(result.context).toContain('👨‍👩‍👧‍👦');
  });

  it('reports a structured pass-through decision', async () => {
    const result = await noOpEngine.optimize(request());

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      passId: 'engine',
      action: 'pass-through',
      contextUnchanged: true,
      evidence: 'none',
    });
    const [firstDecision] = result.decisions;
    expect(firstDecision?.reason.length).toBeGreaterThan(0);
  });

  it('never reports measurements, savings or extra result fields', async () => {
    const result = await noOpEngine.optimize(request());

    expect(Object.keys(result).sort()).toEqual([
      'bypassed',
      'context',
      'contextUnchanged',
      'decisions',
      'mode',
    ]);
    for (const entry of result.decisions) {
      expect(entry.evidence).toBe('none');
    }
  });
});

describe('optimization modes', () => {
  it.each(['safe', 'aggressive', 'balanced'] as const)(
    'accepts the %s mode identifier and passes through unchanged',
    async (mode) => {
      const result = await noOpEngine.optimize(request({ mode }));

      expect(result.mode).toBe(mode);
      expect(result.context).toBe(ORDINARY_TEXT);
      expect(result.contextUnchanged).toBe(true);
      expect(result.bypassed).toBe(false);
    },
  );
});

describe('global bypass', () => {
  it('returns the original context when optimization is disabled', async () => {
    const result = await noOpEngine.optimize(
      request({ optimizationEnabled: false, context: MULTILINE_SOURCE }),
    );

    expect(result.bypassed).toBe(true);
    expect(result.context).toBe(MULTILINE_SOURCE);
    expect(result.contextUnchanged).toBe(true);
    expect(result.decisions[0]).toMatchObject({
      passId: 'engine',
      action: 'bypassed',
      contextUnchanged: true,
      evidence: 'none',
    });
  });

  it('does not run registered passes while bypassed', async () => {
    let runs = 0;
    const mutating = testPass('mutating', (context) => {
      runs += 1;
      return {
        context: `${context} MUTATED`,
        changed: true,
        reason: 'fixture change',
        evidence: 'none',
      };
    });
    const engine = new OptimizerEngine({ passes: [mutating] });

    const result = await engine.optimize(request({ optimizationEnabled: false }));

    expect(runs).toBe(0);
    expect(result.context).toBe(ORDINARY_TEXT);
    expect(result.bypassed).toBe(true);
    expect(result.decisions).toHaveLength(1);
  });
});

describe('pass pipeline', () => {
  it('adopts a successful pass result and reports it as applied', async () => {
    const appended = `${ORDINARY_TEXT}\n<!-- appended -->`;
    const pass = testPass('append', () => ({
      context: appended,
      changed: true,
      reason: 'fixture appends a marker',
      evidence: 'none',
    }));
    const engine = new OptimizerEngine({ passes: [pass] });

    const result = await engine.optimize(request());

    expect(result.context).toBe(appended);
    expect(result.contextUnchanged).toBe(false);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        passId: 'append',
        action: 'applied',
        contextUnchanged: false,
        evidence: 'none',
      }),
    ]);
  });

  it('runs passes in registration order', async () => {
    const first = testPass('first', (context) => ({
      context: `${context}A`,
      changed: true,
      reason: 'fixture appends A',
      evidence: 'none',
    }));
    const second = testPass('second', (context) => ({
      context: `${context}B`,
      changed: true,
      reason: 'fixture appends B',
      evidence: 'none',
    }));
    const engine = new OptimizerEngine({ passes: [first, second] });

    const result = await engine.optimize(request());

    expect(result.context).toBe(`${ORDINARY_TEXT}AB`);
  });

  it('restores the original context when a later pass throws', async () => {
    const mutating = testPass('mutating', (context) => ({
      context: `${context} MUTATED`,
      changed: true,
      reason: 'fixture change',
      evidence: 'none',
    }));
    const failing = testPass('failing', () => {
      throw new Error('SECRET-PAYLOAD must never be echoed');
    });
    const engine = new OptimizerEngine({ passes: [mutating, failing] });

    const result = await engine.optimize(request());

    expect(result.context).toBe(ORDINARY_TEXT);
    expect(result.contextUnchanged).toBe(true);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]).toMatchObject({ passId: 'mutating', action: 'applied' });
    const failed = result.decisions.at(-1);
    expect(failed).toMatchObject({
      passId: 'failing',
      action: 'failed',
      contextUnchanged: true,
      evidence: 'none',
    });
    expect(failed?.reason).toContain('Error');
    expect(failed?.reason).not.toContain('SECRET-PAYLOAD');
  });

  it('restores the original context when a pass rejects asynchronously', async () => {
    const rejecting = testPass('rejecting', async () => {
      throw new Error('async failure');
    });
    const engine = new OptimizerEngine({ passes: [rejecting] });

    const result = await engine.optimize(request());

    expect(result.context).toBe(ORDINARY_TEXT);
    expect(result.contextUnchanged).toBe(true);
    expect(result.decisions[0]).toMatchObject({ passId: 'rejecting', action: 'failed' });
  });

  it('restores the original context when a pass returns an unusable outcome', async () => {
    const broken = testPass(
      'broken',
      () => ({ context: 42, changed: true, reason: 'invalid fixture' }) as unknown as PassOutcome,
    );
    const engine = new OptimizerEngine({ passes: [broken] });

    const result = await engine.optimize(request());

    expect(result.context).toBe(ORDINARY_TEXT);
    expect(result.contextUnchanged).toBe(true);
    expect(result.decisions[0]).toMatchObject({
      passId: 'broken',
      action: 'failed',
      contextUnchanged: true,
    });
  });

  it('treats a reported change with identical content as unchanged', async () => {
    const identical = testPass('identical', (context) => ({
      context,
      changed: true,
      reason: 'fixture reports a change',
      evidence: 'none',
    }));
    const engine = new OptimizerEngine({ passes: [identical] });

    const result = await engine.optimize(request());

    expect(result.context).toBe(ORDINARY_TEXT);
    expect(result.contextUnchanged).toBe(true);
    expect(result.decisions[0]).toMatchObject({ passId: 'identical', action: 'pass-through' });
  });

  it('rejects a non-string context with a TypeError', async () => {
    await expect(
      noOpEngine.optimize({
        context: 7 as unknown as string,
        mode: 'safe',
        optimizationEnabled: true,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
