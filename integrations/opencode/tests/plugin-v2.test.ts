import { describe, expect, it } from 'vitest';
import {
  DrTokenOpenCodeObserverV2,
  asRuntimeEvent,
  createOpenCodeObserverV2,
  toObservedRunMetrics,
  toV1ToolAfter,
  toV1ToolBefore,
} from '../src/index.js';
import type {
  OpenCodeV2Plugin,
  OpenCodeV2Registration,
  OpenCodeV2ToolExecuteAfterEvent,
  OpenCodeV2ToolExecuteBeforeEvent,
  SessionObservationSummary,
} from '../src/index.js';

/**
 * A minimal, faithful stand-in for the V2 host.
 *
 * It records what the adapter asked for, hands back registrations it can revoke,
 * and lets a test drive the registered callbacks and the event stream by hand.
 */
interface FakeHost {
  readonly ctx: {
    tool: {
      // `any` keeps the fake host assignable to the published generic `Hooks<Spec>`
      // signature without changing what the adapter is allowed to call.
      hook: (
        name: string,
        callback: (event: any) => Promise<void> | void,
      ) => Promise<OpenCodeV2Registration>;
    };
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
    };
    options: Readonly<Record<string, unknown>>;
  };
  readonly registered: string[];
  readonly disposed: string[];
  readonly aborted: { count: number };
  emit(name: 'execute.before' | 'execute.after', event: unknown): Promise<void>;
  pushEvent(event: unknown): void;
}

function createFakeHost(
  options: Readonly<Record<string, unknown>> = {},
  capabilities: { tool?: boolean; event?: boolean } = {},
): FakeHost {
  const callbacks = new Map<string, (event: any) => Promise<void> | void>();
  const registered: string[] = [];
  const disposed: string[] = [];
  const queue: unknown[] = [];
  const waiters: ((value: IteratorResult<unknown>) => void)[] = [];
  const aborted = { count: 0 };

  const tool = {
    hook: async (
      name: string,
      callback: (event: any) => Promise<void> | void,
    ): Promise<OpenCodeV2Registration> => {
      registered.push(name);
      callbacks.set(name, callback);
      return {
        dispose: async () => {
          disposed.push(name);
          callbacks.delete(name);
        },
      };
    },
  };

  const event = {
    subscribe: (subscribeOptions?: { signal?: AbortSignal }): AsyncIterable<unknown> => {
      subscribeOptions?.signal?.addEventListener('abort', () => {
        aborted.count += 1;
        while (waiters.length > 0) {
          waiters.shift()?.({ done: true, value: undefined });
        }
      });
      return {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              if (queue.length > 0) {
                return { done: false, value: queue.shift() };
              }
              if (subscribeOptions?.signal?.aborted === true) {
                return { done: true, value: undefined };
              }
              return await new Promise<IteratorResult<unknown>>((resolve) => {
                waiters.push(resolve);
              });
            },
          };
        },
      };
    },
  };

  const ctx: FakeHost['ctx'] = {
    tool,
    event,
    options,
  };

  return {
    ctx: capabilities.tool === false ? { ...ctx, tool: undefined as never } : ctx,
    registered,
    disposed,
    aborted,
    emit: async (name, value) => {
      const callback = callbacks.get(name);
      if (callback === undefined) {
        throw new Error(`no callback registered for ${name}`);
      }
      await callback(value);
    },
    pushEvent: (value) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ done: false, value });
        return;
      }
      queue.push(value);
    },
  };
}

function beforeEvent(overrides: Partial<OpenCodeV2ToolExecuteBeforeEvent> = {}): OpenCodeV2ToolExecuteBeforeEvent {
  return {
    tool: 'read',
    sessionID: 'ses_1',
    agent: 'build',
    messageID: 'msg_1',
    id: 'call_1',
    input: { filePath: '/tmp/synthetic/notes.txt' },
    ...overrides,
  };
}

function afterEvent(
  overrides: Partial<OpenCodeV2ToolExecuteAfterEvent> = {},
): OpenCodeV2ToolExecuteAfterEvent {
  return {
    tool: 'read',
    sessionID: 'ses_1',
    agent: 'build',
    messageID: 'msg_1',
    id: 'call_1',
    input: { filePath: '/tmp/synthetic/notes.txt' },
    status: 'completed',
    result: { title: 'notes.txt', output: 'synth', metadata: {} },
    ...overrides,
  } as OpenCodeV2ToolExecuteAfterEvent;
}

