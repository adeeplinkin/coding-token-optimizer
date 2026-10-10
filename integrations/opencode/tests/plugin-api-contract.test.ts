import { describe, expect, it } from 'vitest';
import {
  IMPLEMENTED_HOOKS,
  OPENCODE_PLUGIN_PACKAGE,
  OPENCODE_PLUGIN_VERIFIED_VERSION,
  createOpenCodeObserverPlugin,
} from '../src/index.js';
import type { OpenCodeObserverPlugin } from '../src/index.js';
import {
  VERIFIED_PLUGIN_INDEX_DTS_SHA256,
  VERIFIED_PLUGIN_PACKAGE,
  VERIFIED_PLUGIN_VERSION,
  VERIFIED_SDK_TYPES_DTS_SHA256,
  createPluginContext,
} from './fixtures/opencode-plugin-v1.contract.js';
import type { Hooks, Plugin } from './fixtures/opencode-plugin-v1.contract.js';

/**
 * Compatibility guard against the published OpenCode V1 plugin contract.
 *
 * The assignments below are the real check: if the adapter stops being assignable
 * to the vendored published `Plugin`/`Hooks` types, `npm run typecheck` fails.
 */
describe('OpenCode V1 plugin API compatibility', () => {
  it('records the verified API version and source digests', () => {
    expect(VERIFIED_PLUGIN_PACKAGE).toBe(OPENCODE_PLUGIN_PACKAGE);
    expect(VERIFIED_PLUGIN_VERSION).toBe(OPENCODE_PLUGIN_VERIFIED_VERSION);
    expect(VERIFIED_PLUGIN_INDEX_DTS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(VERIFIED_SDK_TYPES_DTS_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('provides a plugin function assignable to the published Plugin type', async () => {
    const adapter: OpenCodeObserverPlugin = createOpenCodeObserverPlugin({ env: {} });
    // This assignment is the compatibility guarantee.
    const published: Plugin = adapter;

    const hooks: Hooks = await published(createPluginContext());

    expect(typeof hooks.event).toBe('function');
    expect(typeof hooks.dispose).toBe('function');
  });

  it('returns a hooks object whose keys match the documented hook list', async () => {
    const hooks: Hooks = await createOpenCodeObserverPlugin({ env: {} })(createPluginContext());

    expect(Object.keys(hooks).sort()).toEqual([...IMPLEMENTED_HOOKS].sort());
  });

  it('implements only hooks that cannot change agent behavior', () => {
    expect([...IMPLEMENTED_HOOKS]).toEqual([
      'tool.execute.before',
      'tool.execute.after',
      'event',
      'dispose',
    ]);
    for (const hook of IMPLEMENTED_HOOKS) {
      expect(hook.startsWith('experimental.')).toBe(false);
    }
  });

  it('does not register context-mutating hooks that have documented alternatives', () => {
    const mutating = [
      'chat.message',
      'chat.params',
      'chat.headers',
      'tool.definition',
      'command.execute.before',
      'permission.ask',
      'shell.env',
      'experimental.chat.messages.transform',
      'experimental.chat.system.transform',
      'experimental.session.compacting',
      'experimental.text.complete',
    ];
    for (const hook of mutating) {
      expect([...IMPLEMENTED_HOOKS]).not.toContain(hook);
    }
  });

  it('accepts a plugin context with only the members it actually needs', async () => {
    const hooks: Hooks = await createOpenCodeObserverPlugin({ env: {} })({});

    expect(Object.keys(hooks)).toHaveLength(4);
  });

  it('matches the published hook arities at runtime', async () => {
    const hooks: Hooks = await createOpenCodeObserverPlugin({ env: {} })(createPluginContext());

    expect(hooks['tool.execute.before']?.length).toBe(2);
    expect(hooks['tool.execute.after']?.length).toBe(2);
    expect(hooks['event']?.length).toBe(1);
    expect(hooks['dispose']?.length).toBe(0);
  });

  it('accepts a plugin options object and a defaulted omission', async () => {
    const withOptions = await createOpenCodeObserverPlugin({ env: {} })(createPluginContext(), {
      enabled: true,
    });
    const withoutOptions = await createOpenCodeObserverPlugin({ env: {} })(createPluginContext());

    expect(Object.keys(withOptions)).toEqual(Object.keys(withoutOptions));
  });
});
