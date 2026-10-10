import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleHookPayload } from '../src/handler.js';
import {
  CODEX_OBSERVER_DISABLE_ENV_VAR,
  CODEX_OBSERVER_SUMMARY_FILE_ENV_VAR,
  parseJournalContents,
  sessionPaths,
  type CodexSessionObservationSummary,
  type HandleOptions,
  type HandleResult,
} from '../src/index.js';
import {
  documentedPostToolUse,
  documentedPreToolUse,
  documentedSessionEnd,
  documentedSessionStart,
  documentedUserPromptSubmit,
} from './fixtures/codex-hooks.contract.js';
import { createFakeClock, temporaryDirectory } from './helpers.js';

interface Harness {
  readonly options: HandleOptions;
  readonly summaries: CodexSessionObservationSummary[];
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly send: (payload: unknown) => Promise<HandleResult>;
  readonly endSession: (sessionId?: string) => Promise<CodexSessionObservationSummary>;
  /** Flush the session that carries no host-reported id. */
  readonly endUnattributed: () => Promise<CodexSessionObservationSummary>;
}

async function createHarness(
  overrides: Partial<HandleOptions> = {},
  summaryFile?: string,
): Promise<Harness> {
  const stateDir = overrides.stateDir ?? (await temporaryDirectory());
  const clock = createFakeClock();
  const summaries: CodexSessionObservationSummary[] = [];
  const options: HandleOptions = {
    env: {},
    stateDir,
    now: clock.now,
    // Summaries always land in this array unless a test replaces the sink, so
    // session flushing is observable without configuring a file.
    sink: async (summary) => {
      summaries.push(summary);
    },
    ...overrides,
  };
  void summaryFile;

  const send = (payload: unknown): Promise<HandleResult> => handleHookPayload(payload, options);

  return {
    options,
    summaries,
    clock,
    send,
    endSession: async (sessionId = 'thr_123') => {
      await send(documentedSessionEnd(sessionId));
      const summary = summaries[summaries.length - 1];
      expect(summary, 'expected the SessionEnd to flush a summary').toBeDefined();
      return summary as CodexSessionObservationSummary;
    },
    endUnattributed: async () => {
      await send({ hook_event_name: 'SessionEnd' });
      const summary = summaries[summaries.length - 1];
      expect(summary, 'expected the unattributed SessionEnd to flush a summary').toBeDefined();
      return summary as CodexSessionObservationSummary;
    },
  };
}

