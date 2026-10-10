# ADR 0002 — Codex integration approach

- **Status:** Proposed (awaiting runtime validation)
- **Date:** 2026-10-10
- **Stage:** 1K (Codex integration feasibility)
- **Deciders:** Dr. Token maintainers
- **Related:** [`docs/CODEX_FEASIBILITY.md`](../CODEX_FEASIBILITY.md) ·
  [`docs/adr/0001-opencode-integration.md`](0001-opencode-integration.md)

## Context

Dr. Token's second target harness is OpenAI Codex. Stage 1K established, on the machine Dr. Token is
developed on, that:

- the installed Codex runtime is **`codex-cli 0.162.0-alpha.17.2`**, bundled by the Codex desktop app
  under `%LOCALAPPDATA%\OpenAI\Codex\bin\<build-hash>\codex.exe`, sharing `%USERPROFILE%\.codex` with
  the CLI;
- Codex publishes a **documented lifecycle-hook framework** (`preToolUse`, `permissionRequest`,
  `postToolUse`, `preCompact`, `postCompact`, `sessionStart`, `sessionEnd`, `userPromptSubmit`,
  `subagentStart`, `subagentStop`, `stop`, `interrupt`) whose handlers are `command` or `mcpTool`
  processes receiving JSON on stdin and returning JSON on stdout;
- the `hooks` and `plugins` feature flags are **`stable` and enabled** in the installed build
  (runtime-verified), and hooks are discoverable programmatically with their definition hash and
  trust status (`hooks/list`, runtime-verified);
- a hook can observe tool inputs **and** the model-facing tool output (`tool_response`), and can
  **replace the model-visible tool result** (`decision: "block"` / `continue: false`), rewrite tool
  arguments (`updatedInput` with `permissionDecision: "allow"`), inject bounded model-visible context
  (`additionalContext`), reject a user prompt, and influence compaction (`preCompact`/`postCompact`);
- **no hook exposes the whole message array or the outgoing provider request**, hosted tools such as
  `WebSearch` are excluded, and hook output is capped at roughly 2,500 model-visible tokens per event;
- the **app server** is a documented JSON-RPC 2.0 client/server protocol (174 methods enumerated from
  the running server) that carries `thread/tokenUsage/updated` (per-turn `last` + cumulative `total`,
  with cached/cache-write/reasoning breakdown and `modelContextWindow`) and an auth-gated
  `account/tokenUsage/read` with **estimated** USD/credit cost per thread — but it is documented as
  experimental/unsupported for production and, on this machine, runs as a **private child process of
  the desktop app** with no control socket to attach to;
- an **MCP server is not middleware**: an MCP server only receives the calls Codex makes to it and
  cannot observe or transform the rest of the agent loop. Participation in interception requires a
  hook (`mcpTool` handlers call a tool on an already-connected server);
- the user's Codex already runs a `notify` program and 11 enabled plugins across two marketplaces, and
  has **no** `hooks.json` — so a Dr. Token hook set would be additive, while the single-valued
  `notify` key must never be claimed or overwritten.

Nothing about hook *delivery* or *influence* was executed in Stage 1K: no turn was started, no model
call was made, and no user conversation, transcript or credential was read.

## Decision

Adopt an **opt-in Codex plugin that bundles lifecycle hooks as the single interception boundary**,
**observation-first**, with app-server/rollout/OTel used only for **usage provenance**.

- The plugin's `hooks/hooks.json` registers the minimal event set needed (initially `PostToolUse`,
  `PreToolUse`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, later `PreCompact`/`PostCompact`,
  `Stop`), and is installed through a local marketplace (`codex plugin marketplace add <local path>`,
  `codex plugin add <plugin>@<marketplace>`).
- The hook entry point is **thin**: it marshals hook JSON to/from the shared Dr. Token engine. No
  optimization logic is duplicated in the adapter.
- Every hook is **fail-open**: any error, timeout, malformed payload or missing engine prints nothing
  and exits 0, leaving Codex's data untouched. One setting (plugin removal, `/hooks` disable, or
  `[features] hooks = false`) disables all transformation.
- The first delivered Codex step is **observation only** — hooks that record and return nothing — so
  the instrumentation can be validated before it is allowed to change anything.
- Influence, when enabled, is restricted to **documented shapes only**: `additionalContext`,
  `updatedInput` with `permissionDecision: "allow"`, and `decision: "block"` / `continue: false`.
  `--dangerously-bypass-hook-trust` is never used in product usage; hook trust is granted by the user
  through Codex's own review flow.
