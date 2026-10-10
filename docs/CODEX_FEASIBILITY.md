# Codex integration feasibility

**Status:** research and isolated runtime probing complete; **observation-only Codex adapter implemented
(Stage 1L) and its hook registration runtime-verified**; hook delivery and tool observation still
unverified
**Research date:** 2026-10-10 (updated 2026-10-10, Stage 1L — see §15)
**Author:** Dr. Token development (Stage 1K)
**Related:** [docs/adr/0002-codex-integration.md](adr/0002-codex-integration.md) ·
[docs/OPENCODE_FEASIBILITY.md](OPENCODE_FEASIBILITY.md) ·
[docs/OPENCODE_OBSERVER.md](OPENCODE_OBSERVER.md)

This document records what OpenAI Codex actually exposes to a third-party optimizer on the machine
Dr. Token is developed on. Unlike Stage 1C (OpenCode), a **Codex installation was present**, so the
strongest claims here come from executing the installed binary against an **isolated `CODEX_HOME`**
and reading the protocol schema that the installed binary itself generates.

Three things are deliberately kept apart throughout:

1. what the **vendor documentation** promises (contract),
2. what the **installed version's generated schema and CLI** actually contain (runtime-observed),
3. what was **never executed** (hook delivery, tool observation, live token numbers).

---

## 1. Evidence vocabulary

| Classification | Meaning in this document |
| --- | --- |
| **Runtime-verified** | Observed by executing the installed Codex binary on this machine, in isolation. Reproducible from the commands recorded in §12. |
| **Contract-confirmed** | Stated by OpenAI's official documentation, quoted in §3. |
| **Source-confirmed** | Present in the public `openai/codex` source or published schema, not executed here. |
| **Unit-tested** | Covered by Dr. Token's own automated tests. Applies only to Dr. Token's components (the shared core, contracts, benchmark and the OpenCode adapter) — **not** to Codex behaviour, which no Dr. Token test can exercise yet. |
| **Unsupported** | Documented as unavailable, or contradicted by the documented contract. |
| **Unverified** | Not established by any of the above. Explicitly *not* a claim of support. |

A capability is never marked supported by inference alone.

---

## 2. Inspected environment

All checks were read-only. No global Codex configuration was modified, no conversation was opened,
no prompt or transcript was read, no credential was inspected, and **no model call was made**.

