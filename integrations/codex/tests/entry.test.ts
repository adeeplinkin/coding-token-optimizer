import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_STDIN_BYTES, parseJournalContents, sessionPaths } from '../src/index.js';
import {
  documentedPermissionRequest,
  documentedPostToolUse,
  documentedPreToolUse,
  documentedSessionEnd,
  documentedSessionStart,
  documentedUserPromptSubmit,
} from './fixtures/codex-hooks.contract.js';
import {
  ENTRY_PATH,
  readSummaryLines,
  runHookProcess,
  runHookProcesses,
  temporaryDirectory,
} from './helpers.js';

async function safeReaddir(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

interface Workspace {
  readonly stateDir: string;
  readonly summaryFile: string;
  readonly env: Record<string, string>;
}

async function workspace(extra: Record<string, string> = {}): Promise<Workspace> {
  const stateDir = await temporaryDirectory();
  const summaryFile = path.join(stateDir, 'summaries.jsonl');
  return {
    stateDir,
    summaryFile,
    env: {
      DR_TOKEN_CODEX_STATE_DIR: stateDir,
      DR_TOKEN_OBSERVER_SUMMARY_FILE: summaryFile,
      ...extra,
    },
  };
}

const send = (payload: unknown, env: Record<string, string>) =>
  runHookProcess(JSON.stringify(payload), env);

describe('the entry point as Codex invokes it', () => {
  it('exits 0 and prints nothing for a documented payload', async () => {
    const space = await workspace();
    const run = await send(documentedSessionStart(), space.env);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  });

  it('writes diagnostics to stderr, never stdout, when debugging is enabled', async () => {
    const space = await workspace({ DR_TOKEN_CODEX_DEBUG: '1' });
    const run = await runHookProcess('not json', space.env);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('dr-token-codex-observer');
    expect(run.stderr).toContain('hook-input-unusable');
  });

  it('stays silent on stderr for a normal observation', async () => {
    const space = await workspace({ DR_TOKEN_CODEX_DEBUG: '1' });
    const run = await send(documentedSessionStart(), space.env);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  });

  it('never leaks diagnostics to stdout, whatever the input', async () => {
    const space = await workspace({ DR_TOKEN_CODEX_DEBUG: '1' });
    const payloads = [
      JSON.stringify(documentedSessionStart()),
      'not json',
      '',
      '{',
      JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'thr_1', tool_name: 'Bash' }),
      JSON.stringify([1, 2, 3]),
      JSON.stringify(null),
    ];
    const runs = await Promise.all(payloads.map((payload) => runHookProcess(payload, space.env)));
    for (const run of runs) {
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
    }
  });

  it('records an unusable payload without failing', async () => {
    const space = await workspace();
    const run = await runHookProcess('{ this is not json', space.env);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');

    const contents = await readFile(
      sessionPaths(space.stateDir, '__unattributed__').journal,
      'utf8',
    );
    const { records } = parseJournalContents(contents);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe('unusable');
  });

  it('treats empty stdin as an unusable payload', async () => {
    const space = await workspace();
    const run = await runHookProcess('', space.env);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    const contents = await readFile(
      sessionPaths(space.stateDir, '__unattributed__').journal,
      'utf8',
    );
    expect(parseJournalContents(contents).records).toHaveLength(1);
  });

  it('treats an oversized payload as unusable rather than reading it all', async () => {
    const space = await workspace();
    const oversized = `{"hook_event_name":"SessionStart","padding":"${'x'.repeat(
      MAX_STDIN_BYTES + 1024,
    )}"}`;
    const run = await runHookProcess(oversized, space.env);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    const contents = await readFile(
      sessionPaths(space.stateDir, '__unattributed__').journal,
      'utf8',
    );
    const { records } = parseJournalContents(contents);
    expect(records[0]?.kind).toBe('unusable');
    // The oversized text itself must not be stored anywhere.
    expect(contents.length).toBeLessThan(1000);
  });

  it('records nothing when the environment disables observation', async () => {
    const space = await workspace({ DR_TOKEN_CODEX_OBSERVER: 'off' });
    const run = await send(documentedSessionStart(), space.env);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(await safeReaddir(space.stateDir)).toEqual([]);
  });

  it('exits 0 and prints nothing for a session id it refuses to trust', async () => {
    const space = await workspace();
    const run = await send(
      { hook_event_name: 'SessionEnd', session_id: '../../etc/passwd' },
      space.env,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(await safeReaddir(path.join(space.stateDir, 'sessions'))).not.toContain('..');
  });
});