- Usage is labelled by provenance: app-server notifications, rollout `token_count`, `exec --json` and
  OTel values are **measured**; app-server `estimatedUsageUsdMicros`/`estimatedUsageCreditsMicros` are
  **estimated**; anything else is **unavailable**. No savings claim without a controlled comparison.
- Per-`session_id` state is bounded, flushed and released on `SessionEnd`, mirroring the OpenCode
  adapter's dispose discipline; unknown sessions are ignored.
- The adapter lives in `integrations/codex` and depends on the shared core; `notify` is never used as
  an integration surface, and the user's configuration is never written by Dr. Token (even though
  `config/value/write` exists).

## Consequences

**Positive**

- Uses only officially documented, stable-flagged surfaces; no patching, proxying or credential
  interception.
- The same artifact-level influence the engine already models (tool arguments, tool result text) is
  available on Codex, so the shared engine and benchmark vocabulary carry over unchanged.
- Because hooks are a **process boundary**, the adapter is language-agnostic and trivially fail-open —
  a stronger failure story than in-process mutation.
- Plugins + hooks work in **both** the desktop app and the CLI, which is exactly where the user runs
  Codex; the surfaces Dr. Token cannot use (whole-context interception, hosted tools) are documented
  and can be stated honestly in the capability matrix.
- Hook definitions are discoverable with hashes and trust status, which makes installation and
  revocation auditable by Dr. Token itself.

**Negative / costs**

- Influence is **partial by construction**: no provider-request rewrite, no message-array control, no
  hosted-tool coverage. Some OpenCode techniques cannot be ported.
- Every synchronous hook adds real latency inside the agent loop; oversized injected context is
  truncated or spilled to disk.
- Usage never arrives in the hook payload, so measurement requires a second, independent source
  (app-server/rollout/OTel) with its own provenance caveats; account-level cost is auth-gated and only
  estimated.
- The runtime is an `alpha` build and the docs warn that generated schemas vary per version, so
  capability detection must be dynamic and the adapter must stay thin.
- Distribution is constrained: plugins that bundle lifecycle hooks are **not eligible for the public
  plugin directory**, so Dr. Token must ship as a manual/local plugin install initially.
- Runtime validation is still outstanding, including the largest open assumption — that the desktop
  app executes the same user/plugin hooks the CLI does.

## Alternatives considered

1. **app-server companion process (observation + usage).** Attractive for measurement, and the only
   path to per-turn token and estimated-cost data. Rejected as *the* integration boundary: it is
   documented as experimental/unsupported for production, it subscribes only to threads the client
   itself owns rather than the user's live desktop session, and it offers no supported way to change
   what the model sees. Retained as a **secondary measurement surface**.
2. **MCP server as transparent middleware.** Rejected: an MCP server sees only the calls made to its
   own tools and cannot observe or rewrite Codex's internal tool execution or context. Kept only as a
   hook *target* (`mcpTool`) once a Dr. Token server exists.
3. **`notify` turn-complete program.** Rejected: turn-granular only, no tool view, no influence, and
   single-valued — it is already occupied on this machine by an unrelated integration.
4. **Provider proxy or request interception.** Rejected: no supported pre-request hook exists, and
   proxying duplicates authentication/streaming, bypasses host permissions, and would silently change
   model behaviour.
5. **Binary patching, DLL injection or credential interception.** Rejected outright — explicitly out
   of scope and outside Dr. Token's privacy and permission principles.
6. **CLI-only integration (e.g. `exec --json` measurement).** Rejected as the product surface: it
   leaves the desktop experience — the surface the user actually uses — without observation or
   optimization. Remains useful for benchmark runs.
7. **Wait for a richer official extension API.** Rejected as a strategy: the hook framework is already
   stable, enabled, and sufficient for observation; waiting forfeits the ability to learn the
   contract's real behaviour.

## Open questions

- Does the **desktop app** execute user-level `~/.codex/hooks.json` hooks, or only plugin-bundled
  hooks? (Plugin-bundled hooks are documented for desktop; user-level is presumed, not verified.)
- Do hook commands run inside the Windows sandbox (`features.prefer_mxc=true` on this machine), and
  with what PATH/environment (is `node` available to a `command` handler)?
- Are hook-injected `additionalContext` tokens reflected in any usage counter?
- How do two matching `PostToolUse` hooks that both replace the tool result interact?
- Does the `hooks` feature flag and the plugin manifest keys stay stable across the `0.162.x` line?
- Can live desktop observation ever be supported without owning the app-server process, or is
  per-session hook observation the only route?

These must be answered by the runtime validation procedure in
[`docs/CODEX_FEASIBILITY.md`](../CODEX_FEASIBILITY.md) §11 before any optimization is enabled on Codex.
