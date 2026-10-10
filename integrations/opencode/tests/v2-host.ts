import type {
  ObserverDiagnostic,
  ObserverOptions,
  OpenCodeObserver,
  OpenCodeV2LocationInfo,
  OpenCodeV2PluginContext,
  OpenCodeV2Registration,
  OpenCodeV2SessionCreatedData,
  OpenCodeV2SessionDeletedData,
  OpenCodeV2SessionDomain,
  OpenCodeV2SessionHookSpec,
  OpenCodeV2SessionMovedData,
  OpenCodeV2ToolHookSpec,
} from '../src/index.js';
import { IMPLEMENTED_V2_TOOL_HOOKS, createOpenCodeObserverV2 } from '../src/index.js';
import { fnv1aHex } from './helpers.js';

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
  /** Invoke a registered session hook by name, as the host's request assembler would. */
  readonly session: (name: string, payload: unknown) => Promise<void>;
  /** Names of the tool hooks the adapter actually registered. */
  readonly registeredHooks: () => readonly string[];
  /** Names of the session hooks the adapter actually registered. */
  readonly registeredSessionHooks: () => readonly string[];
  /** Whether the adapter aborted its event subscription. */
  readonly aborted: () => boolean;
  /** Wait until every pushed event has been processed by the observer. */
  readonly settle: () => Promise<void>;
  /** Run the adapter's cleanup, as V2 unload does. */
  readonly close: () => Promise<void>;
}

/** What the fake host declares about itself beyond the observer options. */
export interface V2HostEnvironment {
  /**
   * The host's own `ctx.location` (`Location.Info`). `undefined` simulates a host
   * that declares no location at all, which is the case every summary must
   * survive as "project unverified".
   */
  readonly location?: unknown;
  /** Options the host passes as `ctx.options` on the first `setup` call. */
  readonly pluginOptions?: Readonly<Record<string, unknown>>;
  /**
   * Simulate a host that exposes no `ctx.session` at all. Off by default: the
   * real 2.0.24 context carries the session domain.
   */
  readonly omitSessionDomain?: boolean;
}

/** A runtime-shaped V2 envelope, exactly as the 2.0.24 server delivers it. */
export function v2Envelope(type: string, data: unknown): Record<string, unknown> {
  return { id: 'evt_1', created: 1_700_000_000_000, type, data };
}

/**
 * A `session.created` payload in the verified `@opencode/schema@2.0.24` shape.
 *
 * Defaults describe a synthetic project so assertions can check the scope gate
 * without ever touching a real path.
 */
export function sessionCreatedData(
  overrides: OpenCodeV2SessionCreatedData = {},
): Record<string, unknown> {
  return {
    sessionID: 'ses_created',
    projectID: 'prj_created',
    location: { directory: 'C:\\synthetic\\project' },
    slug: 'synthetic-session',
    version: '1',
    ...overrides,
  };
}

/** A `session.deleted` payload in the verified shape: the id, nothing else. */
export function sessionDeletedData(
  overrides: OpenCodeV2SessionDeletedData = {},
): Record<string, unknown> {
  return { sessionID: 'ses_created', ...overrides };
}

/** A `session.moved` payload in the verified shape. */
export function sessionMovedData(
  overrides: OpenCodeV2SessionMovedData = {},
): Record<string, unknown> {
  return {
    sessionID: 'ses_created',
    projectID: 'prj_created',
    location: { directory: 'C:\\synthetic\\project' },
    ...overrides,
  };
}

/**
 * A `session.usage.updated` payload in the verified shape.
 *
 * The numbers are the same ones Stage 1H observed live, so a test can pin an
 * exact value and still be reading a realistic payload.
 */
export function v2UsageData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionID: 'ses_host',
    cost: 0.02,
    tokens: { input: 368, output: 75, reasoning: 91, cache: { read: 10496, write: 0 } },
    ...overrides,
  };
}

/** A synthetic `Location.Info` for the given project. */
export function projectLocation(directory: string, projectId: string): OpenCodeV2LocationInfo {
  return {
    directory,
    project: { id: projectId, directory, canonical: directory },
  };
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

export async function createV2Host(
  options: ObserverOptions = {},
  environment: V2HostEnvironment = {},
): Promise<V2Host> {
  const diagnostics: ObserverDiagnostic[] = [];
  const created = createOpenCodeObserverV2({
    // Defaults here keep tests deterministic and isolated: an explicit empty
    // environment stops a developer's real environment from enabling a summary
    // file or disabling the observer inside a test, and a fixed hasher keeps read
    // and project identities reproducible.
    env: {},
    hash: fnv1aHex,
    ...options,
    // The host collects diagnostics itself: a test asserting on observer behaviour
    // needs to see what the observer reported, and a caller-supplied callback is
    // still honoured. Stage 1I's tests found this wire was missing.
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
      options.onDiagnostic?.(diagnostic);
    },
  });
  const callbacks = new Map<string, (event: unknown) => unknown>();
  const sessionCallbacks = new Map<string, (context: unknown) => unknown>();
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

  // The real 2.0.24 host exposes `ctx.session`; the session hook is only
  // registered by the adapter when Safe Mode M1 observation is enabled.
  const sessionHook = async <Name extends keyof OpenCodeV2SessionHookSpec>(
    name: Name,
    callback: (context: OpenCodeV2SessionHookSpec[Name]) => Promise<void> | void,
  ): Promise<OpenCodeV2Registration> => {
    sessionCallbacks.set(name, callback as unknown as (context: unknown) => unknown);
    return {
      dispose: async () => {
        sessionCallbacks.delete(name);
      },
    };
  };
  const sessionDomain: OpenCodeV2SessionDomain = { hook: sessionHook };

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
    ...(environment.omitSessionDomain === true ? {} : { session: sessionDomain }),
    // A host that declares no location is simulated by omitting the member
    // entirely, exactly as `exactOptionalPropertyTypes` models the real contract.
    ...(environment.location === undefined
      ? {}
      : { location: environment.location as OpenCodeV2LocationInfo }),
  };

  let cleanup: (() => Promise<void> | void) | undefined;

  const setup = async (pluginOptions: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    cleanup = (await created.plugin.setup({ ...context, options: pluginOptions })) ?? undefined;
    // The adapter registers tool hooks without blocking `setup`; wait for them so
    // a test can invoke them immediately afterwards.
    await waitUntil(() => callbacks.size >= IMPLEMENTED_V2_TOOL_HOOKS.length || aborted);
    // Safe Mode observation is registered only when opted in; wait for it so a
    // test can deliver a request immediately. A host without the domain cannot
    // register it, and the adapter reports that instead.
    if (created.observer.isSafeModeObserving() && environment.omitSessionDomain !== true) {
      await waitUntil(() => sessionCallbacks.has('context') || aborted);
    }
  };

  // A host always runs `setup` before it can deliver anything, so the harness does
  // the same rather than leaving it to each test to remember.
  await setup(environment.pluginOptions ?? {});

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
    async session(name, payload) {
      const callback = sessionCallbacks.get(name);
      if (callback === undefined) {
        throw new Error(`the adapter did not register session hook ${name}`);
      }
      await callback(payload);
    },
    registeredHooks: () => [...callbacks.keys()],
    registeredSessionHooks: () => [...sessionCallbacks.keys()],
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