| Item | Observed value | How |
| --- | --- | --- |
| Codex CLI (bundled with the desktop app) | `codex-cli 0.162.0-alpha.17.2` | `<codex.exe> --version` |
| Platform | Windows 11 (`10.0.26200`), x86_64 | `codex doctor` |
| Executable | `%LOCALAPPDATA%\OpenAI\Codex\bin\<build-hash>\codex.exe` | process list + `codex doctor` |
| Builds on disk | two build hashes present under `...\Codex\bin\` | directory listing |
| Install method | `other` (bundled by the Windows app; not npm/cargo/winget on PATH) | `codex doctor` |
| Companion binaries | `codex-command-runner.exe`, `codex-code-mode-host.exe`, `codex-windows-sandbox-setup.exe`, `codex-windows-sandbox-service.exe`, `codex-computer-use-swift.exe` | directory listing + process list |
| Desktop surface | the Codex app for Windows is distributed inside the ChatGPT desktop app (`OpenAI.Codex` MSIX); the app launches its own Codex runtime | contract (§3 sources) |
| Live runtime (this machine) | pid A: `codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled -c features.prefer_mxc=true -c plugins.<…>.mcp_servers.<…>.enabled=true` · pid B: `codex.exe exec-server --remote https://codex-cloud-environments.chatgpt.com/api --environment-id <redacted>` | process command lines |
| Shared daemon control socket | **not present** (`%USERPROFILE%\.codex\app-server-control\` does not exist) | filesystem check |
| Codex home | `%USERPROFILE%\.codex` (config, sessions, SQLite stores — see §5.6) | directory listing (names only) |
| Isolated probe home | a temporary `CODEX_HOME` under `%TEMP%` used for every probe in §12 | created for this stage |

**Two important readings of the process table.** The desktop app runs the Codex runtime as a
**private `app-server` process it owns**, not as a discoverable local daemon — the documented control
socket is absent. And the app already launches that runtime **with plugin-provided MCP servers
enabled through `-c plugins.…` overrides**, which means the plugin mechanism is live in this
environment, not theoretical.

`Get-AppxPackage` returned no package row in the shell used for this research, so the exact MSIX
version of the desktop app is **unverified**; the Codex runtime version above is verified.

---

## 3. Official sources read

- Hooks — <https://developers.openai.com/codex/hooks> (redirects to `https://learn.chatgpt.com/docs/hooks`)
- App server — <https://developers.openai.com/codex/app-server> (`…/docs/app-server`)
- Plugins — <https://learn.chatgpt.com/docs/plugins> and Build plugins — <https://developers.openai.com/plugins/build/plugins>
- Configuration reference — <https://developers.openai.com/codex/config-reference> (`…/docs/config-file/config-reference`)
- Advanced configuration (OTel, `notify`) — <https://learn.chatgpt.com/docs/config-file/config-advanced>
- MCP — <https://developers.openai.com/codex/mcp>; MCP server removal notice — <https://developers.openai.com/codex/mcp-server>
- Windows app / sandbox — <https://learn.chatgpt.com/docs/windows/windows-app>, `…/windows-sandbox`
- Repository — <https://github.com/openai/codex>; app-server implementation `codex-rs/app-server`; plugin manifest parser `codex-rs/core-plugins/src/manifest.rs`; hook discovery `codex-rs/hooks/src/engine/discovery.rs`

---

## 4. What Codex exposes

### 4.1 Lifecycle hooks — the primary extension surface

**Contract-confirmed** and **runtime-verified present** in the installed build (`hooks` is a `stable`
feature flag that is enabled — §4.6).

- Hook sources, in order of practical interest: `%USERPROFILE%\.codex\hooks.json`,
  `%USERPROFILE%\.codex\config.toml` (`[hooks]` tables), `<repo>\.codex\hooks.json`,
  `<repo>\.codex\config.toml`, and hooks bundled by an enabled plugin. All matching sources run;
  a higher-precedence layer does not replace a lower one.
- Handler types on the wire: `command`, `mcpTool`, `prompt`, `agent`. Only `command` and `mcpTool` are
  executed; `prompt`/`agent` are parsed and skipped.
- Per-handler settings: `command` (or `commandWindows` / `command_windows` on Windows), `timeout`
  (seconds, 600 default), `async`, `statusMessage`, `additionalContextLimit`, `matcher` (regex).
- Non-managed hooks are **hash-trusted**: Codex stores trust against the hash of the exact hook
  definition, and new or changed definitions are skipped until reviewed (`/hooks` in the CLI, or
  managed policy in `requirements.toml`).

Observed event names on the wire (the protocol enum, **runtime-verified**):
`preToolUse`, `permissionRequest`, `postToolUse`, `preCompact`, `postCompact`, `sessionStart`,
`sessionEnd`, `userPromptSubmit`, `subagentStart`, `subagentStop`, `stop`, `interrupt`.

### 4.2 What a hook can see

Common fields on every command hook (JSON on stdin): `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`, and `turn_id` / `permission_mode` for turn-scoped events.

Event-specific payload (**contract-confirmed**):

| Event | Additional fields |
| --- | --- |
| `PreToolUse` | `tool_name`, `tool_use_id`, `tool_input` |
| `PostToolUse` | `tool_name`, `tool_use_id`, `tool_input`, **`tool_response`** (the model-facing tool output) |
| `PermissionRequest` | `tool_name`, `tool_input` |
| `UserPromptSubmit` | `prompt` (the user prompt about to be sent) |
| `SessionStart` | `source` = `startup` \| `resume` \| `clear` \| `compact` |
| `SessionEnd` | `reason` (currently always `other`) |
| `PreCompact` / `PostCompact` | `trigger` = `manual` \| `auto` |
| `Stop` / `SubagentStop` | `stop_hook_active`, `last_assistant_message` (+ `agent_*` for subagents) |

Tool coverage documented as: shell commands (`Bash`), unified exec, `apply_patch` (also matched as
`Edit`/`Write`), MCP tool calls, and **other local function tools**. **Hosted tools such as
`WebSearch` are explicitly not covered**, and the docs warn that "some specialized tool paths can opt
out" — hooks are a *guardrail*, not a complete enforcement boundary.

### 4.3 What a hook can change (host-sanctioned influence)

| Capability | Event | Documented effect |
| --- | --- | --- |
| Inject model-visible context | `PreToolUse`, `PostToolUse`, `SessionStart`, `SubagentStart`, `UserPromptSubmit` | `hookSpecificOutput.additionalContext` is added as developer context (plain stdout text does the same for `SessionStart`/`UserPromptSubmit`) |
| **Replace the model-visible tool result** | `PostToolUse` | `decision: "block"` with a `reason`, or `continue: false`, replaces the tool result with the hook's text and the model continues from there (the tool's side effects are *not* undone) |
| **Rewrite tool arguments** | `PreToolUse` | `permissionDecision: "allow"` + `updatedInput` replaces the arguments (string `command` for Bash/apply_patch; full argument object for MCP/function tools) |
| Deny a tool call | `PreToolUse` / `PermissionRequest` | `permissionDecision: "deny"`, legacy `decision: "block"`, or exit code 2 with the reason on stderr |
| Reject or annotate a prompt | `UserPromptSubmit` | `additionalContext`, or `decision: "block"` to block the prompt |
| Steer continuation | `Stop` / `SubagentStop` | `decision: "block"` + `reason` creates a continuation prompt |
| Influence compaction | `PreCompact` / `PostCompact` | `continue: false` stops before/after compaction |
| Re-inject context after compaction | `SessionStart` with `source: "compact"` | `additionalContext` is delivered to the immediate continuation, including mid-turn automatic compaction |

**Bounded output.** Each model-visible hook message is capped at roughly **2,500 tokens**
(`additionalContextLimit` tunes it; oversized text is *spilled* to
`<temp_dir>/hook_outputs/<session_id>/<uuid>.txt` and replaced with a head/tail preview).

**Asynchronous hooks cannot influence anything** — the docs state they cannot block, approve, rewrite
or control the operation that triggered them. Influence requires a synchronous hook, i.e. real
latency inside the agent loop.

### 4.4 App server — the programmatic protocol

**Contract-confirmed** and **runtime-verified**: the installed binary ships
`codex app-server`, `codex app-server daemon` (start/stop/restart/version/enable-remote-control),
`codex app-server proxy`, and — critically — **`app-server generate-ts` and
`generate-json-schema`**, which emit the version-exact protocol schema. The command block in §12 shows
how the schema used in this document was generated.

- Transports: `stdio://` (default, newline-delimited JSON-RPC 2.0), `ws://` (experimental), `unix://`,
  and `off`.
- Handshake: one `initialize` request per connection with `clientInfo`, then `initialized`.
  `capabilities.experimentalApi` gates a documented experimental subset — **verified by rejection**:
  `server/diagnostics` returned `requires experimentalApi capability` when the capability was absent.
