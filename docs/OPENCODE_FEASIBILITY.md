# OpenCode integration feasibility

**Status:** research complete, no adapter implemented
**Research date:** 2026-10-10
**Author:** Dr. Token development (Stage 1C)

This document records what OpenCode's official plugin interface can and cannot do for
Dr. Token. Everything here is **documentation- and source-verified**. Nothing was runtime-tested:
no OpenCode installation was available on the research machine, so no hook was executed.

---

## 1. Versions examined

| Item | Value | Notes |
| --- | --- | --- |
| `@opencode-ai/plugin` | **1.18.35** | npm `latest`; publish activity 2026-10-09 |
| `@opencode-ai/sdk` | **1.18.35** | peer of the plugin package |
| npm `latest` | 1.18.35 | the stable line to target |
| npm `next` / `beta` | `0.0.0-next-17444` / `0.0.0-beta-19271` | pre-release snapshots, not for integration |
| Repository | `github.com/anomalyco/opencode` | the former `sst/opencode` organization was renamed; GitHub redirects |
| Source revision read | `055d95b` on branch `dev` (2026-10-09) | used for behavioural evidence only |
| Documentation | `opencode.ai/docs/plugins/` | corresponds to the stable v1 line |

**Important distinction:** the `/v2/docs` documentation describes an **unreleased rewrite**
(`Plugin.define({ id, setup })` from a new `@opencode/plugin` package, a `plugins` config key, domain
transforms). The published stable release is still v1 with the `Hooks` interface used below, and the v2
docs ship a "V1 plugin migration guide". Dr. Token must target **v1 stable** and treat v2 as a future
migration, not as the current contract.

Source line numbers in this document refer to revision `055d95b` (dev). The published type definitions
from `1.18.35` are the contract; the dev tree may include unreleased changes.

A future release could therefore change behaviour without a type change; the adapter must treat every
hook as optional and degrade gracefully.

## 2. Official sources

- Plugins documentation: <https://opencode.ai/docs/plugins/>
- Tools documentation (mentions `tool.execute.before` / `tool.execute.after`): <https://opencode.ai/docs/tools/>
- Repository: <https://github.com/anomalyco/opencode>
- Published plugin types: `@opencode-ai/plugin@1.18.35` → `dist/index.d.ts` (interface `Hooks`)
- Published SDK types: `@opencode-ai/sdk@1.18.35` → `dist/gen/types.gen.d.ts`
- In-repo docs source for the plugins page: `packages/web/src/content/docs/plugins.mdx`
- v2 (unreleased) plugin docs: <https://opencode.ai/v2/docs/build/plugins>

## 3. Verified plugin architecture

- A plugin is a JS/TS module exporting a function that receives a context and returns a hooks object
  (`Plugin = (input: PluginInput, options?) => Promise<Hooks>`).
- `PluginInput` provides `client` (an SDK client), `project`, `directory`, `worktree`, `serverUrl`,
  `$` (Bun shell) and `experimental_workspace`.
- Loading sources: global config (`~/.config/opencode/opencode.json`), project config (`opencode.json`),
  global plugin directory (`~/.config/opencode/plugins/`), project plugin directory
  (`.opencode/plugins/`). npm packages are listed in the `plugin` array and installed on demand with
  Bun, cached under `~/.cache/opencode/node_modules/`.
- Local plugins may declare dependencies in `.opencode/package.json`; OpenCode runs `bun install` at
  startup.
- All hooks run **sequentially in load order** and receive the **same `output` object by reference**,
  so later hooks observe earlier hooks' mutations.

**Hook dispatch (`packages/opencode/src/plugin/index.ts:284-296`):**

```ts
const trigger = Effect.fn("Plugin.Trigger")(function* (name, input, output) {
  if (!name) return output
  const s = yield* InstanceState.get(state)
  for (const hook of s.hooks) {
    const fn = hook[name] as any
    if (!fn) continue
    yield* Effect.promise(async () => fn(input, output))   // no try/catch
  }
  return output
})
```

Two consequences matter for Dr. Token:

1. **Mutation, not return values, is the transport.** Most call sites keep using their local variable
   after the trigger; renaming/replacing a property on the wrapper object is silently ignored. Table in
   §5 records, per hook, whether the returned object is used or in-place mutation is required.