describe('state persists across hook processes', () => {
  it('accumulates a whole session across separate invocations and reports it at SessionEnd', async () => {
    const space = await workspace();

    const steps: unknown[] = [
      documentedSessionStart(),
      documentedUserPromptSubmit('read src/app.ts', 'thr_123'),
      documentedPreToolUse('Bash', { command: 'cat src/app.ts' }, 'c1'),
      documentedPostToolUse('Bash', { command: 'cat src/app.ts' }, { output: 'code' }, 'c1'),
      documentedPreToolUse('Bash', { command: 'cat src/app.ts' }, 'c2'),
      documentedPostToolUse('Bash', { command: 'cat src/app.ts' }, { output: 'code' }, 'c2'),
      documentedPermissionRequest('Bash', { command: 'rm -rf /' }),
    ];
    for (const payload of steps) {
      const run = await send(payload, space.env);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
    }

    const end = await send(documentedSessionEnd(), space.env);
    expect(end.status).toBe(0);

    const summaries = await readSummaryLines(space.summaryFile);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0] as Record<string, unknown>;
    expect(summary['sessionId']).toBe('thr_123');
    expect(summary['sessionIdentity']).toBe('reported');

    const counts = summary['counts'] as Record<string, number>;
    expect(counts['toolStartsObserved']).toBe(2);
    expect(counts['toolCompletionsObserved']).toBe(2);
    expect(counts['correlatedCompletions']).toBe(2);
    expect(counts['promptsSubmitted']).toBe(1);
    expect(counts['permissionRequests']).toBe(1);
    expect(counts['sessionStarts']).toBe(1);
    expect(counts['sessionEnds']).toBe(1);
    // Seven delivered steps plus the SessionEnd: every one of them is counted,
    // and the total must agree with the journal the summary was folded from.
    expect(counts['hookEventsObserved']).toBe(8);
    expect(counts['unusablePayloads']).toBe(0);
    expect((summary['journal'] as Record<string, number>)['records']).toBe(
      counts['hookEventsObserved'],
    );

    const reads = summary['reads'] as Record<string, number | string>;
    expect(reads['identifiedRequests']).toBe(2);
    expect(reads['distinctTargets']).toBe(1);
    expect(reads['repeatedRequests']).toBe(1);

    // SessionEnd releases the session's state.
    expect(await safeReaddir(path.join(space.stateDir, 'sessions'))).toEqual([]);
  });

  it('keeps independent sessions independent across processes', async () => {
    const space = await workspace();
    await send(documentedSessionStart('startup', 'thr_a'), space.env);
    await send(documentedPreToolUse('Bash', { command: 'cat a.ts' }, 'a1', 'thr_a'), space.env);
    await send(documentedSessionStart('startup', 'thr_b'), space.env);
    await send(documentedPreToolUse('Bash', { command: 'cat a.ts' }, 'b1', 'thr_b'), space.env);
    await send(documentedPreToolUse('Bash', { command: 'cat a.ts' }, 'b2', 'thr_b'), space.env);
    await send(documentedSessionEnd('thr_a'), space.env);
    await send(documentedSessionEnd('thr_b'), space.env);

    const summaries = await readSummaryLines(space.summaryFile);
    expect(summaries).toHaveLength(2);
    const byId = new Map(summaries.map((entry) => [entry['sessionId'], entry]));
    expect((byId.get('thr_a')?.['counts'] as Record<string, number>)['toolStartsObserved']).toBe(1);
    expect((byId.get('thr_b')?.['counts'] as Record<string, number>)['toolStartsObserved']).toBe(2);
  });
});

