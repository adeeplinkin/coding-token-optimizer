# Dr. Token — OpenCode observer (Stage 1D)

**Package:** `@dr-token/opencode-observer` (workspace `integrations/opencode`)
**Status:** implemented and unit-tested; **observation only** — no optimization
**Target APIs:** `@opencode-ai/plugin` **1.18.35** (V1 `Hooks` contract) **and** `@opencode/plugin`
**2.0.24** (V2 `Plugin.define({ id, setup })` contract — see §18)
**Runtime validation:** **attempted, blocked** — Stage 1E found the installed OpenCode Desktop
**2.0.24** implements the **V2** plugin API, so this V1 adapter cannot load there (see
[docs/OPENCODE_DESKTOP_VALIDATION.md](OPENCODE_DESKTOP_VALIDATION.md) and §14). This adapter remains
valid for a V1-line OpenCode (`1.18.x`); a V2 port is future work.

> Dr. Token must prove it can observe agent activity correctly before attempting to
> optimize it. This stage does the proving; it does not optimize.

---

## 1. What this is, and what it is not

The adapter is a small OpenCode plugin that **records** what an agent did:

- how many tool calls started and completed, and how often each tool ran
- which files were read more than once with an identical range
- the token and cost fields OpenCode actually reports for assistant messages
- session lifecycle facts that change how those numbers must be read (compaction, deletion)

It is **not** an optimizer. It contains no Safe, Aggressive or Balanced mode, no
suppression of reads, no content cache, no context compression, no prompt rewriting
and no modification of tool output. It holds no reference to any hook argument or
result after a call returns, writes nothing unless a sink is explicitly configured,
and makes no network request.

It also does not claim savings. Detecting a repeated read is *not* evidence that a
token was saved; the summary says so in its own `notes`.

### Explicitly out of scope for this stage

Safe/Aggressive/Balanced algorithms · read suppression · source-content caching ·
context compression · prompt rewriting · tool-output modification · experimental
whole-context transforms · SQLite · Rust/Tauri · React dashboard · Windows installer ·
Freebuff, Codex and Claude Code adapters · local AI models · telemetry or any cloud
service.

## 2. Verified OpenCode API version

| Item | Value |
| --- | --- |
| Plugin package | `@opencode-ai/plugin` |
| Verified version | **1.18.35** (npm `latest`) |
| SDK package | `@opencode-ai/sdk` **1.18.35** |
| API line | **V1** (`Hooks` interface, `Plugin = (input, options?) => Promise<Hooks>`) |
| Not targeted | the **V2** plugin API (`@opencode/plugin`, `Plugin.define({ id, setup })` / `ctx.tool.hook(...)`) — **required** for the OpenCode Desktop 2.0.24 installed on the Stage 1E machine (see [docs/OPENCODE_DESKTOP_VALIDATION.md](OPENCODE_DESKTOP_VALIDATION.md)) |

Verification method: the published tarballs were downloaded with `npm pack` and the
shipped declarations read directly (2026-10-10), not taken from memory:

```sh
npm pack @opencode-ai/plugin@1.18.35
sha256sum package/dist/index.d.ts          # f3ec1a150d1354be3c9d93928fa130edc118c63fb468533ebb01eb3d6ed77f92

npm pack @opencode-ai/sdk@1.18.35
sha256sum package/dist/gen/types.gen.d.ts  # 1fdbed5b58ed5882b411cc9b1b03fdfe2fb131b0be39a0fd2622d12ab6f50f0f
```

Those digests and the verbatim excerpts are recorded in
[`integrations/opencode/src/types.ts`](../integrations/opencode/src/types.ts), and a
vendored copy of the exact published members the adapter implements lives in
[`tests/fixtures/opencode-plugin-v1.contract.ts`](../integrations/opencode/tests/fixtures/opencode-plugin-v1.contract.ts).

**How the contract is enforced:** that fixture declares the published `Plugin` and
`Hooks` types, and
[`tests/plugin-api-contract.test.ts`](../integrations/opencode/tests/plugin-api-contract.test.ts)
assigns the adapter's plugin function and hooks object to them. If the adapter stops
matching the published contract, `npm run typecheck` fails. Re-verify the vendored
copy with the `npm pack` procedure above; the fixture records the digests it was read
from.

### Why the plugin package is not a dependency

`@opencode-ai/plugin` is declared as an **optional peer dependency** (`^1.18.35`).
OpenCode provides the real package at runtime, so the adapter needs nothing from it at
run time, and contributors do not have to install its transitive tree (27 packages,
including a native build step) just to type-check a 4-hook adapter. The package
declares **no runtime dependencies** at all.

## 3. Adapter architecture