2. **A throwing hook propagates.** There is no error handling around hook invocation, so an exception
   aborts the current tool call or model request. The official docs' own example throws from
   `tool.execute.before` to *block* a tool. A Dr. Token hook must therefore never throw.

## 4. Available hooks and lifecycle

Documentation status: "Documented" = listed on the official plugins page; "Types only" = present in the
published `Hooks` interface and triggered in source, but not described in the public docs page.

| Hook | Docs | Stable? | Trigger site (dev `055d95b`) | Can observe | Can modify |
| --- | --- | --- | --- | --- | --- |
| `tool.execute.before` | Documented | Stable | `session/tools.ts:106` | tool id, sessionID, callID, `args` | `args` (in place) |
| `tool.execute.after` | Documented | Stable | `session/tools.ts:121` | tool id, sessionID, callID, `args`, result | result `title`/`output`/`metadata` |
| `chat.message` | Types only | Stable | `session/prompt.ts:1000` | sessionID, agent, model, messageID, user message + parts | message parts (in place) |
| `chat.params` | Types only | Stable | `session/llm/request.ts:115` | sessionID, agent, model, provider, user message | temperature, topP, topK, maxOutputTokens, options |
| `chat.headers` | Types only | Stable | `session/llm/request.ts:135` | same as `chat.params` | request headers |
| `tool.definition` | Types only | Stable | `tool/registry.ts:318` | toolID | tool description, parameters, JSON schema |
| `experimental.chat.messages.transform` | Not documented | **Experimental** | `session/prompt.ts:1255`, `session/compaction.ts:379` | the full message list sent to the model | message list (in place) |
| `experimental.chat.system.transform` | Not documented | **Experimental** | `session/llm/request.ts:70`, `agent/agent.ts:381` | system prompt array (agent + provider + environment) | system prompt array (in place) |
| `experimental.session.compacting` | Documented | **Experimental** | `session/compaction.ts:374` | sessionID | compaction `context[]`, `prompt` |
| `experimental.compaction.autocontinue` | Not documented | **Experimental** | `session/compaction.ts:501` | sessionID, agent, model, overflow | whether the synthetic "continue" turn is added |
| `experimental.text.complete` | Not documented | **Experimental** | `session/processor.ts:531` | sessionID, messageID, partID | completed assistant text |
| `permission.ask` | Types only | Stable (types) | **not located in the sparse source checkout** | permission object | `ask` / `deny` / `allow` |
| `command.execute.before` | Types only | Stable | `session/prompt.ts:1461` | command, sessionID, arguments | command parts |
| `shell.env` | Documented example | Stable | `plugin/pty-environment.ts:18` | cwd, sessionID?, callID? | environment variables |
| `event` | Documented | Stable | event bus | every event (see §8) | nothing |
| `tool` | Documented | Stable | registry | – | registers custom tools |
| `auth`, `provider`, `config`, `dispose` | Types only | Stable | – | auth/provider registration | – |

Events published on the bus (from the SDK `Event` union and the docs): `message.updated`,
`message.part.updated`, `message.part.removed`, `message.removed`, `session.created`,
`session.updated`, `session.deleted`, `session.idle`, `session.compacted`, `session.error`,
`session.diff`, `session.status`, `file.edited`, `file.watcher.updated`, `command.executed`,
`permission.updated`, `permission.replied`, `installation.updated`, `lsp.*`, `pty.*`,
`server.connected`, `todo.updated`, `tui.*`.

## 5. Mutation semantics per hook (source-verified)

This is the single most important implementation detail for an adapter, and it is not documented.

| Hook | Call-site pattern | Correct way to influence behaviour |
| --- | --- | --- |
| `tool.execute.before` | `trigger(name, {...}, { args })`, then the local `args` is executed | mutate fields of the existing args object (`output.args.filePath = …`) |
| `tool.execute.after` | `trigger(name, {...}, output)`, then `return output` | assign result fields (`output.output = …`) |
| `chat.message` | `trigger(name, {...}, { message, parts })`, then the local `parts` is used | mutate the parts array/items in place |
| `experimental.chat.messages.transform` | `trigger(name, {}, { messages })`, then the local `msgs` is used | mutate `messages` in place (splice/replace items) |
| `experimental.chat.system.transform` | `trigger(name, {...}, { system })`, then the local `system` is used | mutate `system` in place |
| `chat.params` / `chat.headers` | return value is assigned (`const params = yield* trigger(...)`) | property assignment works |
| `experimental.session.compacting` | return value is assigned (`const compacting = yield* trigger(...)`) | property assignment works |
| `tool.definition` | `trigger(name, {...}, output)`, then `output.*` is read | property assignment works |

