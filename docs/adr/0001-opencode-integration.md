# ADR 0001 — OpenCode integration approach

- **Status:** Proposed (awaiting runtime validation)
- **Date:** 2026-10-10
- **Stage:** 1C (OpenCode integration feasibility)
- **Deciders:** Dr. Token maintainers
- **Related:** [`docs/OPENCODE_FEASIBILITY.md`](../OPENCODE_FEASIBILITY.md)

## Context

Dr. Token needs a first coding-harness integration. OpenCode (stable line `1.18.35`, repository
`anomalyco/opencode`, formerly `sst`) publishes an official plugin interface with a documented hook
contract. Stage 1C verified, from published types and source, that plugins can:

- observe tool calls and results (`tool.execute.before` / `tool.execute.after`)
- mutate tool arguments and tool result text in place
- observe the full message list and system prompt (`experimental.*` hooks, unstable)
- read per-message token usage and cost (`input`, `output`, `reasoning`, `cache.read`, `cache.write`, `cost`)
- subscribe to session lifecycle events, including `session.idle` and `session.compacted`

Constraints that shape the decision:

1. Hook exceptions propagate and abort the current operation — the plugin must never throw.
2. Influence requires **in-place mutation**; assigning new objects to `output.args`, `output.parts` or
   `output.messages` is silently ignored.
3. Whole-context control exists only behind `experimental.*` hooks.
4. OpenCode truncates tool output after the hook and clears old tool results during compaction.
5. An unreleased v2 plugin API already exists in documentation, so v1 adapter code has a finite horizon.
6. Nothing has been runtime-tested yet: no OpenCode installation was available during Stage 1C.

## Decision

Adopt a **thin, artifact-level OpenCode plugin on the stable v1 API, observer-first**, with
whole-context hooks gated behind feature flags.

- The plugin depends on the shared Dr. Token engine and contains **no optimization logic** itself.
- Each interception builds one `OptimizationRequest` for the artifact it can actually rewrite (tool
  result text, tool arguments, message parts) and applies the result only when the engine reports the
  context changed.
- Every hook is wrapped: failures and unexpected shapes leave OpenCode's data untouched (fail-open), and
  a single setting disables all transformations (bypass).
- Token accounting uses per-message values as *measured*; session totals and repeated-read counts are
  *calculated*; anything unknown stays *unavailable*. No savings claims without controlled comparison.
- `experimental.chat.messages.transform` and `experimental.chat.system.transform` are optional
  capabilities detected at load time, not assumptions.
- The first delivered step (Stage 1D) is **observation only** — no mutation.

## Consequences

**Positive**

- Uses only officially published interfaces; no source patching or forking.
- The stable hooks are sufficient for the first meaningful optimization target (repeated file reads and
  oversized tool output), so the risky experimental hooks are not required for value.
- Fail-open and bypass map directly onto the existing Stage 1A engine contract and the Stage 1B
  measurement vocabulary.
- Per-message token and cost data is genuinely measured, which makes later benchmark comparisons real
  rather than estimated.

**Negative / costs**

- Adapter behaviour depends on mutation semantics that are undocumented and untyped in places
  (result shape differs between built-in and MCP tools).
- The strongest context control remains experimental and may change without notice.
- A future v2 migration will require rework; the adapter must stay small to keep that cost low.
- Distribution requires either publishing `@dr-token/core` or bundling it into the plugin package
  (it is currently `private: true`), and the Node-only benchmark package must never be imported by the
  plugin.
- Runtime validation is still outstanding.

## Alternatives considered

1. **Fork or patch OpenCode to add a dedicated token-optimization hook.** Rejected: high maintenance
   burden, divergence from upstream, and unnecessary — the published hooks already expose the required
   artefacts.
2. **Transparent provider proxy** (register/modify a provider base URL and rewrite requests before they
   reach the model). Attractive because it sees the complete payload including retries. Rejected for the
   first adapter: it duplicates authentication and streaming handling, silently breaks model-specific
   behaviour, and is far harder to fail open safely than a small plugin.
3. **External sidecar using the SDK only.** Rejected as the primary approach: observation is possible,
   but there is no write path, so it cannot influence context at all. It remains a useful option for
   reporting-only deployments.
4. **MCP server as the integration surface.** Rejected: OpenCode consumes MCP for tools and resources;
   it cannot intercept or rewrite existing tool results or model context.
5. **Target the unreleased v2 plugin API now.** Rejected: `latest` is still the v1 line, v2 is documented
   as a migration target, and building against unreleased APIs would violate the project's preference for
   verified behaviour.
6. **Start with compaction-prompt customization only.** Rejected as a standalone strategy: it touches one
   narrow moment of the session and yields no measurable per-task baseline.

## Open questions

- Do aborted or errored requests still emit final token/cost figures?
- Are cache read/write token fields populated for every provider?
- Does the plugin observe events for sessions outside its own project (isolation requirements)?
- How do multiple plugins that mutate the same artefact interact in practice?
- Which mutation styles survive a release bump, given no types enforce them?

These must be answered by runtime validation before any savings claim is made.
