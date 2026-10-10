import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Context used by synthetic comparison fixtures. */
export const SAMPLE_CONTEXT = 'alpha\n\tbeta with a tab\n';

/** Create a unique temporary directory for a test. */
export async function createTempDir(prefix = 'dr-token-bench-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Remove a temporary directory, ignoring missing paths. */
export async function removeDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

/** Write files into a directory; objects are serialized as JSON. */
export async function writeFiles(
  directory: string,
  files: Record<string, string | Record<string, unknown>>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const text = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
    await writeFile(path.join(directory, name), text, 'utf8');
  }
}

/** A schema-valid fixture object, overridable per test. */
export function validFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'test-fixture',
    description: 'A synthetic fixture used by tests.',
    category: 'ordinary-text',
    expectExactPreservation: true,
    requiredContent: [{ label: 'sample-line', text: 'alpha' }],
    context: SAMPLE_CONTEXT,
    ...overrides,
  };
}