```
OpenCode server (Bun)
 └─ plugin module: @dr-token/opencode-observer
     ├─ plugin.ts            → V1 plugin function; registers hooks; wraps every body fail-open
     ├─ observer.ts          → in-memory, bounded, per-session counters and summaries
     ├─ read.ts              → pure read-request identity (path hash + offset + limit)
     ├─ usage.ts             → pure assistant-message usage extraction and merge
     ├─ hash.ts              → SHA-256 (16 hex chars) read-target digests
     ├─ sink.ts              → opt-in summary sink (nothing by default)
     ├─ benchmark-adapter.ts → maps observation measurements onto the Stage 1B model
     ├─ types.ts             → verified V1 contracts, observation model, bounds, diagnostics
     └─ index.ts             → public API
```

Design rules actually enforced by the code:

- **Observation only.** No hook that can change agent behavior is registered.
- **Fail-open everywhere.** No hook body can throw into OpenCode (two independent
  guards: one inside the observer, one in the plugin wrapper).
- **Visibility without decisions.** Every summary carries an evidence label per
  metric; nothing is inferred to look better.
- **State is in memory and bounded.** No disk state, no growth without limit.
- **The path is not retained.** Only a one-way digest of it.

## 4. Required hooks

All four are stable V1 hooks. The names come from the published `Hooks` interface and
the three tool/event hooks appear in the official plugin documentation.

| Hook | Used for | Read | Never done |
| --- | --- | --- | --- |
| `tool.execute.before` | tool id, session id, call id, read arguments | `input.tool`, `input.sessionID`, `input.callID`, `output.args.{filePath,offset,limit}` | does not assign to `output.args` |
| `tool.execute.after` | completions, correlation | `input.tool`, `input.sessionID`, `input.callID`, `input.args` | never reads or stores `output.output`, `output.title`, `output.metadata` |
| `event` | `message.updated`, `message.part.updated`, `message.removed`, `session.*` | usage fields, session identity, lifecycle | mutates nothing |
| `dispose` | flush retained sessions and stop | – | – |

Not used: `chat.message`, `chat.params`, `chat.headers`, `command.execute.before`,
`install`, `permission.ask`, `shell.env`, `tool.definition`, and every
`experimental.*` hook — including `experimental.chat.messages.transform` and
`experimental.chat.system.transform`, which are the only whole-context control points.
Several of them are types-only (not documented on the plugins page); none is needed
for observation.

Source-confirmed detail worth knowing: OpenCode's hook dispatcher calls plugin hooks
sequentially with the **same `output` object by reference** and has **no try/catch**
around them, so a throwing hook aborts the current tool call or model request. That is
the reason for the double guard.

## 5. Collected measurements

Every metric is labelled with how it was obtained.

| Metric | Evidence | How |
| --- | --- | --- |
| `toolStartsObserved`, `toolCompletionsObserved` | `measured` | one increment per distinct call id |
| `readRequestsObserved`, `identifiedReadRequests`, `unidentifiedReadRequests` | `measured` | one increment per distinct read call id |
| `distinctReadTargets`, `repeatedReadTargets`, `repeatedFileReads` | `calculated` | aggregates over the observed read identities |
| `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens` | `calculated` | sum over the assistant messages that **reported** the field |
| `cost` | `calculated` | sum over the assistant messages that **reported** a cost; never inferred |
| `totalTokens` | **`unavailable`** | deliberately never derived (see below) |

Evidence vocabulary: `measured` (a direct observation), `calculated` (an aggregate of
measurements), `estimated` (inferred without an authoritative record — the observer
produces none), `unavailable` (no reliable value; always carries a reason).

### Why there is no session total

`AssistantMessage.tokens` is `{ input, output, reasoning, cache: { read, write } }` and
`AssistantMessage.cost` is a number. OpenCode publishes **no session-level total**, and
the per-message fields overlap: reasoning is not necessarily disjoint from output, and
cache reads/writes are a slice of input. Adding them would be a fabricated
measurement, so `totalTokens` is always `unavailable` with that explanation. Per-field
sums are labelled `calculated`, and only over messages that reported the field.

### Duplicate `message.updated` snapshots

OpenCode may publish the same message several times while it streams. The observer
keeps **one usage record per assistant message id** (`state.usage` is keyed by message
id), so a repeated update can never be counted twice. For each field the higher
observed value is kept: a field only becomes non-zero once the provider reports it, so
a lower later value is treated as a stale or partial update rather than a correction.
When that happens the event is counted in `usageRegressionsObserved` and reported as a
content-free diagnostic, so the behaviour is visible rather than silent.

`step-finish` parts are counted (`stepFinishPartsObserved`) but **never** added to the
session aggregates, because step usage overlaps with the parent assistant message.
`message.removed` drops the corresponding usage record.

## 6. Repeated-read identification rules

The built-in tool id is `read`; the documented parameters are
`{ filePath: string, offset?: NonNegativeInt, limit?: NonNegativeInt }` with default
offset **1** and default limit **2000** (source-confirmed against OpenCode 1.18.35
`packages/opencode/src/tool/read.ts`).

A read request identity is:

```
targetId = sha256(normalize(filePath))[0..16]      // one-way; the path is discarded
key      = `${targetId}:${effectiveOffset}:${effectiveLimit}`
```

Rules:

