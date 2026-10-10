import { OpenCodeObserver } from './observer.js';
import type {
  ObserverOptions,
  OpenCodeToolExecuteAfterInput,
  OpenCodeToolExecuteBeforeInput,
} from './types.js';
import {
  IMPLEMENTED_V2_TOOL_HOOKS,
  OBSERVER_V2_PLUGIN_ID,
  OPENCODE_V2_PLUGIN_PACKAGE,
  OPENCODE_V2_PLUGIN_VERIFIED_VERSION,
  defineOpenCodeV2Plugin,
} from './types-v2.js';
import type {
  OpenCodeV2Cleanup,
  OpenCodeV2Event,
  OpenCodeV2EventDomain,
  OpenCodeV2Plugin,
  OpenCodeV2PluginContext,
  OpenCodeV2Registration,
  OpenCodeV2ToolDomain,
  OpenCodeV2ToolExecuteAfterEvent,
  OpenCodeV2ToolExecuteBeforeEvent,
} from './types-v2.js';

/**
 * OpenCode **V2** plugin adapter (Stage 1F).
 *
 * The V1 adapter in `plugin.ts` stays exactly as it was: it is a different
 * contract (`Plugin = (input, options?) => Promise<Hooks>`) and OpenCode's own
 * migration guide states that V1 plugin implementations do not run under V2. This
 * module is a second, independent entry point for the V2 contract
 * (`Plugin.define({ id, setup })`).
 *
 * Everything that decides *what* is observed is shared: this file only translates
 * V2 hook payloads into the shapes the existing, unit-tested `OpenCodeObserver`
 * already accepts. No observation logic is duplicated, and no classification,
 * bound, privacy rule or sink behaviour changes.
 *
 * Observation only. The adapter never writes to `event.tool` or `event.input`, never
 * calls `ctx.tool.transform`, never touches `ctx.storage`, never asks for
 * permissions, and never reads tool results into state. V2 delivers one mutable
 * event object per hook call; nothing here assigns to it.
 *
 * Fail-open. Every hook body is wrapped, and a failure is reported as a
 * content-free diagnostic instead of being thrown into OpenCode. `setup` itself
 * never throws: if a capability is missing the adapter records that and returns a
 * cleanup function instead of failing the host.
 */

/** A plugin factory result that also exposes the observer, for inspection and tests. */
export interface CreatedOpenCodeObserverV2 {
  readonly plugin: OpenCodeV2Plugin;
  readonly observer: OpenCodeObserver;
}

/** Content-free descriptions of the V2 capabilities the adapter needs. */
export const V2_REQUIRED_CAPABILITIES = [
  'tool.hook("execute.before")',
  'tool.hook("execute.after")',
  'event.subscribe()',
] as const;

/**
 * Record that the V2 runtime did not expose a capability the adapter needs.
 *
 * Reported as a content-free diagnostic instead of being invented or silently
 * skipped: a missing capability must be visible in the summary, not guessed at.
 */
function noteMissing(observer: OpenCodeObserver): void {
  try {
    observer.noteUnsupportedCapability();
  } catch {
    // Reporting the problem must never become the problem.
  }
}

/**
 * Normalise an iterated event into the two fields the observer understands.
 *
 * Anything that is not an object with a string `type` is passed through as an
 * event without a type, which the observer records as ignored (`event-ignored`)
 * rather than as a usage reading.
 */
export function asRuntimeEvent(value: unknown): OpenCodeV2Event {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const record = value as { readonly type?: unknown; readonly properties?: unknown };
  // `exactOptionalPropertyTypes` is on: an absent `type` must be omitted, not set
  // to `undefined`.
  return typeof record.type === 'string'
    ? { type: record.type, properties: record.properties }
    : { properties: record.properties };
}

