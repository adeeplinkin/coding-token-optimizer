import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FIXTURES_DIR,
  FixtureValidationError,
  loadFixtures,
  validateFixture,
} from '../src/index.js';
import type { FixtureCategory } from '../src/index.js';
import { createTempDir, removeDir, validFixture, writeFiles } from './helpers.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await createTempDir();
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => removeDir(directory)));
});

describe('loadFixtures', () => {
  it('loads the default fixture set in file-name order', async () => {
    const fixtures = await loadFixtures();

    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    const ids = fixtures.map((fixture) => fixture.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every required fixture category', async () => {
    const fixtures = await loadFixtures();
    const categories = fixtures.map((fixture) => fixture.category);

    const expected: readonly FixtureCategory[] = [
      'empty-context',
      'ordinary-text',
      'source-code',
      'whitespace',
      'unicode',
      'repeated-information',
      'error-message',
      'instructions',
    ];
    for (const category of expected) {
      expect(categories).toContain(category);
    }
  });

  it('keeps every fixture id the same as its file name', async () => {
    const fixtures = await loadFixtures();

    for (const fixture of fixtures) {
      await expect(access(path.join(DEFAULT_FIXTURES_DIR, `${fixture.id}.json`))).resolves.toBeUndefined();
    }
  });

  it('preserves exact whitespace, CRLF and Unicode in fixture contexts', async () => {
    const fixtures = await loadFixtures();
    const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));

    const whitespace = byId.get('004-whitespace-preservation');
    expect(whitespace?.context).toContain('\t');
    expect(whitespace?.context).toContain('\r\n');
    expect(whitespace?.context).toContain('spaces   \r\n');

    const unicode = byId.get('005-unicode-content');
    expect(unicode?.context).toContain('\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66');
    expect(unicode?.context).toContain('e\u0301');
  });

  it('rejects a directory with no fixtures', async () => {
    const directory = await makeTempDir();

    await expect(loadFixtures(directory)).rejects.toBeInstanceOf(FixtureValidationError);
  });

  it('reports an unreadable fixture directory without crashing', async () => {
    const directory = path.join(await makeTempDir(), 'missing');

    await expect(loadFixtures(directory)).rejects.toThrow(/could not be read/);
  });

  it('rejects malformed JSON without echoing file content', async () => {
    const directory = await makeTempDir();
    await writeFiles(directory, {
      'bad.json': '{"id": "bad", "context": "SENSITIVE-FIXTURE-TEXT"',
    });

    const error = await loadFixtures(directory).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(FixtureValidationError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('bad.json');
    expect(message).not.toContain('SENSITIVE-FIXTURE-TEXT');
  });

  it('rejects a fixture whose id does not match its file name', async () => {
    const directory = await makeTempDir();
    await writeFiles(directory, {
      'wrong-name.json': validFixture({ id: 'different-id' }),
    });

    await expect(loadFixtures(directory)).rejects.toThrow(/must declare id/);
  });

  it('rejects a directory entry that is not a readable file', async () => {
    const directory = await makeTempDir();
    await mkdir(path.join(directory, 'not-a-fixture.json'), { recursive: true });

    await expect(loadFixtures(directory)).rejects.toThrow(/could not be read/);
  });

  it('guarantees unique ids by requiring ids to match file names', async () => {
    const directory = await makeTempDir();
    await writeFiles(directory, {
      'first-fixture.json': validFixture({ id: 'first-fixture' }),
      'second-fixture.json': validFixture({ id: 'second-fixture' }),
    });

    const fixtures = await loadFixtures(directory);

    expect(fixtures.map((fixture) => fixture.id)).toEqual(['first-fixture', 'second-fixture']);
  });
});

describe('validateFixture', () => {
  it('accepts a minimal valid fixture with an empty context', () => {
    const fixture = validateFixture(
      'test-fixture.json',
      validFixture({ context: '', requiredContent: [] }),
    );

    expect(fixture.context).toBe('');
    expect(fixture.requiredContent).toEqual([]);
  });

  it('rejects unknown fields', () => {
    expect(() => validateFixture('test-fixture.json', validFixture({ unexpected: true }))).toThrow(
      /unknown field/,
    );
  });

  it('rejects a missing required field', () => {
    const { id: _id, ...withoutId } = validFixture();
    expect(() => validateFixture('test-fixture.json', withoutId)).toThrow(/field "id" must be a string/);
  });

  it('rejects an empty id', () => {
    expect(() => validateFixture('test-fixture.json', validFixture({ id: '' }))).toThrow(
      /field "id" must not be empty/,
    );
  });

  it('rejects a non-kebab-case id', () => {
    expect(() => validateFixture('test-fixture.json', validFixture({ id: 'Not_Kebab' }))).toThrow(
      /kebab-case/,
    );
  });

  it('rejects an unknown category', () => {
    expect(() =>
      validateFixture('test-fixture.json', validFixture({ category: 'nonsense' })),
    ).toThrow(/field "category" must be one of/);
  });

  it('rejects a non-string context', () => {
    expect(() => validateFixture('test-fixture.json', validFixture({ context: 42 }))).toThrow(
      /field "context" must be a string/,
    );
  });

  it('rejects a non-boolean expectExactPreservation', () => {
    expect(() =>
      validateFixture('test-fixture.json', validFixture({ expectExactPreservation: 'yes' })),
    ).toThrow(/field "expectExactPreservation" must be a boolean/);
  });

  it('rejects requiredContent entries without a label', () => {
    expect(() =>
      validateFixture('test-fixture.json', validFixture({ requiredContent: [{ text: 'alpha' }] })),
    ).toThrow(/requiredContent\[0\]\.label" must be a string/);
  });

  it('rejects requiredContent entries with an empty text', () => {
    expect(() =>
      validateFixture(
        'test-fixture.json',
        validFixture({ requiredContent: [{ label: 'empty', text: '' }] }),
      ),
    ).toThrow(/requiredContent\[0\]\.text" must not be empty/);
  });

  it('rejects a non-array requiredContent', () => {
    expect(() =>
      validateFixture('test-fixture.json', validFixture({ requiredContent: 'nope' })),
    ).toThrow(/field "requiredContent" must be an array/);
  });
});