describe('concurrent hook processes', () => {
  it('loses no records when many hooks fire at once', async () => {
    const space = await workspace();
    await send(documentedSessionStart(), space.env);

    const payloads = Array.from({ length: 12 }, (_unused, index) =>
      JSON.stringify(
        documentedPreToolUse(
          index % 3 === 0 ? 'mcp__fs__read_file' : 'Bash',
          index % 3 === 0 ? { path: 'src/shared.ts' } : { command: 'cat src/shared.ts' },
          `c${index}`,
        ),
      ),
    );
    const runs = await runHookProcesses(payloads, space.env);
    for (const run of runs) {
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
    }

    await send(documentedSessionEnd(), space.env);

    const summaries = await readSummaryLines(space.summaryFile);
    const summary = summaries[0] as Record<string, unknown>;
    expect((summary['counts'] as Record<string, number>)['toolStartsObserved']).toBe(12);
    expect((summary['reads'] as Record<string, number>)['identifiedRequests']).toBe(12);
    expect((summary['reads'] as Record<string, number>)['repeatedRequests']).toBe(11);
    // 12 tool starts, one session start and the session-end record itself.
    expect((summary['journal'] as Record<string, number>)['records']).toBe(14);
  });

  it('leaves no corrupt journal behind after concurrent writes', async () => {
    const space = await workspace();
    const payloads = Array.from({ length: 10 }, (_unused, index) =>
      JSON.stringify(
        documentedPreToolUse('Bash', { command: 'cat a.ts' }, `c${index}`, 'thr_concurrent'),
      ),
    );
    const runs = await runHookProcesses(payloads, space.env);
    expect(runs.every((run) => run.status === 0)).toBe(true);

    const contents = await readFile(
      sessionPaths(space.stateDir, 'thr_concurrent').journal,
      'utf8',
    );
    const { records, tornTail } = parseJournalContents(contents);
    expect(tornTail).toBe(false);
    expect(records).toHaveLength(10);
    for (const line of contents.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('privacy across processes', () => {
  it('stores no prompt, tool output, path or credential anywhere it writes', async () => {
    const space = await workspace();
    const secrets = ['sk-live-DEADBEEF', '/home/someone/.ssh/id_rsa', 'C:\\Users\\someone\\secrets.txt'];

    await send(documentedSessionStart(), space.env);
    await send(documentedUserPromptSubmit('use sk-live-DEADBEEF now'), space.env);
    await send(
      documentedPreToolUse('Bash', { command: 'cat /home/someone/.ssh/id_rsa' }, 'c1'),
      space.env,
    );
    await send(
      documentedPostToolUse('Bash', { command: 'cat /home/someone/.ssh/id_rsa' }, 'sk-live-DEADBEEF', 'c1'),
      space.env,
    );
    await send(
      documentedPreToolUse('Bash', { command: 'cat C:/Users/someone/secrets.txt' }, 'c2'),
      space.env,
    );
    await send(documentedSessionEnd(), space.env);

    const sessions = await safeReaddir(path.join(space.stateDir, 'sessions'));
    const files = [
      space.summaryFile,
      ...sessions.map((entry) => path.join(space.stateDir, 'sessions', entry)),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      for (const secret of secrets) {
        expect(contents, `${secret} in ${path.basename(file)}`).not.toContain(secret);
      }
    }

    // And the two shell reads of the same file are still recognized as a repeat.
    const summaries = await readSummaryLines(space.summaryFile);
    const reads = (summaries[0] as Record<string, unknown>)['reads'] as Record<string, number>;
    expect(reads['identifiedRequests']).toBe(2);
    expect(reads['distinctTargets']).toBe(2);
  });
});

describe('entry wiring', () => {
  it('is the file the shipped example configuration points at', () => {
    expect(ENTRY_PATH.endsWith(path.join('dist', 'entry.js'))).toBe(true);
  });

  it('imports without running anything', async () => {
    const module = await import('../src/entry.js');
    expect(typeof module.runEntry).toBe('function');
    expect(typeof module.isDirectEntry).toBe('function');
  });
});