1. **Normalization** trims surrounding whitespace, converts `\` to `/`, collapses
   repeated separators, and drops a trailing separator. It deliberately does **not**
   resolve symlinks, `..` or case, because that would require filesystem access and
   could merge genuinely different targets. `/repo/a.ts`, `\repo\a.ts` and `/repo//a.ts`
   are one identity; `/repo/a.ts` and `/repo/A.ts` are two.
2. **Documented defaults are applied**, so `{ offset: 1 }` and an omitted offset are
   the same request. An explicit `offset: 0` stays `0` (schema-valid, and conflating it
   with the default would hide a genuinely different range).
3. **Range is part of the identity.** Two reads of the same file with different
   `offset` or `limit` are never counted as identical.
4. **Malformed range values** (`"2000"`, `1.5`, `-3`, `NaN`) are counted in
   `malformedArgumentRequests`, the documented default is applied, and a diagnostic is
   emitted.
5. **A missing or unusable path** produces no identity: the request is still counted
   (`unidentifiedRequests`) but can never participate in repeat detection.
6. `repeatedRequests = Σ_k max(0, count_k − 1)` over all identities, and
   `repeatedTargets` is the number of identities with `count > 1`.
7. Each **call id** is counted at most once. A read observed in `before` is not counted
   again in `after`, and a duplicate `before` for the same call id is ignored.
8. The observer **never** skips a read, replaces returned content, caches content, or
   records file contents. It only counts.

`repeatedFileReads` means *potentially redundant requests*. It is not a saving: the
earlier content may already have been evicted by compaction, the file may have changed,
or the repeated read may be entirely deliberate.

## 7. Privacy policy

The adapter maintains observation state **in memory only**, and:

- **No raw prompt logging.** Prompts are never read. `chat.message` is not implemented.
- **No source-code content.** `output.output`, `output.title` and `output.metadata` are
  never read or stored; tool arguments are read for `read` identity only.
- **No API keys or credentials.** No `auth`/`provider` hook, and `PluginInput.client`,
  `.project`, `.directory`, `.worktree` and `.serverUrl` are deliberately never read.
- **No file paths retained.** Only a 16-hex-character SHA-256 digest of the normalized
  path survives; the raw path is discarded immediately after hashing.
- **No raw tool-output persistence**, no telemetry, no network reporting.
- **No hidden file modifications.** By default the observer writes nothing at all.
  A summary file is written only when the user explicitly configures one (§10).
- **No OpenCode configuration changes.** The adapter never writes `opencode.json` and
  never installs anything.

Summaries contain: counts, digests, ISO timestamps, the session id, static notes and a
content-free adapter identity. Diagnostics carry a fixed code, a fixed level and fixed
text — never a path, prompt, identifier or credential. The test suite asserts all of
this, including a source-level guard that fails if a network, subprocess or logging
call is ever added to `src/`.

### Bounds

| Bound | Default | Behaviour at the limit |
| --- | --- | --- |
| `maxSessions` | 32 | least-recently-used session evicted (flushed to the sink first) |
| `maxPendingCalls` | 1024 | oldest pending call dropped; `pendingCallsDropped` counted |
| `maxReadTargets` | 1024 | oldest read identity dropped; `targetsDropped` counted |
| `maxTrackedMessages` | 2048 | oldest usage record dropped; `usageRecordsDropped` counted |
| `maxDiagnostics` | 64 | oldest diagnostic dropped |

`sessionsCreated`, `sessionsEvicted` and `sessionsClosed` are reported in the observer
snapshot, and `session.deleted` drops state immediately.

## 8. Bypass

Observation can be disabled three ways, in decreasing strength:

1. **Remove the plugin** from `opencode.json` (or delete the project plugin file). No
   code runs at all.
2. **Environment:** `DR_TOKEN_OPENCODE_OBSERVER=off` (`off`, `false`, `0`, `no`,
   `disabled`, case-insensitive). This is the switch usable from configuration files.
3. **Plugin option / API:** `{ "enabled": false }` in the plugin entry of
   `opencode.json`, or `observer.setEnabled(false)` programmatically.

While disabled: every hook returns immediately without reading a single field, no
session state is created, and no counter moves. Tool behavior is unchanged and existing
summaries remain readable. Re-enabling resumes recording; it does not discard earlier
summaries.

When the observer is disabled at construction, `getSnapshot().enabled` is `false` and
`sessionCount`, `eventsObserved` and the summaries are all empty — which the tests
assert.

## 9. Error handling

Every hook body is wrapped twice: once inside `OpenCodeObserver.observe*`, and once in
the plugin's `guard()`. A failure increments `internalErrors`, emits one content-free
`internal-failure` diagnostic, and returns normally. **No hook ever throws** — the
published dispatcher has no error handling, so a throw would abort the tool call or
model request.

Containment is tested for: a throwing read hasher, a throwing diagnostic callback, a
throwing clock, a throwing sink, a rejected asynchronous hook body, and a throwing
failure reporter. A read-accounting failure is also contained *locally*, so it cannot
also lose the tool-call count for that call.