Assigning a brand-new object to `output.args` (before) or `output.parts` / `output.messages`
(chat/messages hooks) has **no effect** on the stable path.

## 6. Tool-read observation feasibility

**Confirmed.** The built-in read tool is registered through the same wrapper as other built-in tools
(`session/tools.ts:99-133`), and its parameters are:

```ts
{ filePath: string, offset?: number, limit?: number }          // tool/read.ts:28-35
```

Its result carries `{ title, output, metadata }` where `title` is the worktree-relative path and
`output` is the numbered line text (`tool/read.ts:360-370`).

So an adapter can, inside `tool.execute.before` / `tool.execute.after`:

- detect a file read with `input.tool === "read"` (observe the tool id, not the args, in `before`)
- read `output.args.filePath` (in `before`) or `input.args.filePath` (in `after`)
- hash `(filePath, offset, limit)` and/or the returned content to count repeated reads
- count all tool calls and per-tool frequencies

Tool ids are documented and stable enough to switch on: the built-in set includes `read`, `edit`,
`write`, `apply_patch`, `bash`, `grep`, `glob`, `skill`, `todowrite`, `webfetch`, `websearch` and
`question` (<https://opencode.ai/docs/tools/>). Note the documented caveat that patch handling uses the
id `apply_patch` (not `patch`) and passes `output.args.patchText` instead of `filePath` — argument
assumptions must be per-tool, never generic.

**Limitation:** this observes *requests*, not the model's context window. Repeated reads are only
"redundant" if the earlier content is still present in the context; deciding that requires the message
list (`experimental.chat.messages.transform`) or OpenCode's own compaction state. Counting repeated
reads is therefore a *calculated* metric owned by Dr. Token, not a direct measurement.

## 7. Tool-output transformation feasibility

**Confirmed for built-in tools.** `tool.execute.after` receives the tool result object, the caller
returns that same object, and the result becomes the tool part visible to the model:

- `session/tools.ts:112-129` — result object passed to the hook, then `return output`
- `session/processor.ts:176` — `output: output.output` is written into the tool part
- `session/message-v2.ts:305` — the part's text is what the model receives

**Limitations (all source-verified):**

1. **Shape varies.** The published type declares `{ title, output, metadata }`, but the MCP tool path
   passes a different object (`{ content: [...] }`, `session/tools.ts:420-424`). An adapter must check
   the shape before writing and otherwise leave the value untouched.
2. **OpenCode truncates afterwards.** `message-v2.ts:305` applies `truncateToolOutput(part.state.output, …)`,
   so a replacement is still subject to OpenCode's own limits.
3. **Compaction clears old tool results.** `message-v2.ts:303` replaces compacted tool output with
   `"[Old tool result content cleared]"`. Deduplication value is reduced after compaction, and Dr. Token
   must not assume its substituted text survives.
4. **Attachments are separate** (`output.attachments`), so replacing `output.output` does not remove
   image/file attachments.

**Verdict:** tool output text can be changed using supported APIs without patching OpenCode — the core
requirement for a repeated-read optimization pass is technically satisfiable.

## 8. Context optimization feasibility

| Layer | Control point | Stability | Notes |
| --- | --- | --- | --- |
| Incoming user message + parts | `chat.message` | Stable, undocumented | Mutate parts in place |
| Tool arguments | `tool.execute.before` | Stable, documented | Can redirect e.g. `filePath`, `offset`, `limit` |
| Tool results | `tool.execute.after` | Stable, documented | Strongest *stable* lever for context size |
| Tool definitions sent to the model | `tool.definition` | Stable, types only | Tool schemas consume input tokens on every request |
| System prompt | `experimental.chat.system.transform` | Experimental | Mutate array in place |
| **Full model context** | `experimental.chat.messages.transform` | Experimental | The only place the complete message list is exposed |
| Compaction prompt | `experimental.session.compacting` | Experimental | Replacement prompt or extra context |

**Boundary to keep clear:** observing a tool call is not the same as controlling the model context.
The stable hooks influence *individual* artifacts (args, tool results, tool definitions). Whole-context
optimization (deduplicating, reordering, dropping stale content) is only available through
`experimental.chat.messages.transform` and `experimental.chat.system.transform`. `message.updated` /
`message.part.updated` events are observational only.

Dr. Token's Stage 1A contract maps cleanly onto these points: each interception produces one
`OptimizationRequest` for the artifact that can actually be rewritten, and the engine's unchanged-output
guarantee is easy to honour because mutation is explicit.

## 9. Token-measurement availability

Per-message measurements are **directly available**; session aggregates are **calculated**.

| Measurement | Availability | Source |
| --- | --- | --- |
| Input tokens | Direct, per assistant message / step | `AssistantMessage.tokens.input`, `StepFinishPart.tokens.input` |
| Output tokens | Direct | `AssistantMessage.tokens.output` |
| Reasoning tokens | Direct | `AssistantMessage.tokens.reasoning` |
| Cache read tokens | Direct | `AssistantMessage.tokens.cache.read` |
| Cache write tokens | Direct | `AssistantMessage.tokens.cache.write` |
| Cost | Direct | `AssistantMessage.cost`, `StepFinishPart.cost` |
| Session totals | **Calculated** — sum over messages | `Session` has no cost/token fields |
| Tool execution counts | **Calculated** — count tool parts/calls | `Part` of type `tool` |
| Repeated file reads | **Calculated** by Dr. Token | requires own bookkeeping (§6) |
| Per-run token savings | **Not available** as a primitive | must be derived from baseline/candidate comparisons |

Access paths: the `event` hook (`message.updated`, `message.part.updated`) or the SDK client
`session.messages` / `session.list` (`client.session.*`).

**Caveats to verify at runtime:** whether aborted or errored requests still publish final token counts;
whether reasoning/cache fields are populated for every provider; and whether events arrive for the
*same* session the plugin is attached to (the plugin context is a server client, so it may observe more
than one session — isolation must be implemented by Dr. Token). There is **no dedicated token-usage hook**
and no documented hook that reports "tokens saved".

## 10. Security and fail-open considerations

- **Never throw from a hook.** Hook errors propagate and abort the tool call or model request
  (`plugin/index.ts:291-295`). Every Dr. Token hook body must be wrapped so failures degrade to
  "return the original value unchanged".
- **Fail-open is the default by construction:** the engine already returns the original context when it
  cannot safely transform (§Stage 1A), and the adapter must simply not write to the output object when
  the result is unchanged.
- **Bypass:** when the user disables optimization, the adapter must skip building requests entirely
  (no reads, no hooks that mutate, no accounting side effects beyond optional counters).
- **Content handling:** raw prompts, source files and tool outputs must never be logged or persisted by
  default. OpenCode provides `client.app.log()` for structured logging — the adapter should log
  identifiers, counters and hashes only.
- **Credentials:** plugins run inside the OpenCode server process with full filesystem access and can see
  provider/auth configuration. Dr. Token must not read, copy, log or store credentials. Notably, the
  local machine used for this research has `~/.config/opencode/service.json` containing a local service
  password; that value must never be read by Dr. Token, and it was not written to any file during this
  stage. (While probing the local configuration directory during this research, the file's contents were
  inadvertently displayed in the terminal transcript. It was not committed, stored, or transmitted;
  rotate it if that local value is considered sensitive.)
- **Trust boundary:** plugin code is third-party code with broad access. Dr. Token must keep its
  footprint minimal and must not shell out, install packages, or write outside its own data directory.
- **No billable activity:** this stage made no model requests; Stage 1D validation must not start billable
  sessions without explicit authorization.

## 11. Compatibility matrix

Required capability → available API → evidence → stability → verified behaviour → limitation → approach.

| # | Required capability | Available hook/API | Official source reference | Stability | Verified behaviour | Limitations | Recommended approach |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Observe agent tool execution | `tool.execute.before` / `tool.execute.after`, `event` | docs plugins page; `session/tools.ts:106,121`; `types.gen.d.ts` | **Confirmed** | Sequential by-reference triggers; tool id, sessionID, callID, args, result | `before` does not receive args (only `output.args`); shape varies for MCP tools | Observe both hooks; identify reads via `input.tool === "read"` |
| 2 | Detect repeated file reads | Derived from (1) | `tool/read.ts:28-35` | **Confirmed** (capability) | `args.filePath`, `offset`, `limit` visible | Dr. Token must keep its own per-session index; not exposed by OpenCode | Hash `(filePath, offset, limit)` + content in a local session store |
| 3 | Inspect relevant tool outputs | `tool.execute.after` (`output.output`) | `session/tools.ts:121`; `processor.ts:176` | **Confirmed** | Mutated result reaches the model | Shape variance; truncation after the hook | Type-check shape, then hash/measure |
| 4 | Safely influence model context | Stable: `tool.execute.after`, `tool.execute.before`, `tool.definition`. Full context: `experimental.chat.messages.transform`, `experimental.chat.system.transform` | `session/tools.ts`; `session/prompt.ts:1255`; `llm/request.ts:70` | **Confirmed** for stable artifacts, **Experimental** for whole context | Mutation propagates for each case per §5 | Whole-context control is experimental/unstable | Ship artifact-level transformations first; gate whole-context behind a flag |
| 5 | Observe session activity and compaction | `event` (`session.idle`, `session.compacted`, `message.*`), `experimental.session.compacting` | `types.gen.d.ts:413-424`; `session/compaction.ts:374` | **Confirmed** (observe) / **Experimental** (modify) | Events carry session ids; compaction hook can replace the prompt | Compaction hook is experimental; compaction hides old tool output (`message-v2.ts:303`) | Observe events for accounting; do not depend on compaction control |
| 6 | Reliable token usage | `message.updated` / `message.part.updated` events, `client.session.messages` | `types.gen.d.ts:98-131` (`tokens`, `cost`) | **Confirmed** per message, **Calculated** for session totals | input/output/reasoning/cache read/cache write + cost per assistant message and step | No session-level field; no token hook; abort/error edge cases unverified | Sum per-message tokens; label as measured-with-derived-total; never estimate |
| 7 | Connect to shared Dr. Token engine | npm plugin package depending on the core | docs ("From npm", `~/.cache/opencode/node_modules`); core package | **Confirmed feasible** | Plugin runs in Bun; `@dr-token/core` imports no Node builtins and has no dependencies | Core is `private: true` — must be published or bundled; benchmarks package is Node-only and must not be imported | Bundle (or publish) the engine inside the plugin package; keep the adapter thin |
| 8 | Bypass and fail-open | Adapter-side design; trigger semantics in `plugin/index.ts:291-295` | same | **Confirmed** (design) | Hook exceptions abort the operation; mutations are opt-in per call | No built-in bypass toggle in OpenCode | Catch everything; never throw; skip transforms when disabled |
| 9 | Intercept inbound user messages | `chat.message` | `session/prompt.ts:1000`; published `Hooks` | **Confirmed** (types), undocumented | Receives user message + resolved parts | Types-only/undocumented; mutate parts in place | Optional, behind a flag |
| 10 | Modify tool schemas | `tool.definition` | `tool/registry.ts:318`; published `Hooks` | **Confirmed** (types), undocumented | Description/parameters/jsonSchema read after trigger | Undocumented | Future token-saving lever; not in Stage 1D |
| 11 | Block or deny tool permissions | `permission.ask` | published `Hooks` (types only) | **Unverified** | Trigger site not found in the sparse source checkout | Not located in source; unclear semantics | Do not rely on it |
| 12 | Read provider/auth secrets | `auth`/`provider` hooks, `PluginInput` | docs | **Confirmed available — deliberately unsupported by Dr. Token** | Plugins can register providers/auth | Out of scope and a security hazard | Never touch credentials |

## 12. Technical risks

1. **Experimental dependency.** The only whole-context control points are `experimental.*`. Names and
   shapes can change in any release, and the docs page does not describe `chat.message`,
   `chat.params`, `tool.definition`, or `experimental.chat.messages.transform` at all.
2. **v1 → v2 migration.** The v2 line already documents a different plugin API (`Plugin.define`,
   `plugins` config key, domain transforms). Any adapter built on v1 hooks will need a migration path.
3. **Silent no-ops from wrong mutation style.** Replacing `output.args`, `output.parts` or
   `output.messages` instead of mutating in place produces no effect and no error — a correctness trap
   that requires tests.
4. **Result-shape variance across tool types** (built-in vs MCP) with a published type that documents
   only one of them.
5. **Truncation and compaction happen after/beside our hook**, so substituted content may be truncated
   or cleared; savings claims must be measured, not assumed.
6. **Repeated-read detection is an inference**, not a measurement; a "repeated" read may be legitimate
   (file changed, different range, earlier content evicted from context).
7. **Multiple sessions and concurrent requests.** The plugin context is a server client; per-session
   isolation and ordering are Dr. Token's responsibility.
8. **Third-party plugin coexistence.** Hooks run sequentially with other plugins; load order determines
   who sees what, and a badly behaved neighbour plugin can still throw.
9. **Distribution.** The core package is currently private; adopting it from a published plugin requires
   publishing `@dr-token/core` or bundling it.
10. **No runtime validation yet.** Every behavioural claim above comes from published types, official
    documentation and source reading — not from executing a plugin.

## 13. Proposed first adapter architecture

A thin adapter package (for example `integrations/opencode`, to be created in a later stage) that owns
**no optimization logic**:

```
OpenCode server (Bun)
 ├─ plugin: @dr-token/opencode-plugin        (thin, fail-open)
 │   ├─ tool.execute.before/after  → observe reads, count calls, (later) rewrite tool output
 │   ├─ event                      → token/cost accounting per session
 │   ├─ experimental.chat.messages.transform (flagged) → whole-context decisions
 │   └─ adapter core:
 │        buildArtifactRequest() → OptimizationRequest → OptimizerEngine.optimize()
 │        → apply only when contextUnchanged === false AND the mutation style is supported
 └─ shared engine @dr-token/core (bundled into the plugin)
```

Design rules:

1. **Artifact-first.** One `OptimizationRequest` per artifact that can actually be rewritten
   (tool result, tool args, message parts). Do not pretend to own the whole context unless the
   experimental hook is available.
2. **Fail-open everywhere.** No hook ever throws; every transformation is skipped when the engine
   returns the input or when the shape is unexpected.
3. **Bypass is explicit.** A single setting (plugin option or env var) disables all transformations;
   OpenCode's own behaviour is then untouched.
4. **Accounting uses the Stage 1B vocabulary.** Per-message tokens are `measured`; session totals and
   repeated-read counts are `calculated`; anything unknown is `unavailable`. No estimates, no
   savings claims without a controlled comparison.
5. **No content retention by default.** Store hashes, ids and counters; never raw prompts or files.
6. **Feature flags for experimental hooks** so the plugin keeps working on a release that renames or
   removes them.
7. **Capability detection at load.** Inspect the available hooks and log which capabilities are active,
   rather than assuming.

## 14. Recommendation for the next stage

Proceed with OpenCode as the first integration target, **observer-first**:

- **Stage 1D:** build a minimal, non-mutating OpenCode plugin that only *observes* — tool calls, read
  paths/ranges, repeated-read counts, per-message tokens and costs — and writes them into the Stage 1B
  report schema. No optimization, no context changes.
- Require an actual local OpenCode installation and a documented, non-billable validation procedure
  before relying on recorded metrics; the plugin must be installable per-project (never globally) and
  must not touch user credentials.
- Defer any transformation work until observation proves the accounting is accurate.
- Re-evaluate the v2 plugin API before committing to long-lived adapter code.

**Runtime validation is outstanding.** No hook was executed during this stage, so every capability
above is classified as source/documentation-confirmed rather than runtime-confirmed.

## 15. Stage 1E outcome (2026-10-10)

Stage 1E located the user's existing OpenCode Desktop installation and probed it read-only. It reports
**OpenCode 2.0.24** (Electron shell plus a bundled single-file CLI at
`%APPDATA%\ai.opencode.desktop\cli\2.0.24\opencode-cli.exe`), and that binary implements the **V2**
plugin API: `@opencode/plugin`, `ctx.tool`, `execute.before`/`execute.after`, `event.subscribe` are
present, while `tool.execute.before`, `tool.execute.after`, `chat.message`, the `experimental.*` hooks
and the string `@opencode-ai/plugin` appear **zero** times. OpenCode's V2 migration guide states that V1
plugin implementations do not run in V2.

The Stage 1D observer therefore could **not** be live-validated on this installation. Its packaging was
validated in the Desktop runtime instead (the built ESM bundle imports cleanly, exposes the four V1 hook
keys and has no dependencies), but no hook was executed, no session ran and no token field was observed.
No code was changed for this conclusion: bridging the gap is a V2 port (a different registration API),
not a packaging fix. Full evidence, procedures, security checks and limitations:
[docs/OPENCODE_DESKTOP_VALIDATION.md](OPENCODE_DESKTOP_VALIDATION.md).
