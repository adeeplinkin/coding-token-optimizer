import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyRecords,
  createAccumulator,
  fromPersisted,
  parseRecord,
  toPersisted,
  type Accumulator,
} from './accumulate.js';
import { defaultHash } from './identity.js';
import { DEFAULT_OBSERVATION_LIMITS } from './types.js';
import type { ObservationLimits, ObservationRecord } from './types.js';

/**
 * Cross-process observation state.
 *
 * Codex spawns one process per hook event, so session continuity has to survive
 * process exit. The design is deliberately small:
 *
 * - **Journal (append-only).** Every event appends one content-free record to
 *   `<state>/sessions/<digest>.jsonl` in a single `appendFile` call ending in
 *   `\n`. Appends need no lock, so concurrent hook processes cannot deadlock or
 *   lose each other's records, and a reader that ignores a torn trailing line
 *   never sees half a record.
 * - **Snapshot (compaction).** When the journal grows past a threshold a
 *   compaction is attempted: the journal is renamed aside, folded into
 *   `<digest>.state.json` (written to a temporary file and renamed into place),
 *   and the renamed journal is removed. Renaming **before** folding is what makes
 *   this safe: a record appended during the compaction lands in the fresh journal
 *   (or in the sealed file, which is still folded), so nothing is silently lost.
 *   Only one process can win the rename; a compaction that cannot take the
 *   short-lived lock is skipped and reported rather than retried forever.
 * - **Cleanup.** `SessionEnd` folds, reports and deletes the session's state, and
 *   a session start sweeps state left behind by an interrupted session.
 *
 * Nothing here ever writes into the user's Codex home or into the repository. The
 * default root is a directory under the system temp directory, and the raw
 * session id never becomes a file name — only its digest does.
 */

/** Directory created under the temp directory when no override is configured. */
export const STATE_ROOT_DIRNAME = 'dr-token-codex-observer';

/** Journal size that triggers a compaction attempt. */
export const COMPACTION_TRIGGER_BYTES = 64 * 1024;

/** A lock older than this is treated as abandoned by a dead process. */
export const LOCK_STALE_MS = 5_000;

/** How many sessions a sweep will examine in one pass. */
export const SWEEP_ENTRY_LIMIT = 256;

/** State older than this is removed by a sweep. */
export const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Where one session's state lives. */
export interface SessionPaths {
  readonly journal: string;
  readonly snapshot: string;
  readonly lock: string;
}

/** Outcome of appending one record. */
export type AppendOutcome = 'appended' | 'dropped' | 'unavailable';

/** Result of reading a session's accumulated state. */
export interface LoadedSession {
  readonly accumulator: Accumulator;
  /** Journal records actually folded. */
  readonly recordsFolded: number;
  /** True when a bound meant part of the journal was not folded. */
  readonly incomplete: boolean;
}

/** Resolve the state root from an override, the environment, or the temp directory. */
export function resolveStateRoot(override: string | undefined): string {
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  return path.join(tmpdir(), STATE_ROOT_DIRNAME);
}

/** Paths for one session. The session key is hashed, never used verbatim. */
export function sessionPaths(stateRoot: string, sessionKey: string): SessionPaths {
  const digest = defaultHash(sessionKey);
  const directory = path.join(stateRoot, 'sessions');
  return {
    journal: path.join(directory, `${digest}.jsonl`),
    snapshot: path.join(directory, `${digest}.state.json`),
    lock: path.join(directory, `${digest}.lock`),
  };
}

async function ensureSessionsDirectory(stateRoot: string): Promise<string> {
  const directory = path.join(stateRoot, 'sessions');
  await mkdir(directory, { recursive: true });
  return directory;
}

async function sizeOf(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    return 0;
  }
}

function encodeRecord(record: ObservationRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Append one record to a session's journal.
 *
 * Drops the record when the journal is already at its byte bound, so a session
 * that cannot be compacted degrades to "fewer observations" instead of an
 * unbounded file. Any filesystem failure returns `unavailable`; the caller
 * reports it and Codex is unaffected.
 */
export async function appendRecord(
  stateRoot: string,
  sessionKey: string,
  record: ObservationRecord,
  limits: ObservationLimits = DEFAULT_OBSERVATION_LIMITS,
): Promise<AppendOutcome> {
  try {
    await ensureSessionsDirectory(stateRoot);
    const paths = sessionPaths(stateRoot, sessionKey);
    const size = await sizeOf(paths.journal);
    if (size >= limits.maxJournalBytes) {
      return 'dropped';
    }
    const line = encodeRecord(record);
    // Two attempts: concurrent hook processes can briefly contend for the file on
    // Windows. A short jittered retry absorbs that without a lock; a real failure
    // still reports `unavailable` rather than throwing into Codex.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await appendFile(paths.journal, line, 'utf8');
        return 'appended';
      } catch {
        if (attempt === 1) {
          return 'unavailable';
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 10 + Math.floor(Math.random() * 25));
        });
      }
    }
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Split a journal file into whole records, ignoring a torn trailing line. */
export function parseJournalContents(contents: string): {
  readonly records: readonly ObservationRecord[];
  readonly tornTail: boolean;
} {
  const lines = contents.split('\n');
  const tornTail = lines.length > 0 && (lines[lines.length - 1] ?? '').length > 0;
  if (tornTail) {
    lines.pop();
  }
  const records: ObservationRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = parseRecord(parsed);
    if (record !== undefined) {
      records.push(record);
    }
  }
  return { records, tornTail };
}