A failing sink loses that one summary; observation continues and `sink-failed` is
recorded. Nothing is retried.

## 10. Local installation

The adapter is **not published to npm** and is **not activated in this repository**.
Installation is project-local and opt-in.

### Build it

```sh
npm install          # or: npm ci
npm run build        # builds @dr-token/core, @dr-token/benchmarks and @dr-token/opencode-observer
```

### Use it from a local plugin file

If OpenCode is run inside a checkout of a project that can resolve this workspace:

```ts
// .opencode/plugins/dr-token-observer.ts
export { DrTokenOpenCodeObserver as DrTokenObserver } from '@dr-token/opencode-observer';
```

### Or declare it as an npm plugin with options

```jsonc
// opencode.json (project level)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@dr-token/opencode-observer", { "enabled": true, "summaryFile": "./.dr-token/observations.jsonl" }]
  ]
}
```

Both plugin options are optional. `summaryFile` is the only thing that makes the
adapter write to disk, and it writes only that file, in JSON Lines format (one summary
per line, appended).

Do **not** add it to `~/.config/opencode/opencode.json`. Nothing here touches global
configuration, and the plugin is intentionally not enabled in the Dr. Token
development repository.

### Custom wiring

```ts
import { createOpenCodeObserver } from '@dr-token/opencode-observer';

const { plugin, observer } = createOpenCodeObserver({
  enabled: true,
  sink: (summary) => console.log(JSON.stringify(summary)),
});

export const DrTokenObserver = plugin;
```

## 11. Running the automated tests

```sh
npm test                                   # every workspace, from the repository root
npm run typecheck                          # includes the observer's tests and contract fixture
npx vitest run --project opencode          # (not configured) — use the workspace instead:
cd integrations/opencode && npx vitest run # observer package only
```

The observer suite has **159 tests** in 8 files:

| File | Tests | Covers |
| --- | --- | --- |
| `tests/observer.test.ts` | 77 | hooks, correlation, frequency, repeats, sessions, duplicates, malformed input, usage, bypass, fail-open, immutability, cleanup, bounds, privacy |
| `tests/read.test.ts` | 19 | read identity, ranges, normalization, malformed arguments, hashing |
| `tests/usage.test.ts` | 15 | usage extraction, validation, merge semantics |
| `tests/plugin.test.ts` | 13 | entry point, `opencode.json` options, containment |
| `tests/source-guard.test.ts` | 10 | no network/logging/subprocess/fs, dependency hygiene |
| `tests/benchmark-integration.test.ts` | 9 | Stage 1B metric mapping and comparison behaviour |
| `tests/plugin-api-contract.test.ts` | 8 | compiled contract check against the published V1 types |
| `tests/sink.test.ts` | 8 | opt-in sink behaviour and failure containment |

Every observer test drives the adapter through the **real plugin hooks** (the interface
OpenCode calls), with deterministic mocked events, a fixed clock and an isolated
environment. No test performs a network request, a model call, or a write outside a
temporary directory.

## 12. How to inspect observation results

Three ways, all local:

1. **Opt-in summary file** — set `summaryFile` (or `DR_TOKEN_OBSERVER_SUMMARY_FILE`).
   Summaries are appended as JSON Lines when a session goes idle, when it is deleted,
   when a session is evicted by the bound, and on `dispose`.

   ```sh
   node -e "const l=require('fs').readFileSync('.dr-token/observations.jsonl','utf8').trim().split('\n');console.log(JSON.stringify(JSON.parse(l.at(-1)),null,2))"
   ```

2. **Programmatic** — `observer.getSummary(sessionId)`, `observer.getSummaries()`,
   `observer.serializeSummary(sessionId)`, `observer.getSnapshot()`.

3. **Diagnostics** — `getSnapshot().recentDiagnostics` holds the last 64 content-free
   diagnostics; pass `onDiagnostic` to receive them live.

A summary looks like this (abridged):

```jsonc
{
  "schemaVersion": 1,
  "adapter": { "name": "@dr-token/opencode-observer", "revision": "0.0.0",
               "pluginApi": { "package": "@opencode-ai/plugin", "verifiedVersion": "1.18.35", "line": "v1" } },
  "sessionId": "ses_…",
  "counts": { "toolStartsObserved": 12, "toolCompletionsObserved": 12, "correlatedCompletions": 12,
              "uncorrelatedCompletions": 0, "duplicateStartsIgnored": 0, "duplicateCompletionsIgnored": 0,
              "pendingCalls": 0, "pendingCallsDropped": 0 },
  "toolFrequency": [ { "tool": "bash", "started": 4, "completed": 4 },
                     { "tool": "read", "started": 8, "completed": 8 } ],
  "reads": { "requests": 8, "identifiedRequests": 8, "unidentifiedRequests": 0,
             "distinctTargets": 5, "repeatedTargets": 3, "repeatedRequests": 3,
             "malformedArgumentRequests": 0, "targetsDropped": 0,
             "identityScheme": "hash(normalized file path, 16 hex characters) + read offset + read limit" },
  "usage": { "messagesWithUsage": 6, "messagesWithoutUsage": 0, "usageRecordsDropped": 0,
             "usageUpdatesIgnored": 0, "usageRegressionsObserved": 0, "stepFinishPartsObserved": 6,
             "reportedByField": { "input": 6, "output": 6, "reasoning": 6, "cacheRead": 6,
                                  "cacheWrite": 6, "cost": 6 } },
  "measurements": {
    "repeatedFileReads": { "evidence": "calculated", "value": 3 },
    "inputTokens": { "evidence": "calculated", "value": 48000 },
    "totalTokens": { "evidence": "unavailable",
                     "note": "Total tokens are deliberately not derived: …" }
  },
  "notes": [ "Observation only: this summary describes recorded activity and does not prove that any token saving was achieved.", "…" ]
}
```