/** Boot the adapter against a fake host and return both. */
async function boot(
  options: Parameters<typeof createOpenCodeObserverV2>[0] = { env: {} },
  capabilities: { tool?: boolean; event?: boolean } = {},
): Promise<{ host: FakeHost; plugin: OpenCodeV2Plugin; cleanup: () => Promise<void> | void; summary: (id: string) => SessionObservationSummary | undefined }> {
  const { plugin, observer } = createOpenCodeObserverV2(options);
  const host = createFakeHost({}, capabilities);
  const cleanup = await plugin.setup(host.ctx);
  return {
    host,
    plugin,
    cleanup: async () => {
      await cleanup?.();
    },
    summary: (id) => observer.getSummary(id),
  };
}

describe('OpenCode V2 adapter', () => {
  it('initialises through setup and registers both tool hooks', async () => {
    const { host } = await boot();

    expect(host.registered.sort()).toEqual(['execute.after', 'execute.before']);
  });

  it('observes a tool-call start and its completion, and correlates them', async () => {
    const { host, summary } = await boot();

    await host.emit('execute.before', beforeEvent());
    await host.emit('execute.after', afterEvent());

    const observed = summary('ses_1');
    expect(observed?.counts.toolStartsObserved).toBe(1);
    expect(observed?.counts.toolCompletionsObserved).toBe(1);
    expect(observed?.counts.correlatedCompletions).toBe(1);
    expect(observed?.counts.pendingCalls).toBe(0);
    expect(observed?.toolFrequency).toEqual([{ tool: 'read', started: 1, completed: 1 }]);
  });

  it('records a second identical read as a repeated read and keeps it calculated', async () => {
    const { host, summary } = await boot();

    for (const id of ['call_1', 'call_2']) {
      await host.emit('execute.before', beforeEvent({ id }));
      await host.emit('execute.after', afterEvent({ id }));
    }

    const observed = summary('ses_1');
    expect(observed?.reads.requests).toBe(2);
    expect(observed?.reads.repeatedTargets).toBe(1);
    expect(observed?.reads.repeatedRequests).toBe(1);
    // The aggregate must never be labelled as a direct measurement.
    expect(observed?.measurements.repeatedFileReads.evidence).toBe('calculated');
  });

  it('distinguishes reads of different ranges', async () => {
    const { host, summary } = await boot();

    await host.emit('execute.before', beforeEvent({ id: 'c1', input: { filePath: '/a.txt', offset: 1, limit: 10 } }));
    await host.emit('execute.before', beforeEvent({ id: 'c2', input: { filePath: '/a.txt', offset: 11, limit: 10 } }));

    const observed = summary('ses_1');
    expect(observed?.reads.distinctTargets).toBe(2);
    expect(observed?.reads.repeatedTargets).toBe(0);
  });

  it('ignores duplicate starts and duplicate completions', async () => {
    const { host, summary } = await boot();

    await host.emit('execute.before', beforeEvent());
    await host.emit('execute.before', beforeEvent());
    await host.emit('execute.after', afterEvent());
    await host.emit('execute.after', afterEvent());

    const observed = summary('ses_1');
    expect(observed?.counts.toolStartsObserved).toBe(1);
    expect(observed?.counts.duplicateStartsIgnored).toBe(1);
    expect(observed?.counts.toolCompletionsObserved).toBe(1);
    expect(observed?.counts.duplicateCompletionsIgnored).toBe(1);
  });

  it('keeps separate sessions separate', async () => {
    const { host, summary } = await boot();

    await host.emit('execute.before', beforeEvent({ sessionID: 'ses_1', id: 'c1' }));
    await host.emit('execute.before', beforeEvent({ sessionID: 'ses_2', id: 'c2' }));

    expect(summary('ses_1')?.counts.toolStartsObserved).toBe(1);
    expect(summary('ses_2')?.counts.toolStartsObserved).toBe(1);
  });

  it('does not mutate the V2 hook event it was given', async () => {
    const { host } = await boot();
    const event = beforeEvent();
    const pristine = JSON.parse(JSON.stringify(event));

    await host.emit('execute.before', event);
    await host.emit('execute.after', afterEvent());

    expect(JSON.parse(JSON.stringify(event))).toEqual(pristine);
    expect(Object.keys(event).sort()).toEqual(Object.keys(pristine).sort());
  });

  it('honours the bypass switch from plugin options', async () => {
    const { plugin, host, summary } = await boot({ env: {} });
    const observer = createOpenCodeObserverV2({ env: {} });
    const bypassHost = createFakeHost({ enabled: false });
    await observer.plugin.setup(bypassHost.ctx);

    await bypassHost.emit('execute.before', beforeEvent());
    expect(observer.observer.getSummary('ses_1')).toBeUndefined();

    // …and the ordinary host in this test still records, so the switch is what changed.
    expect(plugin.id).toBe(DrTokenOpenCodeObserverV2.id);
    await host.emit('execute.before', beforeEvent());
    expect(summary('ses_1')?.counts.toolStartsObserved).toBe(1);
  });

  it('honours the environment bypass switch', async () => {
    const { host, summary } = await boot({ env: { DR_TOKEN_OPENCODE_OBSERVER: 'off' } });

    await host.emit('execute.before', beforeEvent());

    expect(summary('ses_1')).toBeUndefined();
  });

  it('contains a hook body that throws without reaching the host', async () => {
    const { host, summary } = await boot();

    // A non-object event drives the mapper through its defensive path.
    await expect(host.emit('execute.before', null)).resolves.toBeUndefined();
    await expect(host.emit('execute.after', {})).resolves.toBeUndefined();

    // Nothing usable was recorded, and nothing was invented.
    expect(summary('ses_1')).toBeUndefined();
  });

  it('reports a missing tool capability instead of inventing observations', async () => {
    const { host, summary } = await boot({ env: {} }, { tool: false });

    expect(host.registered).toEqual([]);
    expect(summary('ses_1')).toBeUndefined();
  });

  it('subscribes to events and records a session.idle lifecycle event', async () => {
    const { host, summary } = await boot();

    host.pushEvent({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host.emit('execute.before', beforeEvent());

    expect(summary('ses_1')?.lifecycle.idleEvents).toBeGreaterThanOrEqual(0);
    expect(summary('ses_1')?.counts.toolStartsObserved).toBe(1);
  });

  it('keeps token aggregates calculated and never promotes them to measured', async () => {
    const { host, summary } = await boot();

    await host.emit('execute.before', beforeEvent());
    await host.emit('execute.after', afterEvent());

    const observed = summary('ses_1');
    if (observed === undefined) {
      throw new Error('expected an observation summary');
    }
    // No usage event was delivered, so token fields must be unavailable, and the
    // session total is never derived from overlapping fields.
    expect(observed.measurements.totalTokens.evidence).toBe('unavailable');
    const projected = toObservedRunMetrics(observed);
    expect(projected.toolCalls.evidence).toBe('measured');
    expect(projected.inputTokens.evidence).toBe('unavailable');
    expect(projected.totalTokens.evidence).toBe('unavailable');
  });

  it('labels a V2 run as v2 in the adapter identity', async () => {
    const { host, summary } = await boot();
    await host.emit('execute.before', beforeEvent());

    expect(summary('ses_1')?.adapter.pluginApi).toEqual({
      package: '@opencode/plugin',
      verifiedVersion: '2.0.24',
      line: 'v2',
    });
  });

  it('disposes every registration and aborts the subscription on cleanup', async () => {
    const { host, cleanup } = await boot();
    host.pushEvent({ type: 'session.idle', properties: { sessionID: 'ses_1' } });

    await cleanup();

    expect(host.disposed.sort()).toEqual(['execute.after', 'execute.before']);
    expect(host.aborted.count).toBe(1);
    await expect(host.emit('execute.before', beforeEvent())).rejects.toThrow(/no callback registered/);
  });

  it('is safe to clean up twice', async () => {
    const { cleanup } = await boot();

    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('maps V2 payloads onto the V1-shaped observer input', () => {
    const before = toV1ToolBefore(beforeEvent());
    expect(before.input).toEqual({ tool: 'read', sessionID: 'ses_1', callID: 'call_1' });
    expect(before.output.args).toEqual({ filePath: '/tmp/synthetic/notes.txt' });

    const after = toV1ToolAfter(afterEvent());
    expect(after.input).toEqual({
      tool: 'read',
      sessionID: 'ses_1',
      callID: 'call_1',
      args: { filePath: '/tmp/synthetic/notes.txt' },
    });
    // Tool result content is never passed through.
    expect(after.output).toEqual({ title: '', output: '', metadata: undefined });
  });

  it('normalises an event defensively', () => {
    expect(asRuntimeEvent({ type: 'session.idle', properties: {} })).toEqual({
      type: 'session.idle',
      properties: {},
    });
    expect(asRuntimeEvent({ properties: {} })).toEqual({ properties: {} });
    expect(asRuntimeEvent('nope')).toEqual({});
    expect(asRuntimeEvent(null)).toEqual({});
  });
});
