import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_OFFSET,
  READ_TOOL_ID,
  defaultHash,
  identifyReadRequest,
  isHexDigestLike,
  normalizeReadPath,
} from '../src/index.js';
import { READ_IDENTITY_SCHEME } from '../src/read.js';
import { fnv1aHex } from './helpers.js';

const hash = fnv1aHex;

function identified(args: unknown) {
  const result = identifyReadRequest(args, hash);
  if (!result.identified) {
    throw new Error('expected the read request to be identified');
  }
  return result;
}

describe('read tool recognition', () => {
  it('uses the documented built-in tool id', () => {
    expect(READ_TOOL_ID).toBe('read');
  });

  it('describes the identity scheme without claiming savings', () => {
    expect(READ_IDENTITY_SCHEME).toContain('normalized file path');
    expect(READ_IDENTITY_SCHEME.toLowerCase()).not.toContain('saving');
  });
});

describe('read request identity', () => {
  it('identifies a request that supplies only a path and applies documented defaults', () => {
    const result = identified({ filePath: '/repo/src/main.ts' });

    expect(result.offset).toBe(DEFAULT_READ_OFFSET);
    expect(result.limit).toBe(DEFAULT_READ_LIMIT);
    expect(result.malformed).toBe(false);
    expect(result.key).toBe(`${result.targetId}:${DEFAULT_READ_OFFSET}:${DEFAULT_READ_LIMIT}`);
  });

  it('treats an explicit documented default range as the same request', () => {
    const implicit = identified({ filePath: '/repo/src/main.ts' });
    const explicit = identified({
      filePath: '/repo/src/main.ts',
      offset: DEFAULT_READ_OFFSET,
      limit: DEFAULT_READ_LIMIT,
    });

    expect(explicit.key).toBe(implicit.key);
  });

  it('does not consider two different offsets identical', () => {
    const base = identified({ filePath: '/repo/src/main.ts' });
    const other = identified({ filePath: '/repo/src/main.ts', offset: 40 });

    expect(other.key).not.toBe(base.key);
    expect(other.targetId).toBe(base.targetId);
  });

  it('does not consider two different limits identical', () => {
    const base = identified({ filePath: '/repo/src/main.ts' });
    const other = identified({ filePath: '/repo/src/main.ts', limit: 50 });

    expect(other.key).not.toBe(base.key);
  });

  it('gives different files different identities', () => {
    const a = identified({ filePath: '/repo/src/a.ts' });
    const b = identified({ filePath: '/repo/src/b.ts' });

    expect(a.targetId).not.toBe(b.targetId);
  });

  it('is deterministic for identical arguments', () => {
    const first = identified({ filePath: '/repo/src/main.ts', offset: 5, limit: 10 });
    const second = identified({ filePath: '/repo/src/main.ts', offset: 5, limit: 10 });

    expect(second.key).toBe(first.key);
  });

  it('normalizes Windows separators and duplicate separators to one identity', () => {
    const posix = identified({ filePath: '/repo/src/main.ts' });
    const windows = identified({ filePath: '\\repo\\src\\main.ts' });
    const doubled = identified({ filePath: '/repo//src/main.ts' });

    expect(windows.key).toBe(posix.key);
    expect(doubled.key).toBe(posix.key);
  });

  it('trims surrounding whitespace but keeps case significant', () => {
    const base = identified({ filePath: '/repo/src/main.ts' });
    const padded = identified({ filePath: '  /repo/src/main.ts  ' });
    const upper = identified({ filePath: '/repo/src/Main.ts' });

    expect(padded.key).toBe(base.key);
    expect(upper.key).not.toBe(base.key);
  });

  it('drops a trailing separator so a directory form keeps one identity', () => {
    expect(normalizeReadPath('/repo/src/')).toBe('/repo/src');
    expect(normalizeReadPath('/repo/src//')).toBe('/repo/src');
  });
});