## 13. Stage 1B integration

`benchmark-adapter.ts` maps one observation summary onto the Stage 1B `RunMetrics`
shape without importing `@dr-token/benchmarks` (that package is Node-only and must not
be pulled into a plugin). The mirror is enforced by a compile-time assignment to the
real `RunMetrics` type in
[`tests/benchmark-integration.test.ts`](../integrations/opencode/tests/benchmark-integration.test.ts).

Mapping/provenance rules:

| Observation evidence | Stage 1B evidence | Why |
| --- | --- | --- |
| `measured` | `measured` | a direct reading; both classes mean the same thing |
| `calculated` | **`unavailable`** | Stage 1B has no class for a derived value. Its `measured` means "obtained from an actual observation", which an aggregate is not; its `estimated` means "calculated indirectly and explicitly labelled as an estimate", which an aggregate of real measurements is not either. A derived value is therefore never presented as directly measured |
| `estimated` | `estimated` | representable as published (the observer currently produces none) |
| `unavailable` | `unavailable` | the classes agree |

- Because of that rule, **`toolCalls` is the only `measured` metric** in the mapping
  (observed completions). `repeatedFileReads` and the per-field token sums are aggregates
  and arrive as `unavailable`, with `CALCULATED_NOT_REPRESENTABLE_NOTE` explaining why.
- The aggregate **values are not discarded**: the observation summary keeps them with
  their original `calculated` classification. Only the Stage 1B projection drops them,
  and the `unavailable` note deliberately carries no number, because an `unavailable`
  measurement must never smuggle a value.
- `durationMs`, `recoveryAttempts` and `optimizerErrors` are `unavailable`: they belong
  to a harness run, not to the observer.
- The observer never emits `benchmark-verified`. That class requires a valid controlled
  baseline/candidate comparison, which this adapter does not run.

Extending the Stage 1B vocabulary with a `calculated` class was considered and rejected
for this stage: `compareRuns` treats any available, non-estimated total as a real
measurement, so a new class would have to change comparison semantics — the risk of a
`benchmark-verified` verdict resting on an aggregate. Reporting `unavailable` keeps the
benchmark engine untouched and cannot overstate provenance.

The test suite feeds observer-derived metrics into the real `compareRuns` and asserts the
result is **`unavailable`** — not a fabricated improvement — and that a synthetic run is
never relabelled as a real `opencode` harness run. The benchmark engine itself was not
modified.

## 14. What is verified, and what is not

This document separates four different levels of confidence. Please keep them separate
when quoting it.

### Source-confirmed (published types, official docs and upstream source)

- The V1 `Hooks`, `Plugin`, `PluginInput` and `PluginOptions` signatures, including
  `tool.execute.before`, `tool.execute.after` and `event` — read from
  `@opencode-ai/plugin@1.18.35/dist/index.d.ts`.
- `AssistantMessage.cost` and `AssistantMessage.tokens.{input,output,reasoning,cache.read,cache.write}`,
  `EventMessageUpdated = { type: "message.updated", properties: { info } }`,
  `EventSessionIdle/Compacted = { type, properties: { sessionID } }`,
  `EventSessionCreated/Updated/Deleted = { type, properties: { info: Session } }`,
  `EventMessageRemoved = { type, properties: { sessionID, messageID } }` — read from
  `@opencode-ai/sdk@1.18.35/dist/gen/types.gen.d.ts`.
- The `read` tool parameters and default offset 1 / limit 2000.
- That hook dispatchers pass one shared `output` object by reference and do not catch
  exceptions (so hooks must never throw).
- That the V2 plugin API is a different, unreleased contract.

### Unit-tested adapter behaviour (`npm test`, 159 tests)

- Plugin initialization and hook surface; tool execution counting; before/after
  correlation; tool frequency; repeated identical reads; different ranges; separate
  sessions; duplicate events; missing/malformed data; token usage collection; repeated
  `message.updated` snapshots; missing cost/token data; measured-versus-calculated
  labelling; bypass; internal failure handling; non-modification of hook inputs and
  outputs; session cleanup and bounds; sensitive-data exclusion.