/**
 * Read a session's state: the compacted snapshot plus whatever is in the journal.
 *
 * At most `maxJournalRecordsHard` records are folded, taken from the end of the
 * journal, so a journal that a compaction could not shrink still bounds the work
 * a single hook invocation performs. When records are skipped the result is
 * reported as `incomplete` rather than silently summarized.
 */
export async function loadSession(
  stateRoot: string,
  sessionKey: string,
  limits: ObservationLimits = DEFAULT_OBSERVATION_LIMITS,
): Promise<LoadedSession> {
  const paths = sessionPaths(stateRoot, sessionKey);
  let accumulator = createAccumulator();
  let recordsFolded = 0;
  let incomplete = false;

  try {
    const snapshotText = await readFile(paths.snapshot, 'utf8');
    accumulator = fromPersisted(JSON.parse(snapshotText));
    recordsFolded = accumulator.records;
  } catch {
    accumulator = createAccumulator();
  }

  try {
    const journalText = await readFile(paths.journal, 'utf8');
    const { records, tornTail } = parseJournalContents(journalText);
    if (tornTail) {
      incomplete = true;
    }
    const retained =
      records.length > limits.maxJournalRecordsHard
        ? records.slice(records.length - limits.maxJournalRecordsHard)
        : records;
    if (retained.length < records.length) {
      incomplete = true;
    }
    recordsFolded += retained.length;
    applyRecords(accumulator, retained, limits);
  } catch {
    // No journal yet, or unreadable: the snapshot alone is a valid answer.
  }

  if (incomplete) {
    accumulator.journalAtCapacity = true;
  }

  return { accumulator, recordsFolded, incomplete };
}

/** Take the short-lived compaction lock, stealing an abandoned one when safe. */
async function acquireLock(lockPath: string, now: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid), 'utf8');
      await handle.close();
      return true;
    } catch {
      try {
        const info = await stat(lockPath);
        const age = now - info.mtimeMs;
        if (!Number.isFinite(age) || age > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      return false;
    }
  }
  return false;
}

/** Result of a compaction attempt. */
export interface CompactionResult {
  readonly compacted: boolean;
  /** True when a compaction was warranted but could not be serialized. */
  readonly skipped: boolean;
}

/**
 * Compact a session's journal into its snapshot when it has grown large enough.
 *
 * Safe under concurrency: the journal is renamed aside first, so appends that
 * arrive during the fold are never lost, and a loser of the rename simply skips.
 */
export async function compactSession(
  stateRoot: string,
  sessionKey: string,
  limits: ObservationLimits = DEFAULT_OBSERVATION_LIMITS,
  now: number = Date.now(),
  triggerBytes: number = COMPACTION_TRIGGER_BYTES,
): Promise<CompactionResult> {
  const paths = sessionPaths(stateRoot, sessionKey);
  let size = 0;
  try {
    size = await sizeOf(paths.journal);
  } catch {
    return { compacted: false, skipped: false };
  }
  if (size < triggerBytes) {
    return { compacted: false, skipped: false };
  }

  const locked = await acquireLock(paths.lock, now);
  if (!locked) {
    return { compacted: false, skipped: true };
  }

  const sealed = `${paths.journal}.${process.pid}.sealed`;
  try {
    try {
      await rename(paths.journal, sealed);
    } catch {
      return { compacted: false, skipped: false };
    }

    const { accumulator } = await loadExistingSnapshot(paths.snapshot);
    const sealedText = await readFile(sealed, 'utf8');
    const { records } = parseJournalContents(sealedText);
    applyRecords(accumulator, records, limits);
    accumulator.compactions += 1;

    const temporary = `${paths.snapshot}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(toPersisted(accumulator)), 'utf8');
    await rename(temporary, paths.snapshot);
    await rm(sealed, { force: true });
    return { compacted: true, skipped: false };
  } catch {
    return { compacted: false, skipped: true };
  } finally {
    await rm(paths.lock, { force: true });
  }
}

async function loadExistingSnapshot(snapshotPath: string): Promise<{ accumulator: Accumulator }> {
  try {
    const text = await readFile(snapshotPath, 'utf8');
    return { accumulator: fromPersisted(JSON.parse(text)) };
  } catch {
    return { accumulator: createAccumulator() };
  }
}

/** Delete a session's journal, snapshot and lock (used at `SessionEnd`). */
export async function releaseSession(stateRoot: string, sessionKey: string): Promise<void> {
  const paths = sessionPaths(stateRoot, sessionKey);
  await Promise.allSettled([
    rm(paths.journal, { force: true }),
    rm(paths.snapshot, { force: true }),
    rm(paths.lock, { force: true }),
  ]);
}

/**
 * Remove state left behind by a session that never ended (crash, kill, power loss).
 *
 * A session start triggers one bounded pass. Failures are ignored: a sweep that
 * cannot run must never affect the observation it was called for.
 */
export async function sweepStaleSessions(
  stateRoot: string,
  now: number = Date.now(),
  maxAgeMs: number = STATE_MAX_AGE_MS,
): Promise<number> {
  let removed = 0;
  try {
    const directory = path.join(stateRoot, 'sessions');
    const entries = await readdir(directory);
    let examined = 0;
    for (const entry of entries) {
      if (examined >= SWEEP_ENTRY_LIMIT) {
        break;
      }
      examined += 1;
      const filePath = path.join(directory, entry);
      try {
        const info = await stat(filePath);
        if (now - info.mtimeMs > maxAgeMs) {
          await rm(filePath, { force: true });
          removed += 1;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return removed;
  }
  return removed;
}