- Primitives: thread (conversation) → turn → item, with `thread/start`, `thread/resume`,
  `thread/fork`, `thread/read`, `thread/list`, `thread/turns/list`, `thread/items/list`,
  `thread/search`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/compact/start`, and more.
- The running server enumerated **174 method names** for the installed version (§12, item 1). Notable
  families: `account/*`, `thread/*`, `turn/*`, `hooks/list`, `plugin/*`, `marketplace/*`, `skills/*`,
  `mcpServer*/…`, `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read`,
  `windowsSandbox/*`, `remoteControl/*`, `experimentalFeature/list`, `rollout/compress`,
  `memory/status`, `memory/reset`, `getConversationSummary`, `gitDiffToRemote`, `review/start`.
- Notifications are pushed on the same connection: `thread/tokenUsage/updated` is one of them (§5.1),
  and a live notification was observed during the probe (§12, item 3).

**This is a client/server integration API, not a listener on someone else's session.** A client
subscribes to the threads it starts or resumes; the docs' `thread/unsubscribe` exists precisely
because subscription is per-connection. The app-server is also explicitly labelled *experimental and
not supported for production workloads*, and it was launched as a **private child process** of the
desktop app on this machine, with no control socket to attach to.

### 4.5 Plugins — the packaging and distribution surface

**Contract-confirmed**, and **runtime-verified in use** on this machine (11 enabled plugins across
two marketplaces in the user's existing config, and plugin MCP servers passed to the running
app-server as `-c plugins.…` overrides).

- Manifest: `.codex-plugin/plugin.json` (compatible layout) or a portable root `plugin.json` whose
  OpenAI-specific settings live under `extensions.com.openai`. Recognized capability keys include
  `skills`, `mcpServers`, `apps`, `hooks`, `interface`, `extensions`.
- Hooks default to `hooks/hooks.json` inside the plugin root; a manifest `hooks` entry may also point
  at `./`-prefixed paths, an inline object, or an array of either. Hook commands receive
  `PLUGIN_ROOT` and `PLUGIN_DATA` (plus `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` compatibility vars).
- Installation is marketplace-based: `codex plugin marketplace add <owner/repo | git url | local path>`
  then `codex plugin add <plugin>@<marketplace>`; a local marketplace is a JSON file at
  `.agents/plugins/marketplace.json` (personal: `~/.agents/plugins/marketplace.json`).
- Surfaces: **CLI and the Codex desktop app support plugins**; the IDE extension does not.
  "Lifecycle hooks are supported for plugins installed manually in Codex desktop", and plugins that
  bundle lifecycle hooks are **not eligible for the public plugin directory**.
- Current plugins are enabled per plugin via `[plugins."<name>@<marketplace>"] enabled = true` in
  `config.toml` — which is how Dr. Token would be enabled and, importantly, disabled.

### 4.6 Feature flags (installed build, runtime-verified)

`codex features list` reports stage and effective state. Relevant entries:

| Flag | Stage | Enabled |
| --- | --- | --- |
| `hooks` | stable | **true** |
| `plugins` | stable | **true** |
| `apps` | stable | true |
| `unified_exec` | stable | true |
| `code_mode_host` | stable | true |
| `enable_request_compression` | stable | true |
| `compaction_image_budget` | stable | true |
| `guardian_approval` | stable | true |
| `daemon_auto_start` | stable | true |
| `context_management` | under development | false |
| `executed_tool_call_metadata` | under development | false |

So the two surfaces Dr. Token needs — hooks and plugins — are **stable and on** in the installed
build, while some adjacent capabilities are explicitly unfinished.

### 4.7 MCP — and what it is *not*

**Contract-confirmed.** Codex consumes external MCP servers (`[mcp_servers.<id>]`, `codex mcp …`),
and a hook of type `mcpTool` can call a tool on an **already-connected** server with
`input: { "path": "${tool_input.file_path}" }` template expansion. The former `codex mcp-server`
command no longer exists, and the docs state app-server "isn't an MCP server or a drop-in replacement
for an MCP client".

**Answering the stage's critical question directly: an MCP server is not transparent middleware.**
A Dr. Token MCP server would receive only the calls Codex chooses to make to *its* tools. It would
not see the agent's other tool calls, its prompts, or its model context, and it could not rewrite a
tool result. The only way an MCP server participates in interception is **as the target of an
`mcpTool` hook**, i.e. because hooks are configured — the capability comes from hooks, not from MCP.

---

## 5. Usage and token observation

### 5.1 app-server usage (`runtime-verified` schema)

- **`thread/tokenUsage/updated`** notification:
  `{ threadId, turnId, tokenUsage: { last, total, modelContextWindow } }` where each breakdown is
  `{ inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
  totalTokens }`. **`last` is the per-turn figure; `total` is cumulative — both are available live.**
- **`account/tokenUsage/read`** response: `summary` (account-level: `lifetimeTokens`,
  `peakDailyTokens`, `currentStreakDays`, `longestStreakDays`, `longestRunningTurnSec`),
  `dailyUsageBuckets` (`{ startDate, tokens }`), and — when a `threadId` is supplied — a `threadUsage`
  object carrying **`estimatedUsageUsdMicros`** and **`estimatedUsageCreditsMicros`**, broken down by
  `model`, `reasoningEffort`, `speed`, `inputTokens`, `cachedInputTokens`, `outputTokens`,
  `netNewInputTokens`, `totalTokens`.
- **`RawResponseCompletedNotification`** carries per-upstream-response `ResponseUsageMetadata`.
- The method requires an authenticated Codex account. In the isolated probe it returned
  *"codex account authentication required to read token usage"* — **method exists (runtime-verified),
  data not read (deliberately)**.
- `account/rateLimits/read` exists on the same terms (*"…required to read rate limits"*), and
  `account/rateLimitResetCredit/consume` is also present.

**Cost note.** Unlike the file formats below, the app-server *does* expose an **estimated** cost
(micros USD / credits) for a thread. It is labelled "estimated" and is only present when the billing
route is available, so it must still be recorded as *estimated*, never as measured savings.

### 5.2 Local rollout transcripts (`source-confirmed`)

`%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-<timestamp>-<thread-id>.jsonl` (the tree on this
machine is populated) records conversation events, including an `event_msg` of type `token_count`
carrying `total_token_usage`, `last_token_usage`, `model_context_window`, and sometimes a
`rate_limits` snapshot. **Cumulative counters must not be summed as if each record were a turn**, and
`rate_limits` may be `null`. No authoritative dollar figure exists in this format.

### 5.3 `codex exec --json` (`source-confirmed`)

A JSONL event stream (`thread.started`, `turn.started`, `item.started/updated/completed`,
`turn.completed`, `error`) where `turn.completed.usage` carries `input_tokens`,
`cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`.
Failed turns carry an error, not usage. This is the cleanest *one-shot* measurement path and is
useful for Dr. Token's benchmarks (it needs a real model call, so it stays an authorized-run path).

### 5.4 OpenTelemetry (`contract-confirmed`)

`[otel]` supports log/trace/metric exporters (`none` | `otlp-http` | `otlp-grpc`; metrics default
`statsig`), with `otel.log_user_prompt` defaulting to *false* (prompt content is redacted unless
opted in). Documented metrics include a per-turn token-usage histogram (`codex.turn.token_usage`,
with `token_type` of `total`/`input`/`cached_input`/`output`/`reasoning_output`) and a compaction
counter (`task.compact`). OTel is the only path that yields *streaming metrics with no local log
parsing*, at the cost of configuring an exporter — and a GitHub report notes one specific 0.144.x
build missing the metric for `exec` while the TUI emitted it, so it must be verified per version.

### 5.5 Nothing measures "savings"

No Codex surface reports "tokens Dr. Token saved". Measured per-turn usage, plus a controlled
baseline, is the only honest route, exactly as in the OpenCode benchmark model.

### 5.6 Local persistence (names only, runtime-verified)

`config.toml`, `auth.json` (not read), `sessions/`, `archived_sessions/`, `session_index.jsonl`,
`state_5.sqlite`, `thread_history_1.sqlite` (~98 MB), `logs_2.sqlite`, `memories_1.sqlite`,
`goals_1.sqlite`, `queue_1.sqlite`, `skills/`, `plugins/`, `rules/`, `.sandbox*`, `thread-writer-locks/`.

**Already-present integrations that a Dr. Token adapter must coexist with** (key names only, read
from the user's config): a `notify` program is already configured; 11 plugins are enabled across the
`openai-bundled` and `openai-primary-runtime` marketplaces; an `[mcp_servers.node_repl]` server is
configured with an explicit env allowlist; `model`, `model_reasoning_effort` and `service_tier` are
set; `[windows] sandbox` is configured. There is **no** `hooks.json` and no `hooks/` directory in the
real home, so a Dr. Token hook set would be additive rather than a conflict — but the `notify`
program is a **single-valued key**, so Dr. Token must not claim or overwrite it.

---

## 6. Capability matrix

| Capability | Classification | Desktop | CLI | Note |
| --- | --- | --- | --- | --- |
| Dr. Token shared core the adapter would reuse (contracts, engine, sink, benchmark vocabulary) | **Unit-tested** | n/a | n/a | 376 tests passing; **no Codex adapter exists yet**, so nothing here exercises Codex |
| Lifecycle hooks (12 events) | Runtime-verified (discovery) / Contract-confirmed (delivery) | plugin-bundled documented; user-level presumed, see §13 | yes | `preToolUse` … `interrupt` |
| Tool input observation | Contract-confirmed | same runtime | same | `tool_input`, `tool_name`, `tool_use_id` |
| Tool output observation | Contract-confirmed | same runtime | same | `tool_response` on `postToolUse` |
| **Replace model-visible tool result** | Contract-confirmed | same runtime | same | `postToolUse` `decision: "block"` / `continue: false` |
| Rewrite tool arguments | Contract-confirmed | same runtime | same | `preToolUse` `updatedInput` |
| Inject context into the model | Contract-confirmed | same runtime | same | `additionalContext`; ~2.5k-token cap |
| Reject/annotate user prompt | Contract-confirmed | same runtime | same | `userPromptSubmit` |
| Observe compaction + influence it | Contract-confirmed | same runtime | same | `preCompact`/`postCompact`, `compact_prompt`, `model_auto_compact_token_limit` |
| Hook discovery + trust state, programmatically | **Runtime-verified** | over app-server | `hooks/list` | includes `currentHash`, `trustStatus`, `source` |
| Hosted-tool coverage (e.g. `WebSearch`) | Unsupported | — | — | documented exclusion |
| Whole-context/message-array interception | Unsupported | — | — | no hook exposes the message list |
| Transparent provider-request rewrite | Unsupported without patching/proxy | — | — | no supported pre-request hook |
| app-server handshake + method surface | Runtime-verified | client-owned threads | yes | 174 methods; experimental |
| Attach to the *running desktop* app-server | Unverified | no socket present | n/a | private stdio child process |
| Live per-turn token usage (app-server) | Runtime-verified schema | for client-owned threads | yes | `thread/tokenUsage/updated` |
| Account/thread usage + estimated cost | Runtime-verified method, auth-gated | needs account | needs account | `account/tokenUsage/read` |
| Rollout JSONL usage records | Source-confirmed | shared store | shared store | `event_msg`/`token_count` |
| `exec --json` per-turn usage | Source-confirmed | n/a | yes | needs a model call |
| OTel metrics export | Contract-confirmed | yes | yes | `codex.turn.token_usage` |
| Plugins as packaging surface | Runtime-verified (in use) | yes | yes | IDE extension: no |
| `notify` turn-complete program | Contract-confirmed | ? | yes | single-valued; **already in use here** |
| MCP client | Runtime-verified (configured) | yes | yes | participation in interception only via hooks |
| Codex as MCP server | Unsupported | — | — | command removed |
| Binary patching / injection | Out of scope | — | — | not considered |

---

## 7. Desktop versus CLI

| Aspect | Desktop app (this machine) | CLI |
| --- | --- | --- |
| Distribution | ChatGPT desktop app (`OpenAI.Codex` MSIX), bundles its own Codex runtime under `%LOCALAPPDATA%\OpenAI\Codex` | same bundled `codex.exe`; separate install path also documented |
| Shared state | shares `%USERPROFILE%\.codex` (config, plugins, sessions, SQLite stores) | same home; WSL CLI does not share unless `CODEX_HOME` is synchronized |
| Runtime shape | runs `app-server` as its own private child process | runs the TUI, or `app-server`/`exec` on demand |
| Plugins | supported ("lifecycle hooks are supported for plugins installed manually in Codex desktop") | supported (`/plugins`) |
| IDE extension | not applicable | plugins **not** supported in the IDE extension |
| Sandbox | native PowerShell + Windows sandbox; MXC preferred on capable hardware (`features.prefer_mxc=true` observed) | MXC opt-in via config |
| Headless automation | not the primary surface | `codex exec`, `exec --json`, `app-server` |

**Practical consequence:** anything Dr. Token ships must be a **plugin + hooks** artifact, because
that is the only documented surface present in *both* the desktop app and the CLI. A CLI-only
integration (e.g. `notify` or an app-server client) would leave the desktop experience — the one the
user actually runs — uncovered.

---

## 8. Feasible architectures

### A. Plugin-bundled lifecycle hooks (command handlers) — **recommended**

Dr. Token ships as a Codex plugin whose `hooks/hooks.json` registers `PostToolUse` (observe and,
where the engine decides, replace the tool result), `PreToolUse` (observe arguments; rewrite only
through the documented `updatedInput` path), `UserPromptSubmit` (observe the prompt, optionally
annotate), `SessionStart` (inject bounded project context, including after `compact`),
`PreCompact`/`PostCompact` (observe compaction), `Stop` (continuation policy, later), and
`SessionEnd` (flush state, cleanup). The hook process is a thin Node/TS entry point over the shared
core — the same "adapter is thin, engine is shared" shape as the OpenCode adapter.

- Feasibility: high — documented, stable-flagged, runtime-discoverable.
- Desktop: yes (plugins are a desktop-supported surface). CLI: yes.
- Correctness/safety: influence is limited to explicitly documented shapes; failures at the hook
  boundary are non-fatal by design (`PreToolUse` callback errors "fail the hook without blocking the
  tool"); every hook can exit 0 with no output.
- Usage measurements: none in the hook payload — must come from §5.
- Safe Mode: yes — this is where a "replace repeated read with a canonical view" behaviour would live,
  and it is exactly the artifact-level influence the engine already models.
- Setup: add a local marketplace, install the plugin, review and trust the hooks.
- Maintenance: medium; hooks are a stable, documented contract, and the plugin manifest is simple.
- Performance: one synchronous process spawn per matching event; bounded output (~2.5k tokens);
  `async: true` is possible for observation-only hooks but cannot influence.
- Compatibility with the shared core: excellent — the adapter only marshals JSON to/from the engine.

### B. Observation-only companion (hooks with no transformation, plus app-server or rollout reads)

The same plugin, but every hook returns nothing and only records observations; usage is read from
rollout transcripts or app-server. This is the **Stage-1D analogue** for Codex: prove observation
before optimizing. Lowest risk, and it can ship before any transformation is trusted.

### C. app-server client for measurement and history

Connecting to `codex app-server` (own instance) gives `thread/tokenUsage/updated`,
`account/tokenUsage/read` (auth), `thread/list`/`thread/read`/`thread/search`, `hooks/list`,
`config/read`. Useful for **reporting**, for validating Dr. Token's own hook accounting, and for
`--remote`-style headless operation — but it is **not** a listener on the user's desktop session
(§4.4), and it is documented as experimental/unsupported for production. Good as a *secondary*
surface; unsuitable as *the* interception layer.

### D. `notify` turn-complete program

Turn-complete payload only (`thread-id`, `turn-id`, `cwd`, `input-messages`,
`last-assistant-message`); single-valued and already used on this machine; no tool-level view and no
influence. **Rejected as an integration surface** (may be mentioned as a nicety later, never claimed).

### E. MCP server as middleware

**Rejected**: an MCP server only receives calls Codex makes to it; it cannot observe or transform the
rest of the agent loop (§4.7). MCP remains valuable as a *target* for `mcpTool` hooks and for
provider-side work (e.g. a canonical read tool), not as transparent middleware.

### F. Provider proxy / binary patching / credential interception

**Rejected and out of scope**: bypasses host permissions, duplicates auth and streaming, and would
break on release. Not considered further.

---

## 9. Recommended adapter boundary

`integrations/codex` (future stage), mirroring the OpenCode adapter's discipline:

```
Codex runtime ──(hook JSON on stdin)──▶ dr-token-codex-hook (thin entry point)
                                            │
                                            ├─ shared @dr-token/core engine (no logic duplicated)
                                            ├─ observation records → existing sink (same schema)
                                            └─(hook JSON on stdout)──▶ Codex: additionalContext /
                                                 updatedInput / decision:block / continue:false
Codex runtime ──(app-server notifications / rollout)──▶ usage provenance reader (measurement only)
```

Non-negotiable properties of that boundary:

1. **Fail-open, always.** Any error, timeout, malformed payload, or missing engine ⇒ print nothing and
   exit 0. A hook must never be able to break a turn.
2. **Opt-in and revocable.** Enabled by installing the plugin and trusting the hook hashes; disabled
   by removing the plugin, by `/hooks`, or by `[features] hooks = false`. The user's existing `notify`
   program is never touched.
3. **Bounded and cleanup-safe.** Per-`session_id` state, bounded size, flushed and released on
   `SessionEnd`; no unbounded journal; stale state for unknown sessions ignored (the OpenCode
   adapter's dispose discipline, reused).
4. **Honest provenance.** Per-turn numbers from `thread/tokenUsage/updated`, rollout `token_count` or
   `exec --json` are *measured*; `estimatedUsageUsdMicros`/`estimatedUsageCreditsMicros` are
   *estimated*; anything else is *unavailable*. No savings claim without a controlled comparison.
5. **Documented influence only.** `updatedInput` with `permissionDecision: "allow"`, `additionalContext`,
   `decision: "block"`/`continue: false`. No `--dangerously-bypass-hook-trust`, no config tampering on
   the user's behalf, no writes to `config.toml` (even though `config/value/write` exists).
6. **Observation before optimization.** First deliverable on Codex is §8.B: hooks that record and
   return nothing; transformation is enabled only after a controlled experiment (§11) shows it is
   safe, exactly as the project's Safe → Aggressive → Balanced ordering requires.

---

## 10. Security, privacy and operational risks

| Risk | Assessment | Mitigation in the design |
| --- | --- | --- |
| Hook is a shell command run inside the agent loop | High trust boundary; Codex explicitly requires review/trust of non-managed hooks | Rely on hash-based trust review; never request `--dangerously-bypass-hook-trust` in product usage |
| Hook output is written to disk when oversized | `hook_outputs/<session>/<uuid>.txt` under temp | Never return secrets; keep injected context small and content-free of credentials |
| Tool results can contain secrets/paths | `tool_response` is the model-facing output | Reuse the OpenCode adapter's `expectNoSecrets` discipline; redact absolute paths before persisting |
| Notifications carry account/installation identifiers | `remoteControl/status/changed` included `installationId`; `account/*` is account data | Do not persist identifiers; keep account-level reads off by default and behind explicit consent |
| Reading the user's sessions | rollout transcripts and `thread_history_1.sqlite` contain real conversations | Out of scope for the adapter; only *Dr. Token's own per-session observations* are written, into Dr. Token's own sink |
| Latency added to every matching event | Synchronous hooks block the loop | Small bounded work, hard timeouts, engine short-circuit, measured against the "correctness first" rule |
| Hook coverage gaps (hosted tools, opt-out paths) | Documented incompleteness | Never describe hooks as complete enforcement; report coverage explicitly |
| Experimental app-server surface | Docs say experimental/unsupported for production | Use only for measurement/reporting, behind feature detection; degrade to no-usage gracefully |
| Version drift (`alpha` runtime, moving schema) | Installed runtime is `0.162.0-alpha.17.2`; docs warn schemas differ per version | Detect capability at runtime (`hooks/list`, `features list`), never hard-code; keep the adapter thin |
| Coexistence with existing integrations | `notify` and 11 plugins already configured | Additive only; no rewriting of user config; no capture of the single-valued `notify` key |
| First-run side effects of starting app-server | The isolated probe created its own SQLite stores and a plugin-sync temp clone | Document that starting a server has local state effects; never start servers in the user's home |

---

## 11. Runtime validation requirements

The following must be executed (with explicit user authorization for any model call) before any
optimization claim or adapter release:

1. **Hook delivery, one turn, isolated home.** Disposable `CODEX_HOME`; plugin-bundled hooks;
   perform a single small turn in a scratch project; assert that `SessionStart`, `PreToolUse`,
   `PostToolUse` (with `tool_response`), `UserPromptSubmit`, and `SessionEnd` fire with the documented
   fields, and record what `transcript_path` actually contains.
2. **Desktop-app delivery.** Repeat under the **desktop app** (not just the CLI) to confirm that
   user-level and plugin-bundled hooks execute in the app-server runtime that the desktop app owns —
   this is the single largest unverified assumption in this document.
3. **Influence fidelity.** Verify `additionalContext` reaches the model, that `updatedInput` actually
   replaces arguments, and that `PostToolUse` `decision: "block"` / `continue: false` replaces the
   model-visible tool result; measure the 2,500-token cap and spilling behaviour on Windows.
4. **Fail-open and cleanup.** Kill the hook process mid-turn; return malformed JSON; return a slow
   hook past its timeout; assert the turn continues and no state leaks.
5. **Usage provenance.** Compare `thread/tokenUsage/updated` for a client-owned thread against the
   rollout `token_count` records and `exec --json` for the same turn; confirm whether hook-injected
   context is reflected in the numbers; confirm `account/tokenUsage/read` estimates with the user's
   consent.
6. **Controlled savings experiment.** Baseline vs Dr. Token run over the same benchmark fixture set,
   correctness first, then tokens — never a savings claim from a single run.
7. **Windows specifics.** Confirm `command_windows`/`commandWindows` resolution, PATH/`node`
   availability inside the sandbox, and behaviour under `features.prefer_mxc=true`.

---

## 12. Reproducing the runtime evidence

Commands were executed read-only against the installed binary; the isolated home is a `%TEMP%`
directory and the user's `%USERPROFILE%\.codex` was never opened for writing.

```bash
CODEX="%LOCALAPPDATA%\OpenAI\Codex\bin\<build-hash>\codex.exe"
"$CODEX" --version                 # codex-cli 0.162.0-alpha.17.2
"$CODEX" features list             # hooks/plugins = stable, enabled
"$CODEX" doctor                    # install method, runtime, platform
"$CODEX" app-server --help         # daemon | proxy | generate-ts | generate-json-schema
"$CODEX" app-server generate-json-schema --out <tmp>/schema   # 39 top-level + 278 v2 files
```

1. **Method enumeration (§4.4).** Sending an unknown method to a live `app-server` returns the valid
   variant list: 174 methods, captured from the server itself.
2. **Handshake (§12, item 2).** `initialize` (with `clientInfo`) + `initialized` over `stdio://` against an
   isolated `CODEX_HOME` returns `userAgent …/0.162.0-alpha.17.2 (Windows 10.0.26200; x86_64)`,
   `codexHome`, `platformFamily: windows`, `platformOs: windows`.
3. **Live notification.** The same connection received `remoteControl/status/changed` — real
   server-push delivery, not just a request/response echo.
4. **Hook discovery (`hooks/list`, §6).** With a probe `hooks.json` in the isolated home, the server
   returned each definition with `key`, `eventName` (`postToolUse`, `preCompact`, `userPromptSubmit`),
   `handlerType: "command"`, `matcher`, `timeoutSec`, `statusMessage`, `source: "user"`,
   `sourcePath`, `displayOrder`, `enabled`, `isManaged: false`, `currentHash: sha256:…`, and
   `trustStatus: "untrusted"`.
5. **Usage endpoints (§5.1).** `account/tokenUsage/read` and `account/rateLimits/read` both returned
   *"codex account authentication required…"* — the methods exist; the data was intentionally not read.
6. **Experimental gating.** `server/diagnostics` was rejected with
   `requires experimentalApi capability` until `capabilities.experimentalApi: true` was sent.
7. **`config/read`** returned the effective configuration key set (including
   `model_auto_compact_token_limit`, `tool_output_token_limit`, `compact_prompt`, `otel`,
   `experimental_thread_store`), with values omitted here.

**What the probe deliberately did not do:** no `turn/start` (so no model request and no spend), no
read of `auth.json`, no read of any rollout transcript or SQLite conversation store, no start of a
server against the user's real `CODEX_HOME`, and no modification of global configuration.

---

## 13. Open questions

1. Does the **desktop app** honour user-level `~/.codex/hooks.json` hooks, or only plugin-bundled
   hooks? (Documented support exists for manually-installed desktop plugins; user-level hooks are
   presumed but not verified here.)
2. Are hook commands executed inside the Windows sandbox (`prefer_mxc`) and with which environment?
3. Is `transcript_path` populated in the desktop runtime, and is the file readable while the turn runs?
4. Do multiple matching hooks that both return `decision` interact as documented (deny wins for
   permissions; what about two `PostToolUse` replacements)?
5. Are hook-injected `additionalContext` tokens visible in any usage counter, or invisible overhead?
6. Does a hook-replaced tool result change how the runtime counts the tool output?
7. Is there any supported way to observe a *live* desktop session without owning the app-server
   process, or is per-session hook observation the only path?
8. Does `notify` coexist cleanly with hooks on the same turn, and is its payload stable enough to be a
   convenience signal only?
9. Will the `hooks` feature flag and plugin manifest keys stay stable across the `0.162.x` line?
10. Does the estimated-cost field (`estimatedUsageUsdMicros`) reflect subscription plans, or is it
    API-billing-only?

---

## 14. Feasibility verdict

**Feasible — with host-sanctioned influence, not transparent interception.**

Codex exposes a **stable, documented, runtime-discoverable lifecycle-hook framework** that can:

- observe tool inputs, tool outputs (`tool_response`), and user prompts;
- **replace the model-visible tool result** after a tool has run;
- rewrite tool arguments, inject bounded model-visible context, reject prompts, and influence
  continuation and compaction;
- be packaged, distributed and disabled through the plugin mechanism that the desktop app already
  uses on this machine.

That is sufficient for Dr. Token's artifact-level optimization model, and it is closer to the
OpenCode adapter's shape than expected: a thin entry point over the shared engine, with fail-open
semantics and a per-session lifecycle.

**What Codex cannot do** — and Dr. Token must not claim otherwise:

- it cannot intercept or rewrite the **provider request** or the **whole message array**;
- it cannot observe **hosted tools** (`WebSearch` and similar);
- an **MCP server is not middleware**; participation in interception requires hooks;
- **usage is not in the hook payload** — measured usage must come from app-server notifications,
  rollout `token_count` records, `exec --json`, or OTel, and account-level/estimated cost is
  auth-gated and *estimated*;
- there is **no supported way to attach to the desktop app's running session** on this machine today.

Because delivery, influence fidelity, and desktop-app hook execution were **not** runtime-verified in
this stage, every transformation claim remains pending §11's authorized experiment. The recommended
next stage is therefore an **observation-only Codex adapter** (hooks that record and return nothing),
followed by a controlled single-turn validation, before any optimization is enabled.

That recommended stage was then executed — see §15.

---

## 15. Stage 1L update — observation-only adapter, and hook registration now runtime-verified

Stage 1L built exactly the observation-only adapter §14 called for, in `integrations/codex`
(`@dr-token/codex-observer`), and pushed the verification ladder one rung further: **Codex now
enumerates Dr. Token's hooks from Dr. Token's own configuration.** Nothing in §1–§14 above is
withdrawn; the additions and the one changed classification are recorded here.

**New runtime-verified evidence (reproducible with no model call)**

In an isolated `CODEX_HOME` under `%TEMP%` (the user's `%USERPROFILE%\.codex` was never written), the
installed `codex-cli 0.162.0-alpha.17.2` was driven over the documented `stdio://` app-server
transport with the `initialize`/`initialized` handshake, then asked for `hooks/list`. Result:

- **all 12 hooks were discovered**, one per documentation-listed lifecycle event, each reporting
  `handlerType: "command"`, `enabled: true`, `isManaged: false`, `source: "user"`;
- each definition's command resolved to the built adapter entry point (`dist/entry.js`), and the
  Windows command form (`commandWindows`) was resolved against the current platform;
- every definition reported **`trustStatus: "untrusted"`** with a `currentHash` — i.e. Codex's
  review-before-run gate applies to Dr. Token exactly as §10 predicted, and Dr. Token does not bypass
  it (`--dangerously-bypass-hook-trust` is absent from every procedure and product path).

That moves **hook registration/discovery** from *unverified* to **runtime-verified**. It does **not**
move hook execution: the check sent no `turn/start`, so **no model call was made and no hook body was
executed by Codex**. §6's `hooks/list` findings are unchanged and consistent with this probe.

**What the adapter is (and is not)**

- Registers exactly the 12 documented events; records content-free counters, tool names/ids, JSON
  *kinds* of tool responses, and one-way hashed read/directory identities.
- **Writes nothing to stdout and always exits 0** — verified by tests that spawn the real entry point —
  so it cannot inject context, rewrite tool arguments, block a tool or reject a prompt. This is a
  stronger statement than §9's "documented influence only": influence is not merely unused, it is
  unreachable.
- Uses **no app-server/rollout/OTel measurement path** yet: every usage measurement is reported as
  `unavailable`, with the §5.1/§6 sources named as the future provenance options. Nothing is derived
  from text length.
- Persists across the **process boundary** that §9 item 3 anticipated (one process per hook): an
  append-only per-session journal plus an atomically-written compacted snapshot under
  `<temp>/dr-token-codex-observer`, with bounds, a stale-lock rule and a sweep for sessions that never
  ended. No database, no daemon.

**Newly classified evidence**

| Capability | Stage 1K | Stage 1L |
| --- | --- | --- |
| Hook event set / payload fields | Contract-confirmed | Contract-confirmed (vendored fixture; `typecheck` fails on drift) |
| Hook registration & trust status | Runtime-verified (probe hooks) | **Runtime-verified for Dr. Token's own hooks (all 12)** |
| Adapter module loading under Node | — | Unit-tested + entry-point process tests |
| Cross-process observation state | — | Unit-tested, including concurrent hook processes |
| Hook execution during a turn | Unverified | **Still unverified** (needs an authorized turn; §11 item 1) |
| Tool observation on the live path | Unverified | Unverified (parser/accumulator unit-tested against documented payloads) |
| Desktop-app delivery (§11 item 2) | Unverified | **Still unverified** |
| Token/cost measurement | Unsupported | Unsupported; reported `unavailable` |

**Updated open questions.** §13 item 1 (desktop-app delivery) and items 2–3 (sandbox/PATH,
`transcript_path`) remain open and are now the *only* blockers to a live observation claim. Added in
Stage 1L: which read-like tools a real Codex session actually calls (the adapter refuses to guess, so
expecting `unidentifiedRequests > 0` on real sessions is correct behaviour, not a defect), and whether
any of them reports read ranges.

**Recommendation.** The next Codex stage should be §11 items 1–4 under an explicit, scoped
authorization — one small turn in a disposable home, plus fail-open injection — rather than any
optimization work. Details, installation, removal and the exact procedure:
[docs/CODEX_OBSERVER.md](CODEX_OBSERVER.md).

---

## 16. Stage 1M update — lifecycle hook delivery is now runtime-verified

Stage 1M ran one authorized `codex exec` session against a disposable `CODEX_HOME` with the observer's
hooks trusted through Codex's own review. Results, in one paragraph: **`SessionStart`,
`UserPromptSubmit` and `SessionEnd` fired for real** and were observed, with their true payload shapes
captured (flat envelope; PascalCase `hook_event_name`; UUID `session_id`; `turn_id` on turn-scoped
events; populated `transcript_path`; `source`/`reason` enums), `SessionEnd` released the session's
state, and the summary's `hookEventsObserved` matched `journal.records` exactly. **`PreToolUse` and
`PostToolUse` were not exercised**: the turn failed at the account's usage limit before the model ran,
so no tool executed — the same reason no live token or cost figure exists. Two real defects surfaced
and were fixed: a counter (`hookEventsObserved`) that was always reported as zero, and shipped hook
timeouts that made Codex emit a clamping diagnostic for `SessionEnd` and `Interrupt` in every session
(Codex clamps those two events to 3 seconds). The transformation claims in §14 remain untouched and
still pending a successful tool-running turn. Full evidence, classification and reproduction:
[docs/CODEX_VALIDATION.md](CODEX_VALIDATION.md).