- Compile-time satisfaction of the published V1 types (vendored contract fixture).
- Source-level absence of network, logging, subprocess and filesystem paths.

### Runtime-tested OpenCode behaviour

**None.** No OpenCode installation was available on the machine used for this stage
(`opencode` is not on `PATH`), so **no hook was executed inside a live OpenCode
server**. Every behaviour above is verified against the *published contract* and by
deterministic mocked events — not by a running agent.

**Stage 1E update (2026-10-10).** A Desktop installation *was* subsequently located and probed. It
ships CLI **2.0.24**, whose runtime contains the V2 plugin surface (`@opencode/plugin`, `ctx.tool`,
`event.subscribe`, `execute.before/after`) and **none** of the V1 hook names this adapter registers.
OpenCode's V2 migration guide states V1 plugin implementations do not run in V2. So no hook executed
there either, and the row below stays ❌ — this time for a *verified API-line mismatch* rather than an
absent installation. Stage 1D's own packaging was validated in the Desktop runtime: the built
`dist/index.js` imported cleanly as ESM in Node, exposed all four V1 hook keys and has zero
dependencies. Full evidence, procedures and limitations: [docs/OPENCODE_DESKTOP_VALIDATION.md](OPENCODE_DESKTOP_VALIDATION.md).

Not yet observed, and treated as unverified:

- that OpenCode loads this plugin at all, and in which order relative to other plugins;
- that the hook payloads match the published types in practice (in particular that a
  `tool.execute.before` payload always carries `output.args`);
- which providers populate `reasoning` and `cache.*`, and whether the message-level
  token fields are cumulative across steps;
- whether aborted or errored requests still publish final token counts;
- whether the plugin observes only sessions belonging to its own project, or sessions
  from other projects and other server clients (per-session keying is implemented, but
  directory-level scoping is not);
- real-world repeated-read rates and tool-call distributions.

### Unverified compatibility summary

| Capability | Source-confirmed | Unit-tested | Runtime-tested |
| --- | --- | --- | --- |
| V1 hook signatures | ✅ | ✅ | ❌ |
| Tool-call observation | ✅ | ✅ | ❌ |
| Repeated-read identity & counting | ✅ (`read` args) | ✅ | ❌ |
| Usage/cost field extraction | ✅ | ✅ | ❌ |
| Non-modification guarantee | ✅ (by construction) | ✅ | ❌ |
| Loading by OpenCode | — | ❌ | ❌ on Desktop 2.0.24 (V2-only runtime; source-confirmed mismatch, [Stage 1E](OPENCODE_DESKTOP_VALIDATION.md)) |
| Provider field coverage | — | ❌ | ❌ |

**No claim in this repository says the observer reduces real-world token usage, and
nothing in this stage measured a saving.**

## 15. Manual live-test procedure

Only run this when a compatible OpenCode installation and an explicitly safe,
**non-billable** environment are available. Do not run it against paid model accounts
without authorization.

1. **Prepare an isolated project.** Create an empty scratch directory with a couple of
   small text files, and use a throwaway OpenCode project (no credentials, no `.env`,
   no real source).
2. **Build the adapter:** `npm install && npm run build` in this repository.
3. **Enable it project-locally** (never globally), with a summary file so the result is
   inspectable:
   ```jsonc
   // <scratch>/opencode.json
   { "plugin": [["<path-to>/integrations/opencode", { "summaryFile": "./observations.jsonl" }]] }
   ```
   or copy the built package into `<scratch>/.opencode/plugins/` and re-export
   `DrTokenOpenCodeObserver`.
4. **Run a short, cheap session** that reads the same small file twice with the same
   range, reads it once with a different range, and calls a couple of other tools.
5. **Stop the session** (so `session.idle` or `dispose` fires the sink) and inspect
   `observations.jsonl`:
   - `readRequestsObserved` matches the number of reads you triggered;
   - `repeatedRequests` is 1 for the identical pair and does **not** include the
     different-range read;
   - `counts.toolStartsObserved` and `toolCompletionsObserved` match, with
     `pendingCalls: 0`;
   - `reportedByField` shows which token fields your provider actually reports, and
     `totalTokens.evidence` is `unavailable`.
6. **Confirm no interference:** the agent's answers and tool results must be identical
   to a run with the plugin disabled. Compare the two sessions; any difference is a bug
   and should be reported as one.
7. **Confirm the privacy properties:** the summary file must contain no file paths, no
   prompt text and no tool output. Grep for a distinctive string you know you typed.
8. **Record what you observed** — including failures — in this document. Until that
   happens, runtime compatibility stays "unverified".

## 16. Adding the observer to a benchmark run later

The runner already accepts injected optimizers and provenance, so a real OpenCode
benchmark needs no framework change:

1. run the task once per configuration under the same harness, model and revision;
2. record the observer's metrics as `measured`/`calculated` and label the harness
   honestly (do not reuse `synthetic-fixture` or relabel a fixture run);