/** List a directory, treating "not there" as empty. */
async function safeReaddir(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

describe('disabled mode', () => {
  it('records nothing and writes no state when the environment disables it', async () => {
    const stateDir = await temporaryDirectory();
    const harness = await createHarness({
      stateDir,
      env: { [CODEX_OBSERVER_DISABLE_ENV_VAR]: 'off' },
    });

    const result = await harness.send(documentedPreToolUse('Bash', { command: 'cat a.md' }));
    expect(result.disabled).toBe(true);
    expect(result.recorded).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('observer-disabled');
    expect(await safeReaddir(stateDir)).toEqual([]);
  });

  it('accepts every documented disable spelling', async () => {
    for (const value of ['off', 'false', '0', 'no', 'disabled', ' OFF ']) {
      const harness = await createHarness({ env: { [CODEX_OBSERVER_DISABLE_ENV_VAR]: value } });
      const result = await harness.send(documentedSessionStart());
      expect(result.disabled, value).toBe(true);
    }
  });

  it('enables observation for an unusable disable value', async () => {
    const harness = await createHarness({ env: { [CODEX_OBSERVER_DISABLE_ENV_VAR]: 'maybe' } });
    const result = await harness.send(documentedSessionStart());
    expect(result.disabled).toBe(false);
    expect(result.recorded).toBe(true);
  });
});

describe('tool observation', () => {
  it('counts a correlated tool call and reports it in the summary', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send(documentedUserPromptSubmit('read the file'));
    await harness.send(documentedPreToolUse('Bash', { command: 'cat notes.md' }, 'c1'));
    await harness.send(
      documentedPostToolUse('Bash', { command: 'cat notes.md' }, { output: 'notes' }, 'c1'),
    );
    const summary = await harness.endSession();

    expect(summary.counts.toolStartsObserved).toBe(1);
    expect(summary.counts.toolCompletionsObserved).toBe(1);
    expect(summary.counts.correlatedCompletions).toBe(1);
    expect(summary.counts.promptsSubmitted).toBe(1);
    expect(summary.counts.sessionStarts).toBe(1);
    expect(summary.counts.sessionEnds).toBe(1);
    expect(summary.toolFrequency).toEqual([{ tool: 'Bash', started: 1, completed: 1 }]);
    expect(summary.sessionId).toBe('thr_123');
    expect(summary.sessionIdentity).toBe('reported');
  });

  it('records the response kind but never the response', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send(
      documentedPostToolUse('Bash', { command: 'cat a.md' }, 'SECRET-OUTPUT', 'c1'),
    );
    const summary = await harness.endSession();
    expect(JSON.stringify(summary)).not.toContain('SECRET-OUTPUT');
  });

  it('ignores a duplicate start for the same call id', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send(documentedPreToolUse('Bash', { command: 'cat a.md' }, 'c1'));
    await harness.send(documentedPreToolUse('Bash', { command: 'cat a.md' }, 'c1'));
    const summary = await harness.endSession();

    expect(summary.counts.toolStartsObserved).toBe(2);
    expect(summary.counts.duplicateStartsIgnored).toBe(1);
    expect(summary.counts.pendingCalls).toBe(1);
  });

  it('ignores a duplicate completion for the same call id', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send(documentedPreToolUse('Bash', { command: 'cat a.md' }, 'c1'));
    await harness.send(documentedPostToolUse('Bash', { command: 'cat a.md' }, {}, 'c1'));
    await harness.send(documentedPostToolUse('Bash', { command: 'cat a.md' }, {}, 'c1'));
    const summary = await harness.endSession();

    expect(summary.counts.correlatedCompletions).toBe(1);
    expect(summary.counts.duplicateCompletionsIgnored).toBe(1);
  });

  it('counts a completion with no observed start as uncorrelated', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send(documentedPostToolUse('Bash', { command: 'cat a.md' }, {}, 'never-seen'));
    await harness.send(documentedPostToolUse('Bash', { command: 'cat a.md' }, {}, undefined));
    const summary = await harness.endSession();

    expect(summary.counts.uncorrelatedCompletions).toBe(2);
  });

  it('counts permission, compaction, subagent, stop and interrupt events', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send({ hook_event_name: 'PermissionRequest', session_id: 'thr_123', tool_name: 'Bash' });
    await harness.send({ hook_event_name: 'PreCompact', session_id: 'thr_123', trigger: 'auto' });
    await harness.send({ hook_event_name: 'PostCompact', session_id: 'thr_123', trigger: 'auto' });
    await harness.send({ hook_event_name: 'SubagentStart', session_id: 'thr_123', agent_type: 'general' });
    await harness.send({ hook_event_name: 'SubagentStop', session_id: 'thr_123', agent_type: 'general' });
    await harness.send({ hook_event_name: 'Stop', session_id: 'thr_123', stop_hook_active: false });
    await harness.send({ hook_event_name: 'Interrupt', session_id: 'thr_123' });
    const summary = await harness.endSession();

    expect(summary.counts.permissionRequests).toBe(1);
    expect(summary.counts.compactionEvents).toBe(2);
    expect(summary.counts.subagentStarts).toBe(1);
    expect(summary.counts.subagentStops).toBe(1);
    expect(summary.counts.stopEvents).toBe(1);
    expect(summary.counts.interruptEvents).toBe(1);
  });

  it('counts an unobserved event as ignored rather than guessing', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send({ hook_event_name: 'FutureEvent', session_id: 'thr_123' });
    const summary = await harness.endSession();
    expect(summary.counts.hookEventsIgnored).toBe(1);
  });

  it('counts an unusable payload and reports it immediately', async () => {
    const harness = await createHarness();
    const result = await harness.send('not json at all');
    expect(result.diagnostics.map((entry) => entry.code)).toContain('hook-input-unusable');

    // A payload with no event name lands in the unattributed session, and its
    // own SessionEnd (also without a session id) flushes that same session.
    const summary = await harness.endUnattributed();
    expect(summary.counts.unusablePayloads).toBeGreaterThanOrEqual(1);
  });
});

