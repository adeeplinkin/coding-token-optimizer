import { OpenCodeObserver } from './observer.js';
import type {
  ObserverOptions,
  OpenCodeObserverHooks,
  OpenCodeObserverPlugin,
  OpenCodePluginInput,
  OpenCodePluginOptions,
} from './types.js';

/**
 * The OpenCode plugin entry point.
 *
 * The returned object is a plain V1 plugin function (`Plugin`). It registers
 * only the documented observation hooks and never a hook that can modify model
 * context: no `experimental.*` hook, no argument rewriting, no tool-result
 * rewriting, no prompt rewriting.
 *
 * Every hook body is wrapped twice — once inside the observer, once here — so an
 * internal failure can never propagate into OpenCode. The published hook
 * dispatcher has no error handling, so a throwing hook would abort the tool call
 * or model request.
 */

/** A plugin factory result that also exposes the observer, for inspection and tests. */
export interface CreatedOpenCodeObserver {
  readonly plugin: OpenCodeObserverPlugin;
  readonly observer: OpenCodeObserver;
}

/**
 * Wrap hook bodies so a failure can never abort OpenCode.
 *
 * Exported so custom wiring and tests can reuse the same containment.
 */
export function createOpenCodeObserverHooks(observer: OpenCodeObserver): OpenCodeObserverHooks {
  return {
    'tool.execute.before': async (input, output) => {
      await guard(observer, () => observer.observeToolBefore(input, output));
    },
    'tool.execute.after': async (input, output) => {
      await guard(observer, () => observer.observeToolAfter(input, output));
    },
    event: async (input) => {
      await guard(observer, () => observer.observeEvent(input));
    },
    dispose: async () => {
      await guard(observer, () => observer.dispose());
    },
  };
}

async function guard(
  observer: OpenCodeObserver,
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch {
    try {
      observer.noteInternalFailure();
    } catch {
      // Reporting a failure must not become a failure.
    }
  }
}

/**
 * Create an observer and its plugin function.
 *
 * `options` are the factory-level settings (bypass, clock, hasher, sink, bounds).
 * Options arriving from `opencode.json` are applied when OpenCode invokes the
 * plugin; see {@link OpenCodeObserver.applyPluginOptions}.
 */
export function createOpenCodeObserver(options: ObserverOptions = {}): CreatedOpenCodeObserver {
  const observer = new OpenCodeObserver(options);
  let hooks: OpenCodeObserverHooks | undefined;

  const plugin: OpenCodeObserverPlugin = async (
    _input: OpenCodePluginInput,
    options?: OpenCodePluginOptions,
  ): Promise<OpenCodeObserverHooks> => {
    // `PluginInput` carries `directory`, `worktree`, `client`, `project` and
    // `serverUrl`. The observer deliberately reads none of them: it never stores
    // a path and never touches the SDK client or credentials.
    try {
      observer.applyPluginOptions(options);
    } catch {
      observer.noteInternalFailure();
    }
    if (hooks === undefined) {
      hooks = createOpenCodeObserverHooks(observer);
    }
    return hooks;
  };

  return { plugin, observer };
}

/** Convenience factory returning only the plugin function. */
export function createOpenCodeObserverPlugin(
  options: ObserverOptions = {},
): OpenCodeObserverPlugin {
  return createOpenCodeObserver(options).plugin;
}

/**
 * Ready-to-load plugin function with default options.
 *
 * A project-local plugin file can simply re-export it:
 *
 * ```ts
 * // .opencode/plugins/dr-token-observer.ts
 * export { DrTokenOpenCodeObserver as DrTokenObserver } from '@dr-token/opencode-observer';
 * ```
 */
export const DrTokenOpenCodeObserver: OpenCodeObserverPlugin = createOpenCodeObserverPlugin();