3. use `toObservedRunMetrics` for the metric shape, or extend the provenance with the
   observer revision;
4. compare with `compareRuns`, which will stay `unavailable` until real total-token
   measurements exist on both sides.

Until then, observer output is **baseline information about agent activity** — how many
tool calls ran and which reads repeated — and nothing more.

## 17. Module map

| File | Purpose |
| --- | --- |
| [`src/types.ts`](../integrations/opencode/src/types.ts) | verified V1 contracts, observation model, limits, diagnostics, notes |
| [`src/read.ts`](../integrations/opencode/src/read.ts) | pure read-request identification |
| [`src/usage.ts`](../integrations/opencode/src/usage.ts) | pure usage extraction and merge |
| [`src/hash.ts`](../integrations/opencode/src/hash.ts) | default SHA-256 read-target digest |
| [`src/observer.ts`](../integrations/opencode/src/observer.ts) | session state, counters, summaries, bypass, bounds, fail-open |
| [`src/plugin.ts`](../integrations/opencode/src/plugin.ts) | V1 plugin function and hook containment |
| [`src/types-v2.ts`](../integrations/opencode/src/types-v2.ts) | verified V2 contracts, plugin id, implemented V2 hook list |
| [`src/plugin-v2.ts`](../integrations/opencode/src/plugin-v2.ts) | V2 plugin definition, payload translation, event subscription, cleanup |
| [`src/sink.ts`](../integrations/opencode/src/sink.ts) | opt-in summary sink (nothing by default) |
| [`src/benchmark-adapter.ts`](../integrations/opencode/src/benchmark-adapter.ts) | Stage 1B metric mapping |
| [`src/index.ts`](../integrations/opencode/src/index.ts) | public API; its **default export** is the V2 plugin definition |

## 18. OpenCode V2 adapter (Stage 1F)

Stage 1E established that the OpenCode Desktop installed on the development machine runs
CLI **2.0.24**, which implements the **V2** plugin API. This stage adds a second adapter
for that contract. The V1 adapter is unchanged and still targets `@opencode-ai/plugin`
1.18.35.

### 18.1 Verified V2 contract

| Item | Value |
| --- | --- |
| Plugin package | `@opencode/plugin` |
| Verified version | **2.0.24** (matches the bundled Desktop CLI) |
| Authoring shape | `import { Plugin } from '@opencode/plugin'`; **`export default Plugin.define({ id, setup })`** |
| Lifecycle | `setup(ctx)` may return a cleanup function that runs on unload |
| Tool hooks | `await ctx.tool.hook('execute.before' \| 'execute.after', cb)` → `Promise<Registration>` with `dispose()` |
| Events | `ctx.event.subscribe({ signal })` → `AsyncIterable`; abort the signal on cleanup |

Verification method (2026-10-10): `npm pack @opencode/plugin@2.0.24` and read the shipped
declarations. Recorded digests:

```
dist/promise/plugin.d.ts        ad8e00e94b4c94587800db750132a44754f42fe322d5cfb6da9fb0168ced09f1
dist/promise/tool.d.ts          14ead93a2c03136af9768f9f02447c5fb357d1bce12a4b38a5e9fe31a0e91eff
dist/promise/registration.d.ts  16436600a035f85d035e3baebb8412084119f620ee4eafc9feba1c7438f6f5ff
dist/promise/event.d.ts         7e8549dc513c83bd3fcf7cd1b36bcd66b137fac5384f2ac65850b56c0ebcddad
```

The published signatures are vendored in
[`tests/fixtures/opencode-plugin-v2.contract.ts`](../integrations/opencode/tests/fixtures/opencode-plugin-v2.contract.ts)
and `plugin-v2.contract.test.ts` assigns the real adapter to them, so `npm run typecheck`
fails if the adapter drifts from the contract it claims to implement.

### 18.2 Differences from V1

| Concern | V1 | V2 |
| --- | --- | --- |
| Entry point | `Plugin = (input, options?) => Promise<Hooks>` | `Plugin.define({ id, setup })`, **default export** |
| Hook registration | returned `Hooks` object | `await ctx.tool.hook(name, cb)` |
| Tool start payload | `input {tool, sessionID, callID}` + `output {args}` | one event `{tool, sessionID, agent, messageID, id, input}` |
| Tool completion payload | `input {…, args}` + `output {title, output, metadata}` | one event, plus `status: 'completed'`/`'error'` and `result`/`error` |
| Call correlation | `callID` | `id` (`Tool.CallID`) — mapped to the observer's `callID` |
| Events | `event` hook, one event per call | `ctx.event.subscribe()` async iterable, aborted on cleanup |
| Disposal | returned `dispose` hook | cleanup function returned from `setup` |
| Unload of registrations | n/a | `Registration.dispose()` per registration |

### 18.3 What is shared, and what is new