describe('repeated reads', () => {
  it('detects repeated reads of one file across hook invocations', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    for (const callId of ['c1', 'c2', 'c3']) {
      await harness.send(documentedPreToolUse('Bash', { command: 'cat src/app.ts' }, callId));
      await harness.send(
        documentedPostToolUse('Bash', { command: 'cat src/app.ts' }, {}, callId),
      );
    }
    const summary = await harness.endSession();

    expect(summary.reads.identifiedRequests).toBe(3);
    expect(summary.reads.distinctTargets).toBe(1);
    expect(summary.reads.repeatedTargets).toBe(1);
    expect(summary.reads.repeatedRequests).toBe(2);
    expect(summary.measurements.repeatedFileReads).toEqual({ evidence: 'calculated', value: 2 });
  });

  it('keeps distinct files and distinct ranges apart', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send(documentedPreToolUse('mcp__fs__read_file', { path: 'a.ts' }, 'c1'));
    await harness.send(documentedPreToolUse('mcp__fs__read_file', { path: 'b.ts' }, 'c2'));
    await harness.send(
      documentedPreToolUse('mcp__fs__read_file', { path: 'a.ts', offset: 10, limit: 5 }, 'c3'),
    );
    const summary = await harness.endSession();

    expect(summary.reads.distinctTargets).toBe(3);
    expect(summary.reads.repeatedTargets).toBe(0);
    expect(summary.reads.repeatedRequests).toBe(0);
  });

  it('counts unidentified read-like calls without inventing a file', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    await harness.send(documentedPreToolUse('Bash', { command: 'cat a.txt b.txt' }, 'c1'));
    await harness.send(documentedPreToolUse('read_file', { start_line: 1, path: 'a.ts' }, 'c2'));
    const summary = await harness.endSession();

    expect(summary.reads.identifiedRequests).toBe(0);
    expect(summary.reads.unidentifiedRequests).toBe(2);
    expect(summary.reads.distinctTargets).toBe(0);
  });
});

describe('session and project attribution', () => {
  it('keeps independent sessions apart in one state directory', async () => {
    const stateDir = await temporaryDirectory();
    const harness = await createHarness({ stateDir });

    await harness.send(documentedSessionStart('startup', 'thr_a'));
    await harness.send(documentedPreToolUse('Bash', { command: 'cat shared.ts' }, 'a1', 'thr_a'));
    await harness.send(documentedSessionStart('startup', 'thr_b'));
    await harness.send(documentedPreToolUse('Bash', { command: 'cat shared.ts' }, 'b1', 'thr_b'));
    await harness.send(documentedPreToolUse('Bash', { command: 'cat shared.ts' }, 'b2', 'thr_b'));

    await harness.endSession('thr_a');
    const sessionA = harness.summaries[harness.summaries.length - 1];
    await harness.endSession('thr_b');
    const sessionB = harness.summaries[harness.summaries.length - 1];

    expect(sessionA?.sessionId).toBe('thr_a');
    expect(sessionA?.counts.toolStartsObserved).toBe(1);
    expect(sessionA?.reads.repeatedRequests).toBe(0);
    expect(sessionB?.sessionId).toBe('thr_b');
    expect(sessionB?.counts.toolStartsObserved).toBe(2);
    expect(sessionB?.reads.repeatedRequests).toBe(1);

    // Each session's state is released by its own SessionEnd.
    expect(await safeReaddir(path.join(stateDir, 'sessions'))).toEqual([]);
  });

  it('reports events without a session id as unattributed rather than guessed', async () => {
    const harness = await createHarness();
    await harness.send({ hook_event_name: 'SessionStart', cwd: 'C:\\repo' });
    await harness.send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat a.md' } });
    // No session id anywhere, including the flush: nothing is guessed.
    const summary = await harness.endUnattributed();

    expect(summary.sessionId).toBe('unknown');
    expect(summary.sessionIdentity).toBe('unknown');
    expect(summary.counts.toolStartsObserved).toBe(1);
    expect(summary.notes.join(' ')).toContain('no usable session identifier');
  });

  it('records a working directory only as a hash and claims no project', async () => {
    const harness = await createHarness();
    await harness.send(documentedSessionStart());
    const summary = await harness.endSession();

    expect(summary.project.basis).toBe('runtime-declared');
    expect(summary.project.verification).toBe('unverifiable');
    expect(summary.project.directoryHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(summary)).not.toContain('C:\\\\repo');
  });

  it('reports the project as unavailable when the host sent no directory', async () => {
    const harness = await createHarness();
    await harness.send({ hook_event_name: 'SessionStart', session_id: 'thr_1' });
    const summary = await harness.endSession('thr_1');
    expect(summary.project.basis).toBe('unavailable');
    expect(summary.project.directoryHash).toBeUndefined();
  });
});

