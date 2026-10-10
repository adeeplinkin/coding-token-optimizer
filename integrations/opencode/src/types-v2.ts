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
 *   sha256(dist/promise/session.d.ts)      = 08f5c8728a15839df02f505e38c4cf1b586ccd2de3885eb4f0e471730680b48b
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
 *   export type ModelHooks<Spec> = <Name extends keyof Spec>(
 *     name: Name,
 *     callback: (input: Spec[Name]) => Promise<void> | void,
 *     options?: Spec[Name] extends { readonly model: unknown } ? ModelHookOptions : never,
 *   ) => Promise<Registration>;
 *
 * From `.../dist/promise/event.d.ts`:
 *
 *   export interface EventDomain extends Pick<EventApi, "subscribe"> {}
 *
 * ---------------------------------------------------------------------------
 * VERIFIED V2 SESSION REQUEST-ASSEMBLY CONTRACT (Stage 1P / 1Q)
 * ---------------------------------------------------------------------------
 *
 * Source package: `@opencode/plugin@2.0.24`, file `dist/promise/session.d.ts`,
 * digest recorded above. Verbatim excerpts (effect wrappers collapsed, comments
 * trimmed) for the hook Safe Mode M1 registers **only under explicit opt-in**:
 *
 *   export interface SessionRequest {
 *     readonly sessionID: Session.ID;
 *     readonly model: Model.Ref;
 *     system: Array<SystemPart>;
 *     messages: Array<Message>;
 *     options: SessionRequestOptions;
 *   }
 *   export interface SessionContext extends SessionRequest {
 *     readonly agent: Agent.ID;
 *     tools: Record<string, { description: string; input: JsonSchema.JsonSchema; }>;
 *   }
 *   export type SessionRequestKind = "primary" | "compaction" | "title" | "generate";
 *   export interface SessionHooks {
 *     readonly prompt: SessionPrompt;
 *     readonly context: SessionContext;
 *     readonly compaction: SessionCompaction;
 *     readonly generate: SessionGenerate;
 *     readonly title: SessionTitle;
 *     readonly "model.request": SessionModelRequest;
 *     readonly "http.request": SessionHttpRequest;
 *     readonly "http.response": SessionHttpResponse;
 *     readonly retry: SessionRetry;
 *     // ... experimental.ws.* hooks deliberately not modelled here
 *   }
 *   export type SessionDomain = Pick<SessionApi, ...> & {
 *     readonly hook: ModelHooks<SessionHooks>;
 *   };
 *
 * What this contract does **not** carry, and Dr. Token does not assume: the
 * `SessionContext` handed to the `context` callback has no `kind` member. The
 * request kind lives on the model-call hooks (`model.request`/`http.request`),
 * which is why M1's eligibility is content-level and the primary-only gate is
 * enforced (in a future apply mode) where the kind is observable. Stage 1P
 * runtime-confirmed delivery, timing and payload completeness of this hook; no
 * mutation has ever been attempted and none is implemented.
 *
 * The `Session.ID`, `Agent.ID`, `SessionMessage.ID`, `Tool.CallID` and `Tool.Result`
 * aliases above resolve to `string`/`unknown` in the published package; they are kept
 * as `string` here so this module has no dependency on `@opencode/schema`.
 *
 * A vendored copy of the published signatures is kept in
 * `tests/fixtures/opencode-plugin-v2.contract.ts`, and `npm run typecheck` fails if the
 * adapter in `plugin-v2.ts` stops being assignable to them.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED V2 SESSION-EVENT CONTRACTS (Stage 1I)
 * ---------------------------------------------------------------------------
 *
 * Source package: `@opencode/schema`, verified version **2.0.24** — the exact
 * version `@opencode/plugin@2.0.24` declares as a dependency. Method: download the
 * published tarball and read the shipped declarations.
 *
 *   npm pack @opencode/schema@2.0.24
 *   sha256(dist/session-event.d.ts)        = 3e2fbc287a3faf6d421eab5adf5daef4315b79b4696e2196766c16c8eaf15eea
 *   sha256(dist/location.d.ts)             = fe2d71d77933331fb8d95fcc131f4cbc4d68ea879d15d80d13805b2483ce9fe9
 *   sha256(dist/session-status-event.d.ts) = 96d920746648203c1cd88b2ecf61e96bde1dee77a4187d3e39d6f9e22a26a7f5
 *
 * From `dist/session-event.d.ts`, `Created` (verbatim, effect wrappers collapsed):
 *
 *   type: "session.created"; durability: "durable";
 *   data: {
 *     projectID: Project.ID;
 *     location: { directory: AbsolutePath; workspaceID?: Workspace.ID };
 *     subpath?: RelativePath; parentID?: SessionID; slug: string; title?: string;
 *     agent?: Agent.ID; model?: { id; providerID; variant? }; metadata?: Record;
 *     permissions?: readonly { action; resource; effect: "allow"|"deny"|"ask" }[];
 *     version: string;
 *     sessionID: SessionID;
 *   }
 *
 * From the same file, `Deleted` (verbatim):
 *
 *   type: "session.deleted"; durability: "durable";
 *   data: { sessionID: SessionID }
 *
 * From the same file, `Moved` (verbatim, collapsed):
 *
 *   type: "session.moved";
 *   data: { location: { directory; workspaceID? }; projectID: Project.ID;
 *           subpath?; sessionID }
 *
 * From the same file, `UsageUpdated` (verbatim, collapsed) — already consumed here:
 *
 *   type: "session.usage.updated"; durability: "ephemeral";
 *   data: { cost: Money.USD; tokens: { input; output; reasoning; cache: { read; write } };
 *           sessionID }
 *
 * From `dist/session-status-event.d.ts` (verbatim, collapsed):
 *
 *   session.idle    data: { sessionID }
 *   session.status  data: { sessionID; status: { type: "idle" | "busy" | "retry"; ... } }
 *
 * From `dist/location.d.ts` — `Location.Info`, the declared type of `ctx.location`:
 *
 *   { directory: AbsolutePath; workspaceID?: Workspace.ID;
 *     project: { id: Project.ID; directory: AbsolutePath; canonical: AbsolutePath } }
 *
 * NOT verified here: the runtime payload contents (which fields are populated on a real
 * `execute.before`/`execute.after` call), the concrete `OpenCodeEvent` union members
 * delivered to `ctx.event.subscribe`, and whether token/usage fields are reachable at
 * all in V2. Those are documented as unverified in `docs/OPENCODE_OBSERVER.md`; the
 * adapter treats every field defensively and never invents a value. What Stage 1H
 * observed live — `session.created`/`session.deleted` arriving with their payload under
 * `data` — is consistent with these declarations; the key names themselves came from the
 * declarations, not from that run.
 */

