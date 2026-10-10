import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DrTokenOpenCodeObserver,
  OpenCodeObserver,
  createOpenCodeObserver,
  createOpenCodeObserverHooks,
  createOpenCodeObserverPlugin,
} from '../src/index.js';
import type { OpenCodeObserverHooks } from '../src/index.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dr-token-opencode-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const context = {
  directory: '/repo',
  worktree: '/repo',
  client: {},
  project: {},
  serverUrl: new URL('http://127.0.0.1:0'),
};

describe('plugin entry point', () => {
  it('exports a ready-to-load plugin function', async () => {
    expect(typeof DrTokenOpenCodeObserver).toBe('function');

    const hooks = await DrTokenOpenCodeObserver(context);
    expect(Object.keys(hooks).sort()).toEqual([
      'dispose',
      'event',
      'tool.execute.after',
      'tool.execute.before',
    ]);
  });

  it('returns a stable hooks object across invocations', async () => {
    const created = createOpenCodeObserver({ env: {} });
    const first = await created.plugin(context);
    const second = await created.plugin(context);

    expect(second).toBe(first);
  });

  it('exposes the observer for inspection', async () => {
    const created = createOpenCodeObserver({ env: {} });
    await created.plugin(context);

    expect(created.observer.getSnapshot().sessionCount).toBe(0);
    expect(typeof created.observer.getSummaries).toBe('function');
  });

  it('works when OpenCode passes no options at all', async () => {
    const hooks = await createOpenCodeObserverPlugin({ env: {} })(context);
    await hooks.event({ event: { type: 'session.idle', properties: {} } });

    expect(Object.keys(hooks)).toHaveLength(4);
  });
});

describe('plugin options from opencode.json', () => {
  it('honours an explicit enabled flag', async () => {
    const created = createOpenCodeObserver({ env: {} });
    const hooks = await created.plugin(context, { enabled: false });

    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1', callID: 'c1' },
      { args: {} },
    );

    expect(created.observer.isEnabled()).toBe(false);
    expect(created.observer.getSnapshot().sessionCount).toBe(0);
  });

  it('reports an unusable option value without failing', async () => {
    const diagnostics: string[] = [];
    const created = createOpenCodeObserver({
      env: {},
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    const hooks = await created.plugin(context, { enabled: 'yes' });

    await hooks.event({ event: { type: 'session.idle', properties: {} } });
    expect(diagnostics).toContain('plugin-options-ignored');
    expect(created.observer.isEnabled()).toBe(true);
  });

  it('writes an opt-in summary file when the plugin option asks for one', async () => {
    const directory = await temporaryDirectory();
    const summaryFile = path.join(directory, 'observations.jsonl');
    const created = createOpenCodeObserver({ env: {} });
    const hooks = await created.plugin(context, { summaryFile });

    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1', callID: 'c1' },
      { args: {} },
    );
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });

    const written = await readFile(summaryFile, 'utf8');
    expect(written.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(written.trim())).toMatchObject({ sessionId: 'ses_1' });
  });

  it('never replaces a sink configured in code', async () => {
    const captured: unknown[] = [];
    const created = createOpenCodeObserver({
      env: {},
      sink: (summary) => {
        captured.push(summary);
      },
    });
    const hooks = await created.plugin(context, { summaryFile: 'ignored.jsonl' });

    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1', callID: 'c1' },
      { args: {} },
    );
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });

    expect(captured).toHaveLength(1);
  });

  it('ignores unknown options silently', async () => {
    const created = createOpenCodeObserver({ env: {} });
    await expect(
      created.plugin(context, { somethingElse: true, nested: { a: 1 } }),
    ).resolves.toBeDefined();
  });
});

describe('fail-open containment in the plugin layer', () => {
  function stubObserver(overrides: Partial<Record<string, unknown>>): {
    readonly observer: OpenCodeObserver;
    readonly failures: () => number;
  } {
    let failures = 0;
    const stub = {
      observeToolBefore: () => undefined,
      observeToolAfter: () => undefined,
      observeEvent: () => undefined,
      dispose: () => undefined,
      noteInternalFailure: () => {
        failures += 1;
      },
      ...overrides,
    };
    return {
      observer: stub as unknown as OpenCodeObserver,
      failures: () => failures,
    };
  }

  it('contains a synchronous throw from a hook body', async () => {
    const stub = stubObserver({
      observeToolBefore: () => {
        throw new Error('observer exploded');
      },
    });
    const hooks: OpenCodeObserverHooks = createOpenCodeObserverHooks(stub.observer);

    await expect(
      hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} }),
    ).resolves.toBeUndefined();
    expect(stub.failures()).toBe(1);
  });

  it('contains a rejected promise from a hook body', async () => {
    const stub = stubObserver({
      observeEvent: () => Promise.reject(new Error('observer rejected')),
    });
    const hooks = createOpenCodeObserverHooks(stub.observer);

    await expect(hooks.event({ event: { type: 'session.idle' } })).resolves.toBeUndefined();
    expect(stub.failures()).toBe(1);
  });

  it('contains a failing failure reporter', async () => {
    const stub = stubObserver({
      observeToolAfter: () => {
        throw new Error('observer exploded');
      },
      noteInternalFailure: () => {
        throw new Error('reporter exploded');
      },
    });
    const hooks = createOpenCodeObserverHooks(stub.observer);

    await expect(
      hooks['tool.execute.after'](
        { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
        { title: '', output: '', metadata: {} },
      ),
    ).resolves.toBeUndefined();
  });

  it('contains a failure while applying plugin options', async () => {
    const created = createOpenCodeObserver({ env: {} });
    const original = OpenCodeObserver.prototype.applyPluginOptions;
    OpenCodeObserver.prototype.applyPluginOptions = () => {
      throw new Error('options exploded');
    };
    try {
      const hooks = await created.plugin(context, { enabled: false });
      expect(Object.keys(hooks)).toHaveLength(4);
      expect(created.observer.getSnapshot().internalErrors).toBe(1);
    } finally {
      OpenCodeObserver.prototype.applyPluginOptions = original;
    }
  });
});
