/**
 * Synthetic repository provisioning for Level 2.
 *
 * Two things matter here and nothing else does:
 *
 * 1. **Reproducibility.** A task's starting state and revision identity are derived
 *    from its own file map, so both arms of a pair start from byte-identical
 *    content and record the same `repositoryRevision`. A pair whose revisions
 *    differ is refused by the comparison contract, which is the point.
 * 2. **Grading independence.** The files that decide success are restored from the
 *    pristine pack *after* the agent finishes, so the agent cannot grade itself by
 *    editing tests.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Level2Task } from './types.js';

/** SHA-256 of a string. */
export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Stable revision identity of a repository file map.
 *
 * Sorted by path and hashing `path` and `content` separately, so a rename or a
 * content edit always changes the revision and two maps with the same files hash
 * the same regardless of insertion order.
 */
export function repoRevision(files: Readonly<Record<string, string>>): string {
  const lines = Object.keys(files)
    .sort()
    .map((path) => `${path}\u0000${digest(files[path] ?? '')}`);
  return digest(lines.join('\n'));
}

/** Write a file map into a repository root, creating parent directories. */
export async function materializeRepo(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

/** Create a repository from the task's pristine starting state. */
export async function provisionTaskRepo(root: string, task: Level2Task): Promise<void> {
  await mkdir(root, { recursive: true });
  await materializeRepo(root, task.files);
}

/**
 * Replace the files that decide grading with their pristine content.
 *
 * Returns the relative paths that differ, which is both a check (the restore must
 * have worked) and a report line: "the agent edited the tests" is information the
 * experiment should carry rather than silently undo.
 */
export async function restoreGradedFiles(root: string, task: Level2Task): Promise<readonly string[]> {
  const changed: string[] = [];
  for (const path of task.gradedFiles) {
    const pristine = task.files[path];
    if (pristine === undefined) {
      throw new Error(`Task "${task.id}" lists "${path}" as graded but does not define it.`);
    }
    const target = join(root, ...path.split('/'));
    let current: string | undefined;
    try {
      current = await readFile(target, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== pristine) {
      changed.push(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, pristine, 'utf8');
    }
  }
  return changed;
}

/** Directories never included in a repository snapshot. */
const SNAPSHOT_EXCLUDES = new Set(['.git', 'node_modules', '.opencode']);

/**
 * Sorted `path -> digest` map of a repository tree.
 *
 * Harness directories (`.opencode`, `node_modules`, `.git`) are excluded: they are
 * instrumentation, not the agent's work product, and including them would make two
 * arms differ for reasons that have nothing to do with the task.
 */
export async function snapshotRepo(
  root: string,
  directory = root,
): Promise<readonly (readonly [string, string])[]> {
  const entries: (readonly [string, string])[] = [];
  let dirents;
  try {
    dirents = await readdir(directory, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const dirent of dirents) {
    const full = join(directory, dirent.name);
    if (dirent.isDirectory()) {
      if (SNAPSHOT_EXCLUDES.has(dirent.name)) {
        continue;
      }
      entries.push(...(await snapshotRepo(root, full)));
      continue;
    }
    let content: string;
    try {
      content = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    entries.push([relative(root, full).split(sep).join('/'), digest(content)] as const);
  }
  return entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

/** Revision identity of the repository as it stands, after an arm finished. */
export async function snapshotRevision(root: string): Promise<string> {
  const entries = await snapshotRepo(root);
  return digest(entries.map(([path, hash]) => `${path}\u0000${hash}`).join('\n'));
}

/** Replace the given files, used to apply a golden or a wrong solution. */
export async function applyFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await materializeRepo(root, files);
}

/** Remove a directory tree, ignoring a missing path. */
export async function removeRepo(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/**
 * Make the repository look as if a cheating agent had been there: every graded file
 * is replaced by a trivially passing test.
 *
 * Used by the offline verification to prove that restoring pristine tests actually
 * denies this route, rather than the grader merely happening to pass.
 */
export async function weakenGradedFiles(root: string, task: Level2Task): Promise<void> {
  for (const path of task.gradedFiles) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `import { test } from 'node:test';\n\ntest('always passes', () => {});\n`,
      'utf8',
    );
  }
}