/** OpenCode V2 plugin API package this adapter targets. */
export const OPENCODE_V2_PLUGIN_PACKAGE = '@opencode/plugin';

/** OpenCode V2 plugin API version this adapter was verified against. */
export const OPENCODE_V2_PLUGIN_VERIFIED_VERSION = '2.0.24';

/**
 * Schema package carrying the V2 event contracts this adapter maps.
 *
 * `@opencode/plugin@2.0.24` depends on `@opencode/schema@2.0.24`, which is where
 * the concrete event payload shapes (and `ctx.location`'s type) live.
 */
export const OPENCODE_V2_SCHEMA_PACKAGE = '@opencode/schema';

/** Schema package version whose declarations were read and recorded (2026-10-10). */
export const OPENCODE_V2_SCHEMA_VERIFIED_VERSION = '2.0.24';

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
 * The `context` payload of `ctx.session.hook` — a defensive mirror of
 * `SessionContext`.
 *
 * The published type requires every member; this mirror declares only the ones
 * the observer could read and makes them optional, so the adapter keeps working
 * (and reports the capability as missing) on a host that exposes less. The
 * request content itself is treated as opaque data by the analyzer and never
 * asserted into a shape it cannot confirm.
 */
export interface OpenCodeV2SessionContext {
  /** The session this request assembly belongs to. */
  readonly sessionID?: string;
  /** The agent the request is assembled for. */
  readonly agent?: string;
  readonly model?: unknown;
  /** System parts; scanned for the Safe Mode marker prefix only. */
  readonly system?: unknown;
  /** The message list; the analyzer walks it for `tool-result` parts. */
  readonly messages?: unknown;
  readonly options?: unknown;
  readonly tools?: unknown;
}