describe('privacy', () => {
  it('never persists prompts, tool input, tool output, paths or credentials', async () => {
    const stateDir = await temporaryDirectory();
    const summaryFile = path.join(stateDir, 'summary.jsonl');
    // No injected sink: the environment switch is exercised, so the real file
    // sink (the only write path a user can opt into) is what gets tested.
    const harness = await createHarness({
      stateDir,
      env: { [CODEX_OBSERVER_SUMMARY_FILE_ENV_VAR]: summaryFile },
      // No injected sink: the environment switch builds the real file sink that a
      // user would actually enable.
      sink: undefined,
    });
    const secrets = [
      'sk-live-DEADBEEF',
      'someone\\secrets',
      'cat /home/someone/.ssh/id_rsa',
      '/home/someone/.ssh/id_rsa',
    ];

    await harness.send(documentedSessionStart('startup', 'thr_privacy'));
    await harness.send(documentedUserPromptSubmit('deploy with sk-live-DEADBEEF please', 'thr_privacy'));
    await harness.send(
      documentedPreToolUse('Bash', { command: 'cat /home/someone/.ssh/id_rsa' }, 'c1', 'thr_privacy'),
    );
    await harness.send(
      documentedPostToolUse(
        'Bash',
        { command: 'cat /home/someone/.ssh/id_rsa' },
        { output: 'sk-live-DEADBEEF' },
        'c1',
        'thr_privacy',
      ),
    );

    // Inspect the state that exists while the session is live, before the
    // SessionEnd flush releases it.
    const journalText = await readFile(
      sessionPaths(stateDir, 'thr_privacy').journal,
      'utf8',
    );
    for (const secret of secrets) {
      expect(journalText, secret).not.toContain(secret);
    }
    expect(journalText).toContain('"kind":"tool-start"');

    await harness.send(documentedSessionEnd('thr_privacy'));

    const summaryText = await readFile(summaryFile, 'utf8');
    const directoryListing = (await safeReaddir(stateDir)).join(' ');
    for (const secret of secrets) {
      expect(summaryText, secret).not.toContain(secret);
      expect(directoryListing, secret).not.toContain(secret);
    }
    expect(summaryText).toContain('"sessionId":"thr_privacy"');
    expect(summaryText).toContain('"repeatedRequests":0');
  });
});

describe('failure containment', () => {
  it('contains an unusable state directory', async () => {
    const directory = await temporaryDirectory();
    const blocker = path.join(directory, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');

    const harness = await createHarness({ stateDir: path.join(blocker, 'state') });
    const result = await harness.send(documentedSessionStart());

    expect(result.recorded).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('state-unavailable');
  });

  it('contains a failing sink', async () => {
    const harness = await createHarness({
      sink: () => {
        throw new Error('sink exploded');
      },
    });
    await harness.send(documentedSessionStart());
    const result = await harness.send(documentedSessionEnd());

    expect(result.diagnostics.map((entry) => entry.code)).toContain('sink-failed');
    expect(result.stdout).toBe('');
  });

  it('contains a diagnostic consumer that throws', async () => {
    const harness = await createHarness({
      env: { [CODEX_OBSERVER_DISABLE_ENV_VAR]: 'off' },
      onDiagnostic: () => {
        throw new Error('diagnostic consumer exploded');
      },
    });
    await expect(harness.send(documentedSessionStart())).resolves.toBeDefined();
  });

  it('contains a clock that throws', async () => {
    const harness = await createHarness({
      now: () => {
        throw new Error('clock exploded');
      },
      sink: undefined,
    });
    const result = await harness.send(documentedSessionStart());
    expect(result.stdout).toBe('');
  });
});

describe('bounded state', () => {
  it('compacts the journal and keeps counting', async () => {
    const stateDir = await temporaryDirectory();
    const harness = await createHarness({ stateDir, compactionTriggerBytes: 256 });

    await harness.send(documentedSessionStart());
    for (let index = 0; index < 20; index += 1) {
      await harness.send(
        documentedPreToolUse('Bash', { command: 'cat src/one.ts' }, `c${index}`),
      );
    }
    const summary = await harness.endSession();

    expect(summary.journal.compactions).toBeGreaterThan(0);
    expect(summary.counts.toolStartsObserved).toBe(20);
    expect(summary.reads.identifiedRequests).toBe(20);
    expect(summary.reads.repeatedRequests).toBe(19);
  });

  it('drops events and reports it when the journal cannot grow', async () => {
    const harness = await createHarness({ limits: { maxJournalBytes: 1 } });
    await harness.send(documentedSessionStart());
    const result = await harness.send(documentedPreToolUse('Bash', { command: 'cat a.md' }, 'c1'));

    expect(result.recorded).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('journal-capacity-reached');
  });
});

describe('journal contents', () => {
  it('stores one whole JSON record per event', async () => {
    const stateDir = await temporaryDirectory();
    const harness = await createHarness({ stateDir });
    await harness.send(documentedSessionStart());
    await harness.send(documentedPreToolUse('mcp__fs__read_file', { path: 'src/a.ts' }, 'c1'));

    const contents = await readFile(sessionPaths(stateDir, 'thr_123').journal, 'utf8');
    const { records, tornTail } = parseJournalContents(contents);
    expect(tornTail).toBe(false);
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe('session-start');
    expect(records[1]?.kind).toBe('tool-start');
    expect(records[1]?.read).toBeDefined();
    expect(contents).not.toContain('src/a.ts');
  });
});
