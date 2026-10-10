/**
 * Verified OpenCode **V2** plugin API contracts (Stage 1F).
 *
 * Target package: `@opencode/plugin`, verified version **2.0.24** — the version
 * bundled with the OpenCode Desktop installation on this machine.
 *
 * Verification method (2026-10-10): download the published tarball and read the
 * shipped declarations directly, then record their digests.
 *
 *   npm pack @opencode/plugin@2.0.24
 *   sha256(dist/promise/plugin.d.ts)       = ad8e00e94b4c94587800db750132a44754f42fe322d5cfb6da9fb0168ced09f1
 *   sha256(dist/promise/tool.d.ts)         = 14ead93a2c03136af9768f9f02447c5fb357d1bce12a4b38a5e9fe31a0e91eff
 *   sha256(dist/promise/registration.d.ts) = 16436600a035f85d035e3baebb8412084119f620ee4eafc9feba1c7438f6f5ff
 *   sha256(dist/promise/event.d.ts)        = 7e8549dc513c83bd3fcf7cd1b36bcd66b137fac5384f2ac65850b56c0ebcddad
 *
 * Verbatim excerpts from `@opencode/plugin@2.0.24/dist/promise/plugin.d.ts`:
 *
 *   export type Cleanup = () => Promise<void> | void;
 *   export interface Plugin {
 *     readonly id: string;
 *     readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
 *   }
 *   export declare function define(plugin: Plugin): Plugin;
 *
 * Verbatim excerpts from `.../dist/promise/tool.d.ts`:
 *
 *   interface ToolHooks {
 *     readonly "execute.before": {
 *       tool: string;
 *       readonly sessionID: Session.ID;
 *       readonly agent: Agent.ID;
 *       readonly messageID: SessionMessage.ID;
 *       readonly id: Tool.CallID;
 *       input: unknown;
 *     };
 *     readonly "execute.after": {
 *       readonly tool: string;
 *       readonly sessionID: Session.ID;
 *       readonly agent: Agent.ID;
 *       readonly messageID: SessionMessage.ID;
 *       readonly id: Tool.CallID;
 *       readonly input: unknown;
 *     } & ({ readonly status: "completed"; result: Tool.Result }
 *        | { readonly status: "error"; error: Tool.Error });
 *   }
 *   export interface ToolDomain {
 *     readonly transform: Transform<ToolEditor>;
 *     readonly reload: () => Promise<void>;
 *     readonly list: () => Promise<readonly (Info & { readonly id: string })[]>;
 *     readonly hook: Hooks<ToolHooks>;
 *   }
 *
 * Verbatim excerpts from `.../dist/promise/registration.d.ts`:
 *
 *   export interface Registration { readonly dispose: () => Promise<void>; }
 *   export type Hooks<Spec> = <Name extends keyof Spec>(
 *     name: Name,
 *     callback: (input: Spec[Name]) => Promise<void> | void,
 *   ) => Promise<Registration>;
 *
 * From `.../dist/promise/event.d.ts`:
 *
 *   export interface EventDomain extends Pick<EventApi, "subscribe"> {}
 *
 * The `Session.ID`, `Agent.ID`, `SessionMessage.ID`, `Tool.CallID` and `Tool.Result`
 * aliases above resolve to `string`/`unknown` in the published package; they are kept
 * as `string` here so this module has no dependency on `@opencode/schema`.
 *
 * A vendored copy of the published signatures is kept in
 * `tests/fixtures/opencode-plugin-v2.contract.ts`, and `npm run typecheck` fails if the
 * adapter in `plugin-v2.ts` stops being assignable to them.
 *
 * NOT verified here: the runtime payload contents (which fields are populated on a real
 * `execute.before`/`execute.after` call), the concrete `OpenCodeEvent` union members
 * delivered to `ctx.event.subscribe`, and whether token/usage fields are reachable at
 * all in V2. Those are documented as unverified in `docs/OPENCODE_OBSERVER.md`; the
 * adapter treats every field defensively and never invents a value.
 */

/** OpenCode V2 plugin API package this adapter targets. */
export const OPENCODE_V2_PLUGIN_PACKAGE = '@opencode/plugin';

/** OpenCode V2 plugin API version this adapter was verified against. */
export const OPENCODE_V2_PLUGIN_VERIFIED_VERSION = '2.0.24';

/**
 * Plugin id used in `Plugin.define({ id, setup })`.
 *
 * Stable, lowercase and hyphenated so a host can identify the plugin without
 * parsing anything else.
 */
export const OBSERVER_V2_PLUGIN_ID = 'dr-token-observer';

/**
 * The V2 tool hooks this adapter registers.
 *
 * Kept as a runtime list so tests can assert the adapter never registers a V2
 * capability that can change agent behavior. `ctx.tool.transform` (which can
 * replace a tool definition) is deliberately **not** used.
 */
