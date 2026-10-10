import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OBSERVER_SUMMARY_FILE_ENV_VAR,
  createSummaryFileSink,
  isUsableSummaryPath,
  resolveEnvironmentSink,
} from '../src/index.js';
import { createObservationHarness } from './helpers.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dr-token-sink-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('summary sink configuration', () => {
  it('is disabled unless the user explicitly configures a path', () => {
    expect(resolveEnvironmentSink({})).toBeUndefined();
    expect(resolveEnvironmentSink({ [OBSERVER_SUMMARY_FILE_ENV_VAR]: '' })).toBeUndefined();
    expect(resolveEnvironmentSink({ [OBSERVER_SUMMARY_FILE_ENV_VAR]: '   ' })).toBeUndefined();
    expect(resolveEnvironmentSink({ [OBSERVER_SUMMARY_FILE_ENV_VAR]: 7 as unknown as string })).toBeUndefined();
  });

  it('creates a sink when a path is configured', () => {
    expect(resolveEnvironmentSink({ [OBSERVER_SUMMARY_FILE_ENV_VAR]: 'out.jsonl' })).toBeTypeOf(
      'function',
    );
  });

  it('validates candidate paths', () => {
    expect(isUsableSummaryPath('out.jsonl')).toBe(true);
    expect(isUsableSummaryPath('  out.jsonl  ')).toBe(true);
    expect(isUsableSummaryPath('')).toBe(false);
    expect(isUsableSummaryPath('   ')).toBe(false);
    expect(isUsableSummaryPath(undefined)).toBe(false);
    expect(isUsableSummaryPath(12)).toBe(false);
  });

  it('writes nothing when no sink is configured', async () => {
    const directory = await temporaryDirectory();
    const harness = await createObservationHarness({ env: { [OBSERVER_SUMMARY_FILE_ENV_VAR]: '' } });
    await harness.before('ses_1', 'bash', 'c1');
    await harness.event('session.idle', { sessionID: 'ses_1' });

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('summary file sink', () => {
  it('appends one JSON object per line', async () => {
    const directory = await temporaryDirectory();
    const summaryFile = path.join(directory, 'observations.jsonl');
    const harness = await createObservationHarness({ sink: createSummaryFileSink(summaryFile) });

    await harness.before('ses_1', 'bash', 'c1');
    await harness.event('session.idle', { sessionID: 'ses_1' });
    await harness.before('ses_2', 'bash', 'c2');
    await harness.event('session.idle', { sessionID: 'ses_2' });

    const content = await readFile(summaryFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { sessionId: string }).sessionId)).toEqual([
      'ses_1',
      'ses_2',
    ]);
  });

  it('writes only observation metadata', async () => {
    const directory = await temporaryDirectory();
    const summaryFile = path.join(directory, 'observations.jsonl');
    const harness = await createObservationHarness({ sink: createSummaryFileSink(summaryFile) });

    await harness.before('ses_1', 'read', 'c1', { filePath: '/repo/private/creds.env' });
    await harness.after('ses_1', 'read', 'c1', { filePath: '/repo/private/creds.env' }, {
      output: 'SECRET-OUTPUT-TEXT',
      title: '/repo/private/creds.env',
    });
    await harness.event('session.idle', { sessionID: 'ses_1' });

    const content = await readFile(summaryFile, 'utf8');
    expect(content).not.toContain('/repo/private');
    expect(content).not.toContain('creds.env');
    expect(content).not.toContain('SECRET-OUTPUT-TEXT');
  });

  it('rejects when the path is not writable and the observer contains it', async () => {
    const directory = await temporaryDirectory();
    const missing = path.join(directory, 'no-such-directory', 'observations.jsonl');
    const sink = createSummaryFileSink(missing);

    const harness = await createObservationHarness({ sink });
    await harness.before('ses_1', 'bash', 'c1');

    await expect(harness.event('session.idle', { sessionID: 'ses_1' })).resolves.toBeUndefined();
    expect(harness.diagnostics.map((entry) => entry.code)).toContain('sink-failed');
    expect(harness.observer.getSnapshot().internalErrors).toBe(0);
  });

  it('surfaces a sink rejection to a direct caller', async () => {
    const directory = await temporaryDirectory();
    const sink = createSummaryFileSink(path.join(directory, 'missing', 'out.jsonl'));

    await expect(
      sink({
        schemaVersion: 1,
      } as unknown as Parameters<typeof sink>[0]),
    ).rejects.toBeInstanceOf(Error);
  });
});