describe('read argument safety', () => {
  it('reports a missing path as unidentified instead of inventing one', () => {
    expect(identifyReadRequest({ offset: 1 }, hash)).toEqual({
      identified: false,
      reason: 'missing-path',
    });
  });

  it('reports unusable argument shapes as unidentified', () => {
    expect(identifyReadRequest(undefined, hash).identified).toBe(false);
    expect(identifyReadRequest(null, hash).identified).toBe(false);
    expect(identifyReadRequest('src/main.ts', hash).identified).toBe(false);
    expect(identifyReadRequest([{ filePath: '/a' }], hash).identified).toBe(false);
    expect(identifyReadRequest({ filePath: 42 }, hash).identified).toBe(false);
    expect(identifyReadRequest({ filePath: '   ' }, hash).identified).toBe(false);
  });

  it('marks a non-integer offset malformed and falls back to the documented default', () => {
    const result = identified({ filePath: '/repo/src/main.ts', offset: 1.5 });
    expect(result.malformed).toBe(true);
    expect(result.offset).toBe(DEFAULT_READ_OFFSET);

    const negative = identified({ filePath: '/repo/src/main.ts', offset: -3 });
    expect(negative.malformed).toBe(true);
    expect(negative.offset).toBe(DEFAULT_READ_OFFSET);
  });

  it('marks a non-string limit malformed and falls back to the documented default', () => {
    const result = identified({ filePath: '/repo/src/main.ts', limit: '2000' });
    expect(result.malformed).toBe(true);
    expect(result.limit).toBe(DEFAULT_READ_LIMIT);
  });

  it('treats null range values as absent rather than malformed', () => {
    const result = identified({ filePath: '/repo/src/main.ts', offset: null, limit: null });
    expect(result.malformed).toBe(false);
    expect(result.offset).toBe(DEFAULT_READ_OFFSET);
    expect(result.limit).toBe(DEFAULT_READ_LIMIT);
  });

  it('accepts zero as a schema-valid non-negative integer', () => {
    const result = identified({ filePath: '/repo/src/main.ts', offset: 0, limit: 0 });
    expect(result.malformed).toBe(false);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(0);
  });
});

describe('read identity privacy', () => {
  it('does not expose the raw path through the default hasher', () => {
    const result = identifyReadRequest(
      { filePath: '/home/dev/.config/secrets/prod.env' },
      defaultHash,
    );
    if (!result.identified) {
      throw new Error('expected the read request to be identified');
    }

    expect(result.targetId).not.toContain('secrets');
    expect(result.targetId).not.toContain('prod.env');
    expect(result.key).not.toContain('/home/dev');
    expect(isHexDigestLike(result.targetId)).toBe(true);
  });

  it('produces stable 16-character digests that differ per path', () => {
    const a = defaultHash('/repo/a.ts');
    const b = defaultHash('/repo/b.ts');

    expect(a).toHaveLength(16);
    expect(isHexDigestLike(a)).toBe(true);
    expect(defaultHash('/repo/a.ts')).toBe(a);
    expect(b).not.toBe(a);
  });
});

/**
 * V2 argument name.
 *
 * Stage 1G observed, in the real OpenCode Desktop 2.0.24 runtime, that the V2 `read`
 * tool delivers its path as `path` (`inputKeys=path` on every `tool.execute.before`),
 * while V1 names it `filePath`. Before the fix, every V2 read was counted as
 * unidentified, so repeated-read detection never fired. These tests pin the aliasing.
 */
describe('read tool recognition across API lines', () => {
  it('identifies a read from the V2 `path` argument', () => {
    const result = identified({ path: 'src/v2.ts' });

    expect(result.targetId).toBe(identified({ filePath: 'src/v2.ts' }).targetId);
    expect(result.offset).toBe(DEFAULT_READ_OFFSET);
    expect(result.limit).toBe(DEFAULT_READ_LIMIT);
  });

  it('treats the V1 and V2 names as the same target and range', () => {
    const v1 = identified({ filePath: 'a/b.ts', offset: 1, limit: 2000 });
    const v2 = identified({ path: 'a/b.ts', offset: 1, limit: 2000 });

    expect(v2.key).toBe(v1.key);
  });

  it('detects a repeated read expressed with the V2 name', () => {
    const first = identified({ path: 'notes.txt' });
    const second = identified({ path: 'notes.txt' });

    expect(second.key).toBe(first.key);
  });

  it('distinguishes different files and ranges given by the V2 name', () => {
    expect(identified({ path: 'a.txt' }).key).not.toBe(identified({ path: 'b.txt' }).key);
    expect(identified({ path: 'a.txt', offset: 1, limit: 10 }).key).not.toBe(
      identified({ path: 'a.txt', offset: 11, limit: 10 }).key,
    );
  });

  it('prefers the V1 name when both are present', () => {
    const both = identified({ filePath: 'v1.txt', path: 'v2.txt' });

    expect(both.targetId).toBe(identified({ filePath: 'v1.txt' }).targetId);
  });

  it('still reports an unidentified read when neither name is usable', () => {
    expect(identifyReadRequest({ path: '   ' }, hash)).toEqual({
      identified: false,
      reason: 'missing-path',
    });
    expect(identifyReadRequest({ path: 42 }, hash)).toEqual({
      identified: false,
      reason: 'missing-path',
    });
    expect(identifyReadRequest({}, hash)).toEqual({ identified: false, reason: 'missing-path' });
  });

  it('applies documented defaults to a V2 read that carries no range', () => {
    // Stage 1G observed V2 reads with only `path`; no range parameter names are
    // verified for V2, so the documented defaults must be applied, not guessed.
    const result = identified({ path: 'notes.txt' });

    expect(result.malformed).toBe(false);
    expect(result.key.endsWith(':1:2000')).toBe(true);
  });
});
