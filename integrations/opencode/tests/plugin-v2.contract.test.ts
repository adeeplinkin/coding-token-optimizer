import { describe, expect, it } from 'vitest';
import {
  DrTokenOpenCodeObserverV2,
  IMPLEMENTED_V2_TOOL_HOOKS,
  OBSERVER_V2_PLUGIN_ID,
  OPENCODE_V2_PLUGIN_PACKAGE,
  OPENCODE_V2_PLUGIN_VERIFIED_VERSION,
  OPENCODE_V2_SCHEMA_PACKAGE,
  OPENCODE_V2_SCHEMA_VERIFIED_VERSION,
  V2_REQUIRED_CAPABILITIES,
  createOpenCodeObserverPluginV2,
  defineOpenCodeV2Plugin,
} from '../src/index.js';
import defaultExport from '../src/index.js';
import {
  VERIFIED_V2_LOCATION_DTS_SHA256,
  VERIFIED_V2_PLUGIN_DTS_SHA256,
  VERIFIED_V2_PLUGIN_PACKAGE,
  VERIFIED_V2_PLUGIN_VERSION,
  VERIFIED_V2_REGISTRATION_DTS_SHA256,
  VERIFIED_V2_SCHEMA_PACKAGE,
  VERIFIED_V2_SCHEMA_VERSION,
  VERIFIED_V2_SESSION_EVENT_DTS_SHA256,
  VERIFIED_V2_TOOL_DTS_SHA256,
  createPublishedV2Context,
} from './fixtures/opencode-plugin-v2.contract.js';
import type { PublishedPlugin } from './fixtures/opencode-plugin-v2.contract.js';

/**
 * Compatibility guard against the published OpenCode V2 plugin contract.
 *
 * The assignments are the real check: if the adapter stops being assignable to the
 * vendored published `Plugin` type, `npm run typecheck` fails.
 */
describe('OpenCode V2 plugin API compatibility', () => {
  it('records the verified V2 API version and source digests', () => {
    expect(VERIFIED_V2_PLUGIN_PACKAGE).toBe(OPENCODE_V2_PLUGIN_PACKAGE);
    expect(VERIFIED_V2_PLUGIN_VERSION).toBe(OPENCODE_V2_PLUGIN_VERIFIED_VERSION);
    for (const digest of [
      VERIFIED_V2_PLUGIN_DTS_SHA256,
      VERIFIED_V2_TOOL_DTS_SHA256,
      VERIFIED_V2_REGISTRATION_DTS_SHA256,
    ]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    // Stage 1I added the event contracts, which live in the schema package the
    // plugin package depends on. Same verification method, recorded the same way.
    expect(VERIFIED_V2_SCHEMA_PACKAGE).toBe(OPENCODE_V2_SCHEMA_PACKAGE);
    expect(VERIFIED_V2_SCHEMA_VERSION).toBe(OPENCODE_V2_SCHEMA_VERIFIED_VERSION);
    for (const digest of [VERIFIED_V2_SESSION_EVENT_DTS_SHA256, VERIFIED_V2_LOCATION_DTS_SHA256]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('provides a plugin definition assignable to the published Plugin type', async () => {
    const adapter = createOpenCodeObserverPluginV2({ env: {} });
    // This assignment is the compatibility guarantee.
    const published: PublishedPlugin = adapter;

    expect(published.id).toBe(OBSERVER_V2_PLUGIN_ID);
    // The published `setup` accepts the published `Context`; the adapter's setup
    // must therefore accept it too.
    const cleanup = await published.setup(createPublishedV2Context());
    expect(typeof cleanup === 'function' || cleanup === undefined).toBe(true);
  });

  it('defines the plugin through the published define() shape', () => {
    const defined = defineOpenCodeV2Plugin({ id: 'x', setup: () => undefined });

    expect(defined.id).toBe('x');
    expect(typeof defined.setup).toBe('function');
  });

  it('exports the default export V2 discovery loads', () => {
    expect(defaultExport).toBe(DrTokenOpenCodeObserverV2);
    expect(defaultExport.id).toBe(OBSERVER_V2_PLUGIN_ID);
    expect(typeof defaultExport.setup).toBe('function');
  });

  it('implements only the two observation-only tool hooks', () => {
    expect([...IMPLEMENTED_V2_TOOL_HOOKS]).toEqual(['execute.before', 'execute.after']);
  });

  it('never requests the tool-transform capability, which can change behavior', () => {
    // `ctx.tool.transform` can replace a tool definition. The adapter must not use it.
    const capabilities = [...V2_REQUIRED_CAPABILITIES];
    expect(capabilities).toEqual([
      'tool.hook("execute.before")',
      'tool.hook("execute.after")',
      'event.subscribe()',
    ]);
    for (const capability of capabilities) {
      expect(capability).not.toContain('transform');
      expect(capability).not.toContain('storage');
    }
  });

  it('registers only hook names present in the published V2 spec', async () => {
    const requested: string[] = [];
    const adapter = createOpenCodeObserverPluginV2({ env: {} });
    await adapter.setup({
      tool: {
        hook: async (name: never) => {
          requested.push(String(name));
          return { dispose: async () => undefined };
        },
      },
      event: { subscribe: () => (async function* () {})() },
      options: {},
    });

    expect(requested.sort()).toEqual(['execute.after', 'execute.before']);
  });
});
