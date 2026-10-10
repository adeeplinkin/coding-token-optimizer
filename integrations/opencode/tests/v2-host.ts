import type {
  ObserverDiagnostic,
  ObserverOptions,
  OpenCodeObserver,
  OpenCodeV2PluginContext,
  OpenCodeV2Registration,
  OpenCodeV2ToolHookSpec,
} from '../src/index.js';
import { IMPLEMENTED_V2_TOOL_HOOKS, createOpenCodeObserverV2 } from '../src/index.js';

/**
 * A minimal OpenCode **V2** host.
 *
 * Stage 1G's tests and its live harness both delivered events straight to the
 * observer's V1-shaped `event` hook, which meant the adapter's own V2 event
 * normaliser was never exercised. Stage 1H's live run then showed the
 * consequence: every V2 event arrived empty. This host closes that gap — it
 * implements only the V2 capabilities the adapter registers on, and pushes raw
 * *runtime-shaped* envelopes (`{ id, created, type, data }`) through the same
 * `ctx.event.subscribe()` iterable the real server uses.
 *
 * It is deliberately strict about being a host and not a mock: the adapter's
 * `setup` is called exactly as V2 calls it, tool hooks are invoked as the host
 * invokes them, and nothing is stubbed inside the observer.
 */
export interface V2Host {
  readonly observer: OpenCodeObserver;
  /** Re-run the adapter's `setup` (a no-op after the first call, as in V2). */
  readonly setup: (options?: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Diagnostics the observer raised, in order. */
  readonly diagnostics: readonly ObserverDiagnostic[];
  /** Deliver one raw server event as the host would iterate it. */
  readonly push: (event: unknown) => void;
  /** Invoke a registered tool hook by name, as the host's tool pipeline would. */
  readonly tool: (name: string, payload: unknown) => Promise<void>;
  /** Names of the tool hooks the adapter actually registered. */
  readonly registeredHooks: () => readonly string[];
  /** Whether the adapter aborted its event subscription. */
  readonly aborted: () => boolean;
  /** Wait until every pushed event has been processed by the observer. */
  readonly settle: () => Promise<void>;
  /** Run the adapter's cleanup, as V2 unload does. */
  readonly close: () => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Poll a predicate until it holds or the deadline passes. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await delay(1);
  }
}

export async function createV2Host(options: ObserverOptions = {}): Promise<V2Host> {
  const created = createOpenCodeObserverV2(options);
  const diagnostics: ObserverDiagnostic[] = [];
  const callbacks = new Map<string, (event: unknown) => unknown>();
  const buffer: unknown[] = [];
  let closed = false;
  let aborted = false;
  let wake: (() => void) | undefined;
  let pushed = 0;

  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };

  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          for (;;) {
            if (buffer.length > 0) {
              return { done: false, value: buffer.shift() };
            }
            if (closed) {
              return { done: true, value: undefined };
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
    },
  };

  // Typed against the adapter's own V2 contract, so a change to that contract
  // fails `npm run typecheck` here instead of silently diverging from the host.
  const hook = async <Name extends keyof OpenCodeV2ToolHookSpec>(
    name: Name,
    callback: (event: OpenCodeV2ToolHookSpec[Name]) => Promise<void> | void,
  ): Promise<OpenCodeV2Registration> => {
    callbacks.set(name, callback as unknown as (event: unknown) => unknown);
    return {
      dispose: async () => {
        callbacks.delete(name);
      },
    };
  };

  const context: OpenCodeV2PluginContext = {
    tool: { hook },
    event: {
      subscribe: (subscribeOptions?: { readonly signal?: AbortSignal }) => {
        subscribeOptions?.signal?.addEventListener('abort', () => {
          aborted = true;
          closed = true;
          notify();
        });
        return iterable;
      },
    },
  };

  let cleanup: (() => Promise<void> | void) | undefined;

  const setup = async (pluginOptions: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    cleanup = (await created.plugin.setup({ ...context, options: pluginOptions })) ?? undefined;
    // The adapter registers tool hooks without blocking `setup`; wait for them so
    // a test can invoke them immediately afterwards.
    await waitUntil(() => callbacks.size >= IMPLEMENTED_V2_TOOL_HOOKS.length || aborted);
  };

  // A host always runs `setup` before it can deliver anything, so the harness does
  // the same rather than leaving it to each test to remember.
  await setup();

  return {
    observer: created.observer,
    setup,
    diagnostics,
    push(event) {
      pushed += 1;
      buffer.push(event);
      notify();
    },
    async tool(name, payload) {
      const callback = callbacks.get(name);
      if (callback === undefined) {
        throw new Error(`the adapter did not register ${name}`);
      }
      await callback(payload);
    },
    registeredHooks: () => [...callbacks.keys()],
    aborted: () => aborted,
    async settle() {
      await waitUntil(
        () => created.observer.getSnapshot().eventsObserved >= pushed || aborted,
      );
      // One more tick so any awaited continuation inside the loop lands.
      await delay(2);
    },
    async close() {
      closed = true;
      notify();
      await cleanup?.();
    },
  };
}