/**
 * The session hook names this adapter can register.
 *
 * Only `context` is declared: it is the one request-assembly hook M1 uses, it is
 * observation-only by contract (its callback returns `Promise<void> | void`,
 * with no return-value channel), and none of the other session hooks
 * (`prompt`, `compaction`, `title`, `model.request`, ...) is registered by this
 * adapter.
 */
export interface OpenCodeV2SessionHookSpec {
  readonly context: OpenCodeV2SessionContext;
}

/**
 * `ctx.session` — only the `hook` member is declared.
 *
 * `SessionDomain` publishes more (prompt, create, get, ...). Declaring only the
 * member the adapter registers keeps the mirror honest: nothing here can call a
 * session operation.
 */
export interface OpenCodeV2SessionDomain {
  hook<Name extends keyof OpenCodeV2SessionHookSpec>(
    name: Name,
    callback: (input: OpenCodeV2SessionHookSpec[Name]) => Promise<void> | void,
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

/** A location reference, as `session.created`/`session.moved` carry it. */
export interface OpenCodeV2LocationRef {
  /** Effective directory of the event, an absolute path (`AbsolutePath`). */
  readonly directory?: string;
  /** Opaque workspace id, when the runtime has one. Never a path. */
  readonly workspaceID?: string;
}

/** The `project` member of `Location.Info` (`@opencode/schema` `location.d.ts`). */
export interface OpenCodeV2ProjectInfo {
  /** Opaque `Project.ID` — compared exactly, never used as a path or a session key. */
  readonly id?: string;
  /** Project root directory, as declared. */
  readonly directory?: string;
  /** Canonical project directory, as declared. */
  readonly canonical?: string;
}

/**
 * `Location.Info` — the declared type of `ctx.location`.
 *
 * This is the only source that can say **which project this plugin instance was
 * loaded for**, so it is what the scope gate compares a session's declared project
 * against. Every member is optional here because the adapter must survive a host
 * that exposes less (or a future release that changes the shape); a location with
 * nothing usable means sessions are reported as unverified instead of guessed.
 */
export interface OpenCodeV2LocationInfo {
  /** The host's effective working directory. */
  readonly directory?: string;
  /** Opaque workspace id, when the runtime has one. */
  readonly workspaceID?: string;
  /** The project the host belongs to. */
  readonly project?: OpenCodeV2ProjectInfo;
}

/**
 * `data` of a `session.created` event (contract-verified, see the header).
 *
 * Only the fields the observer reads are declared; the rest of the payload
 * (title, agent, model, metadata, permissions) is deliberately not modelled so
 * nothing can accidentally be stored from it.
 */
export interface OpenCodeV2SessionCreatedData {
  /** The session id. V1 describes the same transition as `properties.info.id`. */
  readonly sessionID?: string;
  /** Opaque runtime project id. */
  readonly projectID?: string;
  /** Where the session lives and which workspace it belongs to. */
  readonly location?: OpenCodeV2LocationRef;
  /** Relative path inside the project, when the session was created at one. */
  readonly subpath?: string;
}

/** `data` of a `session.deleted` event (contract-verified): the id, nothing else. */
export interface OpenCodeV2SessionDeletedData {
  readonly sessionID?: string;
}

/** `data` of a `session.moved` event: the new location and project, plus the id. */
export interface OpenCodeV2SessionMovedData {
  readonly sessionID?: string;
  readonly projectID?: string;
  readonly location?: OpenCodeV2LocationRef;
  readonly subpath?: string;
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
  /** The request-assembly domain, read only when Safe Mode observation is on. */
  readonly session?: OpenCodeV2SessionDomain;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly app?: unknown;
  /** The host's own location/project (`Location.Info`); unverified at runtime. */
  readonly location?: OpenCodeV2LocationInfo;
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
