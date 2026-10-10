import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkFixture, FixtureCategory, RequiredContent } from './types.js';

/** Default fixture directory, resolved for both `src` and `dist` builds. */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

const CATEGORIES: readonly FixtureCategory[] = [
  'empty-context',
  'ordinary-text',
  'source-code',
  'whitespace',
  'unicode',
  'repeated-information',
  'error-message',
  'instructions',
];

const FIXTURE_KEYS: readonly string[] = [
  'id',
  'description',
  'category',
  'expectExactPreservation',
  'requiredContent',
  'context',
];

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Raised when a fixture file is missing, unreadable, or fails validation. */
export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureValidationError';
  }
}

/**
 * Load every `*.json` fixture from a directory, sorted by file name.
 *
 * Validation failures describe the file and the offending field only. Fixture
 * content is never included in error messages, because future fixtures may
 * contain sensitive recorded context.
 */
export async function loadFixtures(directory?: string): Promise<readonly BenchmarkFixture[]> {
  const fixtureDirectory = directory ?? DEFAULT_FIXTURES_DIR;

  let entries: readonly string[];
  try {
    entries = await readdir(fixtureDirectory);
  } catch (error) {
    throw new FixtureValidationError(
      `Fixture directory "${fixtureDirectory}" could not be read (${errorName(error)}).`,
    );
  }

  const files = entries.filter((entry) => entry.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new FixtureValidationError(
      `Fixture directory "${fixtureDirectory}" contains no .json fixture files.`,
    );
  }

  const fixtures: BenchmarkFixture[] = [];

  // Fixture ids must equal their file names (validated below), so ids cannot
  // collide within a single directory.
  for (const file of files) {
    fixtures.push(await loadFixtureFile(fixtureDirectory, file));
  }

  return fixtures;
}

async function loadFixtureFile(
  fixtureDirectory: string,
  file: string,
): Promise<BenchmarkFixture> {
  const fullPath = path.join(fixtureDirectory, file);

  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf8');
  } catch (error) {
    throw new FixtureValidationError(`Fixture file "${file}" could not be read (${errorName(error)}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser message can echo file content, so it is deliberately dropped.
    throw new FixtureValidationError(`Fixture file "${file}" does not contain valid JSON.`);
  }

  const fixture = validateFixture(file, parsed);
  const expectedId = file.replace(/\.json$/, '');
  if (fixture.id !== expectedId) {
    throw new FixtureValidationError(
      `Fixture file "${file}" must declare id "${expectedId}" but declared "${fixture.id}".`,
    );
  }
  return fixture;
}

/** Validate parsed fixture data against the fixture schema. */
export function validateFixture(file: string, value: unknown): BenchmarkFixture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FixtureValidationError(`Fixture file "${file}" must contain a JSON object.`);
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !FIXTURE_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new FixtureValidationError(
      `Fixture file "${file}" declares unknown field(s): ${unknownKeys.join(', ')}.`,
    );
  }

  const id = requireString(file, record, 'id');
  if (!ID_PATTERN.test(id)) {
    throw new FixtureValidationError(
      `Fixture file "${file}" must use a kebab-case id (received an invalid id).`,
    );
  }

  const description = requireString(file, record, 'description');
  const context = requireString(file, record, 'context', { allowEmpty: true });

  const category = record['category'];
  if (typeof category !== 'string' || !CATEGORIES.includes(category as FixtureCategory)) {
    throw new FixtureValidationError(
      `Fixture file "${file}" field "category" must be one of: ${CATEGORIES.join(', ')}.`,
    );
  }

  const expectExactPreservation = record['expectExactPreservation'];
  if (typeof expectExactPreservation !== 'boolean') {
    throw new FixtureValidationError(
      `Fixture file "${file}" field "expectExactPreservation" must be a boolean.`,
    );
  }

  return {
    id,
    description,
    category: category as FixtureCategory,
    context,
    expectExactPreservation,
    requiredContent: validateRequiredContent(file, record['requiredContent']),
  };
}

function validateRequiredContent(file: string, value: unknown): readonly RequiredContent[] {
  if (!Array.isArray(value)) {
    throw new FixtureValidationError(`Fixture file "${file}" field "requiredContent" must be an array.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new FixtureValidationError(
        `Fixture file "${file}" requiredContent[${index}] must be an object.`,
      );
    }
    const record = entry as Record<string, unknown>;
    const label = requireString(file, record, 'label', { context: `requiredContent[${index}]` });
    const text = requireString(file, record, 'text', {
      context: `requiredContent[${index}]`,
      allowEmpty: false,
    });
    return { label, text };
  });
}

function requireString(
  file: string,
  record: Record<string, unknown>,
  key: string,
  options: { readonly allowEmpty?: boolean; readonly context?: string } = {},
): string {
  const prefix = options.context === undefined ? '' : `${options.context}.`;
  const value = record[key];
  if (typeof value !== 'string') {
    throw new FixtureValidationError(`Fixture file "${file}" field "${prefix}${key}" must be a string.`);
  }
  if (options.allowEmpty !== true && value.length === 0) {
    throw new FixtureValidationError(`Fixture file "${file}" field "${prefix}${key}" must not be empty.`);
  }
  return value;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : 'unknown error';
}