/** Translate a V2 `execute.before` payload into the observer's V1-shaped input. */
export function toV1ToolBefore(input: OpenCodeV2ToolExecuteBeforeEvent): {
  input: OpenCodeToolExecuteBeforeInput;
  output: { args: unknown };
} {
  return {
    // `id` is the V2 tool call id (`Tool.CallID`); it plays the V1 `callID` role, so
    // start/completion correlation keeps working unchanged.
    input: {
      tool: String(input?.tool ?? ''),
      sessionID: String(input?.sessionID ?? ''),
      callID: String(input?.id ?? ''),
    },
    // The arguments are the only thing the observer reads here, and only to identify
    // a read request. The reference is not retained; the path is hashed and dropped.
    output: { args: input?.input },
  };
}

/** Translate a V2 `execute.after` payload into the observer's V1-shaped input. */
export function toV1ToolAfter(input: OpenCodeV2ToolExecuteAfterEvent): {
  input: OpenCodeToolExecuteAfterInput;
  output: { title: string; output: string; metadata: unknown };
} {
  return {
    input: {
      tool: String(input?.tool ?? ''),
      sessionID: String(input?.sessionID ?? ''),
      callID: String(input?.id ?? ''),
      args: input?.input,
    },
    // The observer never reads a tool result: it records the completion only. Empty
    // placeholders make that explicit rather than passing result content through.
    output: { title: '', output: '', metadata: undefined },
  };
}

/**
 * Create an observer plus its V2 plugin definition.
 *
 * `options` are the factory-level settings (bypass, clock, hasher, sink, bounds).
 * Options arriving from OpenCode (`ctx.options`) are applied when `setup` runs.
 */
export function createOpenCodeObserverV2(
  options: ObserverOptions = {},
): CreatedOpenCodeObserverV2 {
  const observer = new OpenCodeObserver({
    ...options,
    // A V2 summary says so. An observation must never claim the wrong API line.
    pluginApi: options.pluginApi ?? {
      package: OPENCODE_V2_PLUGIN_PACKAGE,
      verifiedVersion: OPENCODE_V2_PLUGIN_VERIFIED_VERSION,
      line: 'v2',
    },
  });

  const registrations: OpenCodeV2Registration[] = [];
  let abortEvents: (() => void) | undefined;
  let initialised = false;

  const plugin = defineOpenCodeV2Plugin({
    id: OBSERVER_V2_PLUGIN_ID,
    setup(context: OpenCodeV2PluginContext): OpenCodeV2Cleanup {
      if (!initialised) {
        initialised = true;
        try {
          observer.applyPluginOptions(context?.options);
        } catch {
          observer.noteInternalFailure();
        }

        const tool: OpenCodeV2ToolDomain | undefined = context?.tool;
        if (typeof tool?.hook !== 'function') {
          noteMissing(observer);
        } else {
          for (const name of IMPLEMENTED_V2_TOOL_HOOKS) {
            registerToolHook(observer, tool, name, registrations);
          }
        }

        abortEvents = subscribeEvents(observer, context?.event);
        if (abortEvents === undefined) {
          noteMissing(observer);
        }
      }

      // Cleanup is synchronous to hand back, and releases everything asynchronous
      // inside. Returning it from `setup` is the documented V2 unload path.
      return () => {
        abortEvents?.();
        abortEvents = undefined;
        return release(observer, registrations);
      };
    },
  });

  return { plugin, observer };
}

/** Register one tool hook, containing every failure. */
function registerToolHook(
  observer: OpenCodeObserver,
  tool: OpenCodeV2ToolDomain,
  name: (typeof IMPLEMENTED_V2_TOOL_HOOKS)[number],
  registrations: OpenCodeV2Registration[],
): void {
  if (name === 'execute.before') {
    void hook(
      tool,
      name,
      registrations,
      observer,
      guarded(observer, (event: OpenCodeV2ToolExecuteBeforeEvent) => {
        const mapped = toV1ToolBefore(event);
        observer.observeToolBefore(mapped.input, mapped.output);
      }),
    );
    return;
  }
  void hook(
    tool,
    name,
    registrations,
    observer,
    guarded(observer, (event: OpenCodeV2ToolExecuteAfterEvent) => {
      const mapped = toV1ToolAfter(event);
      observer.observeToolAfter(mapped.input, mapped.output);
    }),
  );
}