Only translation is new. `observer.ts`, `read.ts`, `usage.ts`, `hash.ts`, `sink.ts` and
`benchmark-adapter.ts` are untouched by Stage 1F, so every count, bound, privacy rule,
evidence class and sink behaviour is the same in both adapters. `plugin-v2.ts` translates a
V2 payload into the V1-shaped input the observer already accepts, registers the two
tool hooks, subscribes to events, and on cleanup disposes every registration, aborts the
subscription and disposes the observer.

Observation-only guarantees hold identically: no write to the V2 event object, no
`ctx.tool.transform`, no `ctx.storage`, no permission requests, no tool-result content in
state. Tool results are never passed through — the completion payload is mapped to empty
placeholders, and only `tool`, `sessionID`, `id` and `input` are read.

A summary now records which API line produced it
(`adapter.pluginApi = { package: '@opencode/plugin', verifiedVersion: '2.0.24', line: 'v2' }`),
so a V2 observation can never be mistaken for a V1 one. The V1 default is unchanged.

### 18.4 Installing the V2 adapter

V2 discovers project-local plugins in `.opencode/plugin/` and `.opencode/plugins/` and
loads the **default export**. Build once, then point a project file at the built package:

```ts
// <project>/.opencode/plugins/dr-token-observer.ts
export { DrTokenOpenCodeObserverV2 as default } from '@dr-token/opencode-observer';
```

or declare it explicitly (a path to the built directory also works):

```jsonc
// <project>/opencode.json
{ "plugins": [["<path-to>/integrations/opencode", { "summaryFile": "./observations.jsonl" }]] }
```

Never install it globally, and never in a project holding real credentials. With no
`summaryFile` option and no `DR_TOKEN_OBSERVER_SUMMARY_FILE`, the observer writes nothing.
Bypass is unchanged: `{ "enabled": false }` or `DR_TOKEN_OPENCODE_OBSERVER=off`.

### 18.5 V2 compatibility status

Updated by Stage 1G, which exercised the adapter in the real OpenCode Desktop 2.0.24 bundled CLI
([full record](OPENCODE_DESKTOP_VALIDATION.md#15-stage-1g--live-v2-validation-runtime-tested)).

| Capability | Source-confirmed | Unit-tested | Runtime-tested |
| --- | --- | --- | --- |
| V2 `Plugin`/`setup`/`Cleanup` shape | ✅ (published d.ts) | ✅ | ✅ |
| `ctx.tool.hook` registration + payload fields | ✅ (published d.ts) | ✅ | ✅ |
| Tool-call observation and correlation | ✅ | ✅ | ✅ (2/2 correlated) |
| Repeated-read identity and counting | ✅ | ✅ | ✅ (after the `path` fix below) |
| Cleanup / registration disposal | ✅ | ✅ | ✅ |
| Fail-open containment | ✅ | ✅ | ✅ (0 internal errors) |
| `ctx.event.subscribe` item shape | ⚠️ docs only | ✅ (defensive) | ✅ (stream open, 40 events) |
| Bypass (`enabled:false` / env) | ✅ | ✅ | ❌ (unit-tested only) |
| Token/usage fields in V2 | ✅ **now known** | ❌ not consumed | ❌ not consumed |

Two V2-vs-V1 differences were found live:

1. **The read tool's path argument is `path`, not `filePath`** (runtime-confirmed). Fixed in
   [`src/read.ts`](../integrations/opencode/src/read.ts) with regression tests; before the fix every V2
   read was counted as unidentified and repeated-read detection silently never fired.
2. **V2 usage arrives as `session.usage.updated` with the payload under `data`, not `properties`.**
   Token and cost fields exist with V1's names (`cost`, `tokens.input/output/reasoning`,
   `tokens.cache.read/write`) but the observer matches V1 event names, so **V2 sessions currently
   report no token data** — the fields stay `unavailable` and are never estimated. Mapping them is
   Stage 1H work; the verified payload path is recorded in the validation doc.

V2 also emits an entirely different event vocabulary (`session.step.started`, `session.tool.called`,
`session.reasoning.delta`, …), none of which overlaps V1. Unrecognised events are ignored, which is
the intended fail-safe.

### 18.6 Reproducing the live validation

```sh
CLI="$APPDATA/ai.opencode.desktop/cli/2.0.24/opencode-cli.exe"
cd <disposable-project>

# 1. discovery (no model call)
"$CLI" plugin list                     # → dr-token-observer  local  ...\.opencode\plugins\dr-token-observer.ts

# 2. load + registration + cleanup (no model call)
"$CLI" reload

# 3. one minimal synthetic session on a FREE model
"$CLI" run --standalone --auto --model opencode/big-pickle \
  "Read notes.txt using the read tool. Then read notes.txt again using the read tool with the same default range. Then reply with exactly: DONE."
```

Use `--standalone` for a private server: connecting to the background service instead runs the
session outside this project's plugin scope, and `--format json` hangs in these headless runs. A
two-read session must report `toolStartsObserved: 2`, `correlatedCompletions: 2`,
`reads.identifiedRequests: 2`, `reads.repeatedTargets: 1` and `adapter.pluginApi.line: "v2"`.