export const IMPLEMENTED_V2_TOOL_HOOKS = ['execute.before', 'execute.after'] as const;

export type ImplementedV2ToolHook = (typeof IMPLEMENTED_V2_TOOL_HOOKS)[number];

/* -------------------------------------------------------------------------- */
/* V2 contracts (structural mirrors of the published declarations)             */
/* -------------------------------------------------------------------------- */

/** `execute.before`. `tool` and `input` are mutable in the published shape. */
export interface OpenCodeV2ToolExecuteBeforeEvent {
  tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  input: unknown;
}

/**
 * `execute.after` fields shared by both outcomes.
 *
 * Declared the way the published type declares them (an intersection of the
 * shared fields with a union of outcomes) so assignability with the published
 * contract is structural and exact.
 */
export interface OpenCodeV2ToolExecuteAfterFields {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
}

/**
 * `execute.after` payload: shared fields intersected with the outcome union.
 *
 * The observer reads only the shared fields; it never inspects `result` or
 * `error`, and never narrows on `status`.
 */
export type OpenCodeV2ToolExecuteAfterEvent = OpenCodeV2ToolExecuteAfterFields &
  (
    | { readonly status: 'completed'; result: unknown }
    | { readonly status: 'error'; error: unknown }
  );

/** The hook names `ctx.tool.hook` accepts, mapping to their payloads. */
export interface OpenCodeV2ToolHookSpec {
  readonly 'execute.before': OpenCodeV2ToolExecuteBeforeEvent;
  readonly 'execute.after': OpenCodeV2ToolExecuteAfterEvent;
}

/** Returned by `ctx.tool.hook`. Lets the plugin release its registration. */
export interface OpenCodeV2Registration {
  readonly dispose: () => Promise<void>;
}

/** `ctx.tool` — only the observation-only member is declared. */
export interface OpenCodeV2ToolDomain {
  hook<Name extends keyof OpenCodeV2ToolHookSpec>(
    name: Name,
    callback: (event: OpenCodeV2ToolHookSpec[Name]) => Promise<void> | void,
  ): Promise<OpenCodeV2Registration>;
}

/**
 * One server-sent event, after defensive normalisation.
 *
 * Fields are optional because the concrete V2 event union is **not** verified for
 * this install; the adapter reads `type`, `properties` and `data` only when they
 * are actually present and never trusts any of them.
 *
 * `data` matters: **V2 delivers an event body under `data`**, while V1 uses
 * `properties`. Runtime-confirmed on OpenCode Desktop 2.0.24 (Stage 1G captured
 * `{ id, created, type, data }` envelopes; Stage 1H showed that an adapter which
 * forwards `properties` alone receives every V2 event with an empty payload, so
 * this field must be preserved across normalisation). Both are kept — when a host
 * sent both, the observer prefers `properties` so V1 behaviour is unchanged.
 */
export interface OpenCodeV2Event {
  readonly type?: string;
  readonly properties?: unknown;
  readonly data?: unknown;
}

/**
 * `ctx.event`. Verified from `EventDomain extends Pick<EventApi, "subscribe">`.
 *
 * The item type is `unknown` on purpose: the published `OpenCodeEvent` union could
 * not be verified for this install, so the adapter accepts whatever it is given and
 * normalises it at runtime instead of asserting a shape it cannot confirm.
 */
export interface OpenCodeV2EventDomain {
  subscribe(options?: { readonly signal?: AbortSignal }): AsyncIterable<unknown>;
}

/**
 * The `setup` context.
 *
 * The published `Context` requires every domain; this mirror declares only the
 * members the observer could read, and makes them optional so the adapter keeps
 * working (and reports the capability as missing) on a context that lacks them.
 * The published `Context` is assignable to this type, so the contract still holds.
 */
export interface OpenCodeV2PluginContext {
  readonly tool?: OpenCodeV2ToolDomain;
  readonly event?: OpenCodeV2EventDomain;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly app?: unknown;
  readonly location?: unknown;
}

/** Cleanup returned from `setup`. */
export type OpenCodeV2Cleanup = () => Promise<void> | void;

/** A V2 plugin definition, as `Plugin.define({ id, setup })` produces. */
export interface OpenCodeV2Plugin {
  readonly id: string;
  readonly setup: (
    context: OpenCodeV2PluginContext,
  ) => Promise<OpenCodeV2Cleanup | void> | OpenCodeV2Cleanup | void;
}

/** Mirrors the published `Plugin.define` helper. */
export function defineOpenCodeV2Plugin(plugin: OpenCodeV2Plugin): OpenCodeV2Plugin {
  return plugin;
}