/**
 * Wrap a hook body so nothing it does can reach OpenCode.
 *
 * V2 hook callbacks are awaited by the host's tool pipeline: a throw here would
 * change the host's execution, so the body is contained a second time on top of
 * the containment already inside the observer.
 */
function guarded<TEvent>(
  observer: OpenCodeObserver,
  body: (event: TEvent) => void,
): (event: TEvent) => Promise<void> {
  return async (event: TEvent): Promise<void> => {
    try {
      body(event);
    } catch {
      try {
        observer.noteInternalFailure();
      } catch {
        // Reporting a failure must not become a failure.
      }
    }
  };
}

/**
 * Call `ctx.tool.hook` and remember the registration.
 *
 * The callback is wrapped twice — once in the observer, once here — so an internal
 * failure can never propagate into the host's tool pipeline.
 */
async function hook(
  tool: OpenCodeV2ToolDomain,
  name: (typeof IMPLEMENTED_V2_TOOL_HOOKS)[number],
  registrations: OpenCodeV2Registration[],
  observer: OpenCodeObserver,
  callback: (event: never) => Promise<void>,
): Promise<void> {
  try {
    const registration = await tool.hook(name, callback as never);
    if (registration !== undefined && typeof registration.dispose === 'function') {
      registrations.push(registration);
    }
  } catch {
    noteMissing(observer);
  }
}

/**
 * Subscribe to the server event stream and feed every event to the observer.
 *
 * Returns an abort function, or `undefined` when the capability is unavailable.
 * Events are consumed in the background; the loop failure is contained and stops
 * quietly. Nothing about the observer depends on the subscription existing —
 * without it, tool-call and read observation still work, and usage fields simply
 * stay `unavailable` rather than being invented.
 */
function subscribeEvents(
  observer: OpenCodeObserver,
  domain: OpenCodeV2EventDomain | undefined,
): (() => void) | undefined {
  if (typeof domain?.subscribe !== 'function') {
    return undefined;
  }
  const controller = new AbortController();
  let iterable: AsyncIterable<unknown>;
  try {
    iterable = domain.subscribe({ signal: controller.signal });
  } catch {
    noteMissing(observer);
    return undefined;
  }

  void (async () => {
    try {
      for await (const event of iterable) {
        try {
          await observer.observeEvent({ event: asRuntimeEvent(event) });
        } catch {
          observer.noteInternalFailure();
        }
      }
    } catch {
      // An aborted or failed subscription is not an observer failure: it is the
      // documented end of the stream. Nothing is reported that could be mistaken
      // for a container error.
    }
  })();

  return () => {
    try {
      controller.abort();
    } catch {
      // Ignore: abort is best effort.
    }
  };
}

/** Dispose every registration, then flush and dispose the observer. Never throws. */
async function release(
  observer: OpenCodeObserver,
  registrations: OpenCodeV2Registration[],
): Promise<void> {
  for (const registration of registrations.splice(0)) {
    try {
      await registration.dispose();
    } catch {
      observer.noteInternalFailure();
    }
  }
  try {
    await observer.dispose();
  } catch {
    observer.noteInternalFailure();
  }
}

/** Convenience factory returning only the V2 plugin definition. */
export function createOpenCodeObserverPluginV2(options: ObserverOptions = {}): OpenCodeV2Plugin {
  return createOpenCodeObserverV2(options).plugin;
}

/**
 * Ready-to-load V2 plugin definition with default options.
 *
 * A project-local plugin file only needs to re-export it as the default export,
 * which is what V2 discovery looks for:
 *
 * ```ts
 * // .opencode/plugins/dr-token-observer.ts
 * export { DrTokenOpenCodeObserverV2 as default } from '@dr-token/opencode-observer';
 * ```
 */
export const DrTokenOpenCodeObserverV2: OpenCodeV2Plugin =
  createOpenCodeObserverPluginV2();
