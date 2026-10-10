/**
 * Vendored copy of the **published** OpenCode V2 plugin contract.
 *
 * Source: `npm pack @opencode/plugin@2.0.24` (2026-10-10), files
 * `dist/promise/plugin.d.ts`, `dist/promise/tool.d.ts`,
 * `dist/promise/registration.d.ts` and `dist/promise/event.d.ts`.
 *
 * The declarations below are the published ones, copied verbatim except for two
 * mechanical changes needed to keep this file dependency-free:
 *
 *   1. `Session.ID`, `Agent.ID`, `SessionMessage.ID` and `Tool.CallID` are
 *      substituted with `string`, and `Tool.Result`/`Tool.Error` with `unknown`.
 *      In the published package those aliases are `string`-like ids and opaque
 *      results, so the substitution does not change the compared structure.
 *   2. cross-package imports (`@opencode/client`, `@opencode/schema`, `effect`) are
 *      replaced by the equivalent local members.
 *
 * `plugin-v2.contract.test.ts` assigns the real adapter to these types, so
 * `npm run typecheck` fails if the adapter stops matching the contract it claims to
 * implement. This mirrors the V1 fixture in `opencode-plugin-v1.contract.ts`.
 */

/** `dist/promise/plugin.d.ts`. */
export type Cleanup = () => Promise<void> | void;

/** The `project` member of `Location.Info` (`@opencode/schema@2.0.24`). */
export interface PublishedProjectInfo {
  readonly id: string;
  readonly directory: string;
  readonly canonical: string;
}

/**
 * `Location.Info` from `@opencode/schema@2.0.24` `dist/location.d.ts`.
 *
 * Verbatim shape: the class is declared over
 * `{ directory: AbsolutePath; workspaceID?: Workspace.ID; project: Location.Project }`.
 * Only the members the adapter reads are kept.
 */
export interface PublishedLocationInfo {
  readonly directory: string;
  readonly workspaceID?: string;
  readonly project: PublishedProjectInfo;
}

/** Published `Context`, with the domains the observer could touch. */
export interface PublishedContext {
  readonly tool: PublishedToolDomain;
  readonly event: PublishedEventDomain;
  readonly options: Readonly<Record<string, any>>;
  readonly app: unknown;
  readonly location: PublishedLocationInfo;
}

export interface PublishedPlugin {
  readonly id: string;
  readonly setup: (context: PublishedContext) => Promise<Cleanup | void> | Cleanup | void;
}

/** `export declare function define(plugin: Plugin): Plugin`. */
export declare function define(plugin: PublishedPlugin): PublishedPlugin;

/** `dist/promise/registration.d.ts`. */
export interface Registration {
  readonly dispose: () => Promise<void>;
}

export type Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<Registration>;

/** `dist/promise/tool.d.ts`. */
interface ToolHooks {
  readonly 'execute.before': {
    tool: string;
    readonly sessionID: string;
    readonly agent: string;
    readonly messageID: string;
    readonly id: string;
    input: unknown;
  };
  readonly 'execute.after': {
    readonly tool: string;
    readonly sessionID: string;
    readonly agent: string;
    readonly messageID: string;
    readonly id: string;
    readonly input: unknown;
  } & (
    | { readonly status: 'completed'; result: unknown }
    | { readonly status: 'error'; error: unknown }
  );
}

export interface PublishedToolDomain {
  readonly hook: Hooks<ToolHooks>;
}

/** `dist/promise/event.d.ts` plus the documented `subscribe` shape. */
export interface PublishedEventApi {
  subscribe(options?: { readonly signal?: AbortSignal }): AsyncIterable<PublishedEvent>;
}

export interface PublishedEventDomain extends Pick<PublishedEventApi, 'subscribe'> {}

/**
 * Structural stand-in for the published `OpenCodeEvent`.
 *
 * A real V2 event is a tagged union member: `{ id, created, metadata?, type,
 * durable?, location?, data }` (`@opencode/schema@2.0.24`). `properties` is kept
 * because a host may still deliver a V1-shaped event through the same stream.
 */
export interface PublishedEvent {
  readonly id: string;
  readonly created: number;
  readonly type: string;
  readonly data?: unknown;
  readonly properties?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Recorded verification facts                                                 */
/* -------------------------------------------------------------------------- */

/** Package the fixture was taken from. */
export const VERIFIED_V2_PLUGIN_PACKAGE = '@opencode/plugin';

/** Version the fixture was taken from — the version bundled with the test host. */
export const VERIFIED_V2_PLUGIN_VERSION = '2.0.24';

/** Digest of the published `dist/promise/plugin.d.ts`. */
export const VERIFIED_V2_PLUGIN_DTS_SHA256 =
  'ad8e00e94b4c94587800db750132a44754f42fe322d5cfb6da9fb0168ced09f1';

/** Digest of the published `dist/promise/tool.d.ts`. */
export const VERIFIED_V2_TOOL_DTS_SHA256 =
  '14ead93a2c03136af9768f9f02447c5fb357d1bce12a4b38a5e9fe31a0e91eff';

/** Digest of the published `dist/promise/registration.d.ts`. */
export const VERIFIED_V2_REGISTRATION_DTS_SHA256 =
  '16436600a035f85d035e3baebb8412084119f620ee4eafc9feba1c7438f6f5ff';

/** Schema package the event/location contracts were read from (Stage 1I). */
export const VERIFIED_V2_SCHEMA_PACKAGE = '@opencode/schema';

/** Schema package version the contracts were read from. */
export const VERIFIED_V2_SCHEMA_VERSION = '2.0.24';

/** Digest of `@opencode/schema@2.0.24/dist/session-event.d.ts`. */
export const VERIFIED_V2_SESSION_EVENT_DTS_SHA256 =
  '3e2fbc287a3faf6d421eab5adf5daef4315b79b4696e2196766c16c8eaf15eea';

/** Digest of `@opencode/schema@2.0.24/dist/location.d.ts`. */
export const VERIFIED_V2_LOCATION_DTS_SHA256 =
  'fe2d71d77933331fb8d95fcc131f4cbc4d68ea879d15d80d13805b2483ce9fe9';

/** A published-shaped context, used to prove the adapter accepts the real one. */
export function createPublishedV2Context(overrides: Partial<PublishedContext> = {}): PublishedContext {
  return {
    tool: {
      hook: async () => ({ dispose: async () => undefined }),
    },
    event: {
      subscribe: () =>
        (async function* () {
          // No events: the fixture only exists so the types can be checked.
        })(),
    },
    options: {},
    app: undefined,
    location: {
      directory: 'C:\\synthetic\\dr-token-fixture',
      project: {
        id: 'prj_synthetic',
        directory: 'C:\\synthetic\\dr-token-fixture',
        canonical: 'C:\\synthetic\\dr-token-fixture',
      },
    },
    ...overrides,
  };
}
