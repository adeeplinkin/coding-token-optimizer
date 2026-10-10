/**
 * Vendored subset of the published OpenCode V1 plugin contract.
 *
 * Source: `@opencode-ai/plugin@1.18.35`, file `dist/index.d.ts`, obtained with
 * `npm pack @opencode-ai/plugin@1.18.35` on 2026-10-10.
 *
 * Recorded digests of the published files this was read from:
 *   dist/index.d.ts            sha256 f3ec1a150d1354be3c9d93928fa130edc118c63fb468533ebb01eb3d6ed77f92
 * `@opencode-ai/sdk@1.18.35`:
 *   dist/gen/types.gen.d.ts    sha256 1fdbed5b58ed5882b411cc9b1b03fdfe2fb131b0be39a0fd2622d12ab6f50f0f
 *
 * The `Hooks` members below are quoted verbatim. Two SDK-derived types are
 * replaced with documented structural stand-ins because the real ones pull in
 * the whole SDK surface: `Event` (a discriminated union whose every member has a
 * literal `type` and a `properties` object) and the SDK-derived members of
 * `PluginInput`. Both stand-ins are deliberately *wider* than the real types, so
 * a passing assignment still proves the published contract is satisfied.
 *
 * This file exists so `npm run typecheck` fails if the adapter stops matching the
 * contract it claims to implement. Re-verify with the `npm pack` + `sha256`
 * procedure in `docs/OPENCODE_OBSERVER.md` whenever the target version changes.
 */

export const VERIFIED_PLUGIN_PACKAGE = '@opencode-ai/plugin';
export const VERIFIED_PLUGIN_VERSION = '1.18.35';
export const VERIFIED_PLUGIN_INDEX_DTS_SHA256 =
  'f3ec1a150d1354be3c9d93928fa130edc118c63fb468533ebb01eb3d6ed77f92';
export const VERIFIED_SDK_TYPES_DTS_SHA256 =
  '1fdbed5b58ed5882b411cc9b1b03fdfe2fb131b0be39a0fd2622d12ab6f50f0f';

/** Stand-in for the SDK `Event` union: every member is `{ type, properties }`. */
export type Event = {
  readonly type: string;
  readonly properties: unknown;
};

/**
 * Verbatim from the published declaration, except the SDK-derived members
 * (`client`, `project`, `$`, `experimental_workspace`) which are widened here.
 */
export type PluginInput = {
  client: unknown;
  project: unknown;
  directory: string;
  worktree: string;
  experimental_workspace: {
    register(type: string, adapter: unknown): void;
  };
  serverUrl: URL;
  $: unknown;
};

/** Verbatim. */
export type PluginOptions = Record<string, unknown>;

/** A complete plugin context, matching the published required members. */
export function createPluginContext(): PluginInput {
  return {
    client: {},
    project: {},
    directory: '/repo',
    worktree: '/repo',
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:0'),
    $: {},
  };
}

/**
 * Verbatim subset of the published `Hooks` interface: only the members this
 * adapter implements are reproduced.
 */
export interface Hooks {
  dispose?: () => Promise<void>;
  event?: (input: { event: Event }) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>;
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => Promise<void>;
}

/** Verbatim. */
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
