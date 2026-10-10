# Dr. Token — OpenCode observer (Stage 1D)

**Package:** `@dr-token/opencode-observer` (workspace `integrations/opencode`)
**Status:** implemented and unit-tested; **observation only** — no optimization
**Target APIs:** `@opencode-ai/plugin` **1.18.35** (V1 `Hooks` contract) **and** `@opencode/plugin`
**2.0.24** (V2 `Plugin.define({ id, setup })` contract — see §18)
**Runtime validation:** **live-validated** — the installed OpenCode Desktop **2.0.24** implements the
**V2** plugin API, and the **V2** adapter (§18) was loaded and validated there in Stages 1G–1J: live
hooks, live usage snapshots, one-shot persistence, live session-lifecycle mapping and project
isolation (Stage 1I), and — in Stage 1J — live `session.deleted` plus a matched cross-directory
`session.moved` (see [docs/OPENCODE_DESKTOP_VALIDATION.md](OPENCODE_DESKTOP_VALIDATION.md) §15–§18).
The V1 adapter remains valid and unchanged for a V1-line OpenCode (`1.18.x`), where the V2 event
vocabulary does not apply.

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

The observer suite has **257 tests** in 14 files:

| File | Tests | Covers |
| --- | --- | --- |
| `tests/observer.test.ts` | 77 | hooks, correlation, frequency, repeats, sessions, duplicates, malformed input, usage, bypass, fail-open, immutability, cleanup, bounds, privacy |
| `tests/read.test.ts` | 26 | read identity, ranges (V1 and V2 argument names), normalization, malformed arguments, hashing |
| `tests/plugin-v2-events.test.ts` | 19 | the **real V2 plugin** driven by a minimal V2 host: raw `{id, created, type, data}` envelopes, `data` payload preservation, session association, tool hooks, abort/cleanup, one-shot writes |
| `tests/plugin-v2.test.ts` | 18 | V2 tool-hook translation, capability handling, containment |
| `tests/usage.test.ts` | 15 | V1 usage extraction, validation, merge semantics |
| `tests/benchmark-integration.test.ts` | 15 | Stage 1B metric mapping and comparison behaviour |
| `tests/checkpoint.test.ts` | 15 | persistence during observation, bounded write rate, torn-tail repair, failing sink, unwritable path |
| `tests/usage-v2.test.ts` | 14 | V2 snapshot extraction, numeric rules, series comparison |
| `tests/plugin.test.ts` | 13 | entry point, `opencode.json` options, containment |
| `tests/observer-v2-usage.test.ts` | 12 | V2 usage at the observer level: identity, duplicates, decreases, no fabricated totals |
| `tests/source-guard.test.ts` | 10 | no network/logging/subprocess/fs, dependency hygiene |
| `tests/plugin-api-contract.test.ts` | 8 | compiled contract check against the published V1 types |
| `tests/sink.test.ts` | 8 | opt-in sink behaviour and failure containment |
| `tests/plugin-v2.contract.test.ts` | 7 | compiled contract check against the published V2 types |

Every observer test drives the adapter through the **real plugin hooks** (the interface
OpenCode calls), with deterministic mocked events, a fixed clock and an isolated
environment. No test performs a network request, a model call, or a write outside a
temporary directory.

One lesson is deliberately encoded in that table. Stage 1G's tests (and its live harness)
handed events to the observer's **V1-shaped** hook, so they never exercised the V2
normaliser — and the dropped `data` payload survived them all. `tests/plugin-v2-events.test.ts`
closes that layer: it builds a V2 host (`tests/v2-host.ts`), runs the adapter's real `setup`,
and pushes runtime-shaped envelopes through the same subscription the server uses.

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

### Unit-tested adapter behaviour (`npm test`, 287 observer tests in `integrations/opencode`)

- Plugin initialization and hook surface; tool execution counting; before/after
  correlation; tool frequency; repeated identical reads; different ranges; separate
  sessions; duplicate events; missing/malformed data; token usage collection; repeated
  `message.updated` snapshots; missing cost/token data; measured-versus-calculated
  labelling; bypass; internal failure handling; non-modification of hook inputs and
  outputs; session cleanup and bounds; sensitive-data exclusion.
- V2 event handling end-to-end through the real plugin: payloads carried under `data`, usage
  snapshots routed to the session in the payload, V1 payloads still preferred when both are present,
  hostile payloads contained, unknown event types ignored.
- One-shot summary persistence: a summary reaches the sink while a session runs, with no dispose and
  no lifecycle event, and a usage snapshot is written on arrival even with the periodic timer disabled.
- Filesystem behaviour: torn-tail repair after an interrupted write, append-only JSONL integrity,
  failing and unwritable sinks reported as `sink-failed` without breaking observation.
- V2 session lifecycle and project isolation end to end through the real plugin: mapping
  `session.created`/`session.deleted`/`session.moved` from the verified `data` shapes, the scope gate
  (project id first, then directory containment), refusal of other-project sessions, late events for
  deleted sessions, out-of-order delivery, concurrent sessions with interleaved events and a shared
  read target, and arrival-time persistence of project attribution.
- The V2 host harness (`tests/v2-host.ts`): real `setup(ctx)`, real hook registration, the actual
  subscription iterable, runtime-shaped envelopes and cleanup. Earlier stages' tests called observer
  methods directly and missed defects that only a live run then found; this layer exercises the adapter
  the way the host does.
- Compile-time satisfaction of the published V1 **and** V2 types (vendored contract fixtures).
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

**Stage 1G/1H update (2026-10-10): it ran in a real runtime.** The V2 adapter was loaded by the
Desktop's own bundled CLI 2.0.24, its tool hooks fired on real tool executions, and its observations
matched the host's own record; since Stage 1H it also **records the runtime's own token/cost
snapshots** and **writes a summary during a one-shot session that never unloads**. The live runs found
two real defects that no unit test had caught (the V2 read argument name, and the dropped `data`
payload), both fixed and re-validated live — see
[§15](OPENCODE_DESKTOP_VALIDATION.md#15-stage-1g--live-v2-validation-runtime-tested) and
[§16](OPENCODE_DESKTOP_VALIDATION.md#16-stage-1h--v2-usage-events-and-reliable-summary-persistence-runtime-tested).
Still nothing is optimised, and no saving is claimed.

**Stage 1I update (2026-10-10): the lifecycle is mapped, and isolation is live-verified.** Three
zero-cost isolated runs (the run names an unresolvable model, so no provider is ever reached) validated
the Stage 1I adapter in a real 2.0.24 server: a live `session.created` was mapped into a summary
(`lifecycle.createdEvents: 1`) with `project.verification: "matched"` against the instance's own
`ctx.location`, and the summary reached the sink **~11 ms after the event** with a 60 s checkpoint
interval and no unload; a session declaring a different project was refused (`sessionsOutOfScope: 1`,
nothing written); a disabled observer processed nothing although the event was delivered. Evidence,
procedures and limitations:
[§17](OPENCODE_DESKTOP_VALIDATION.md#17-stage-1i--live-lifecycle-project-isolation-and-harness-validation-runtime-tested).

**Stage 1J update (2026-10-10): deletion and move are live-validated too.** A private isolated server
drove the real API (`session.create` / `session.delete` / `session.move`; the model was pinned to an
unresolvable one, so no provider was ever contacted). Observed live: `session.deleted` closed only the
deletion's own session (final summary written, state released) while a concurrent session continued
untouched; a deletion of a session the observer never tracked was safely ignored; `session.moved` was
delivered to three live instances and, for a move between two directories of one git-repo project
(shared project id `global`), **processed with `verification: "matched"` and an updated directory
hash**, appended to the sink. Cross-project sessions were refused on creation and their move events
ignored. Full record: [§18](OPENCODE_DESKTOP_VALIDATION.md#18-stage-1j--live-lifecycle-transitions-isolation-and-cleanup-runtime-tested).

What was listed as unverified here is now partly settled, and partly superseded:

- **Plugin loading and order** — observed: OpenCode loads it per process (one `setup`, one
  registration per hook, one event subscription), and Stage 1G's live run recorded the host's own
  `loading plugin … role=server` log line.
- **Hook payloads in practice** — observed: `execute.before/after` carry `tool`, `sessionID`, `id`,
  `input` and the completion `status`, with `input.path` as the read argument (not V1's `filePath`).
- **Message-level cumulative token fields** — superseded: V2 delivers no `message.updated` events at
  all. It publishes a session-level series (`session.usage.updated`) plus per-step
  (`session.step.ended`) values; only the session series is consumed, and it was measured to behave
  like a running session total (§18.6).
- **Aborted or errored requests** — still unverified, and now known to matter: the flush trigger
  registered for `session.execution.succeeded` **did not fire** in the live one-shot run, so no
  durability guarantee rests on it (the usage-snapshot write and the periodic checkpoint carried it).
- **Sessions from other projects** — settled in Stage 1I: the V2 lifecycle payloads are mapped, and the
  scope gate compares the instance's own project (`ctx.location`) with the session's declared project.
  Both outcomes were observed live — a matching session was recorded with `verification: "matched"`, and
  a session declaring another project was refused with `sessionsOutOfScope: 1` and nothing written
  (§18.7, §17).
- **Real-world repeated-read rates and tool-call distributions** — still unverified; the live samples
  are a handful of synthetic two-read sessions.

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

Updated by Stage 1G (live hooks), Stage 1H (live usage + one-shot persistence), Stage 1I (live
lifecycle mapping + project isolation) and Stage 1J (live deletion + matched cross-directory move)
against the real OpenCode Desktop 2.0.24 bundled CLI
([Stage 1G record](OPENCODE_DESKTOP_VALIDATION.md#15-stage-1g--live-v2-validation-runtime-tested),
[Stage 1H record](OPENCODE_DESKTOP_VALIDATION.md#16-stage-1h--v2-usage-events-and-reliable-summary-persistence-runtime-tested)).

| Capability | Source-confirmed | Unit-tested | Runtime-tested |
| --- | --- | --- | --- |
| V2 `Plugin`/`setup`/`Cleanup` shape | ✅ (published d.ts) | ✅ | ✅ |
| `ctx.tool.hook` registration + payload fields | ✅ (published d.ts) | ✅ | ✅ |
| Tool-call observation and correlation | ✅ | ✅ | ✅ (2/2 correlated) |
| Repeated-read identity and counting | ✅ | ✅ | ✅ (after the `path` fix below) |
| Cleanup / registration disposal | ✅ | ✅ | ✅ (dispose on demand; a one-shot host is killed before it runs) |
| Fail-open containment | ✅ | ✅ | ✅ (0 internal errors) |
| `ctx.event.subscribe` item shape (payload under `data`) | ✅ | ✅ | ✅ (55 events delivered in one run) |
| **V2 usage snapshots (`session.usage.updated`)** | ✅ | ✅ | ✅ (2 events, exact values, correct session) |
| **One-shot summary persistence** (no unload required) | ✅ | ✅ | ✅ (final snapshot on disk, cleanup never ran) |
| V2 session **lifecycle** mapping (`session.created`/`session.deleted`/`session.moved`) | ✅ (`@opencode/schema@2.0.24`) | ✅ | ✅ all three mapped live (Stage 1J): created, deleted, and a matched cross-directory move (§18.7, §17–§18) |
| **Project scope gate** (instance `ctx.location` vs session facts) | ✅ | ✅ | ✅ matched and refused live (§18.7, §17) |
| Bypass (`enabled:false` / env) | ✅ | ✅ | ✅ live: disabled observer processed nothing (§17) |

Three V2-vs-V1 differences were found live:

1. **The read tool's path argument is `path`, not `filePath`** (Stage 1G, runtime-confirmed). Fixed in
   [`src/read.ts`](../integrations/opencode/src/read.ts) with regression tests; before the fix every V2
   read was counted as unidentified and repeated-read detection silently never fired.
2. **V2 delivers an event body under `data`; V1 uses `properties`** (Stage 1H, runtime-confirmed —
   and the reason Stage 1G saw no usage at all). `asRuntimeEvent` now preserves **both**, and the
   observer prefers `properties`, so V1 behaviour is unchanged.
3. **V2's lifecycle vocabulary is not V1's.** `session.created`/`session.deleted` are delivered with a
   `data` payload that carries `sessionID` (plus `projectID`/`location` on creation) — V1 uses
   `properties.info.id`. Stage 1I maps them from the shipped `@opencode/schema@2.0.24` declarations
   and confirms the shape live (§18.7).

V2 also emits an entirely different event vocabulary (`session.step.started`, `session.tool.called`,
`session.reasoning.delta`, `session.inbox.*`, `session.execution.*`, …), none of which overlaps V1.
Unrecognised events are ignored, which is the intended fail-safe: they are counted and diagnosed, never
mistaken for a token reading.

### 18.6 V2 usage events (implemented in Stage 1H)

`session.usage.updated` carries `{ sessionID, cost, tokens: { input, output, reasoning, cache: { read,
write } } }` under `event.data` — runtime-confirmed, and consumed from Stage 1H on.

What the adapter does with it:

- validates each value with the **same** rule the V1 path uses (finite, non-negative), so both lines
  behave identically;
- routes it to the session named by the payload, never to another session;
- keeps it **separate** from the per-message usage map, because a session snapshot has no message
  identifier and folding it in would invent an attribution;
- preserves the numbers **as reported** in `usage.sourceReported` (`events`, `usableEvents`,
  `reportedByField`, `latest`, `latestObservedAt`, `monotonicNonDecreasing`, `decreasesObserved`);
- derives **no** session aggregate from them. `inputTokens`/`outputTokens`/… stay `unavailable` with a
  note, and `totalTokens` is never derived, so a snapshot can never be promoted to a measurement;
- writes the snapshot immediately when a sink is configured (§18.8).

**Aggregation semantics.** Two live sessions showed the series behaving like a running session total:
in both, the last snapshot equalled the totals the runtime itself stored for the session, which a
per-request increment could not be. That is evidence, not a published contract, so `aggregation` stays
`"unverified"` and only the source's own numbers are kept.

### 18.7 V2 session lifecycle and project isolation (implemented in Stage 1I)

The lifecycle payloads were read out of the shipped `@opencode/schema@2.0.24` declarations (verbatim
excerpts recorded in [`src/types-v2.ts`](../integrations/opencode/src/types-v2.ts)) and confirmed live
by Stage 1I's isolated runtime runs:

| Event | Verified `data` shape | What the adapter does |
| --- | --- | --- |
| `session.created` | `{ projectID, location: { directory, workspaceID? }, subpath?, slug, version, sessionID, … }` | maps the session, applies the declared project facts, counts `createdEvents` |
| `session.moved` | `{ projectID, location: { directory, workspaceID? }, subpath?, sessionID }` | re-applies the facts and re-runs the scope gate |
| `session.deleted` | `{ sessionID }` | closes the session: writes the final summary, then releases state |

- **Project scope gate.** The V2 adapter declares the instance's own project to the observer from
  `ctx.location` (`Location.Info`: `{ directory, workspaceID?, project: { id, directory, canonical } }`).
  A session is `matched` when both sides declare a project id and they are equal, or — only when an id
  is missing on either side — when the session's declared directory is the project directory or lies
  inside it. A session that declares a **different** project is dropped (`sessionsOutOfScope`,
  diagnostic `project-mismatch`) and nothing is written for it. When either side declares nothing
  usable, the session is still recorded but reported as `verification: "unverifiable"` with an explicit
  note — never assigned to a guessed project. Directory comparison folds the Windows forms only
  (backslashes, drive-letter case, doubled and trailing separators) and never resolves symlinks or
  `..`; the runtime's own `canonical` field is preferred when present.
- **Privacy.** The declared directory is kept in memory only, for comparison. Summaries carry the
  project's opaque id, the workspace id and a **one-way hash** of the normalized directory — never a
  path. A Stage 1H live run recorded that `session.created` can arrive for a session whose directory is
  not the project at all; now such a session is either verified against the instance project or
  explicitly reported as unverified, instead of silently attributed.
- **Late, duplicate and out-of-order events.** Session ids whose deletion was observed, and ids refused
  as out of scope, are remembered (bounded) and checked before any state is created, so a late
  tool/usage event cannot resurrect a deleted session and duplicate deletions cannot run the transition
  twice. Both are counted (`lateEventsIgnored`) and diagnosed (`session-closed`). A session observed
  before its `session.created` is re-evaluated when the event arrives.
- `session.step.ended` carries per-step `cost`/`tokens` and `session.tool.called`/`session.tool.success`
  carry V2-native tool data. Neither is consumed: pooling per-step usage beside the session snapshot
  would double count, and the tool hooks already provide the same observations.
- `session.execution.succeeded` is registered as a flush trigger. It was **not delivered** in the
  live one-shot runs (and so no durability guarantee depends on it), but Stage 1J's long-lived server
  **did** deliver it for an API-driven move, and the flush happened as designed.
- Stage 1J validated all three transitions against a private isolated server: `session.deleted` flushed
  and released exactly its own session, and `session.moved` was processed with `verification:
  "matched"` and a new directory hash when the move stayed inside one project (git-repo directories
  share the project id `global`) — while a move across projects is refused. Reproducible steps are in
  §18 of [docs/OPENCODE_DESKTOP_VALIDATION.md](OPENCODE_DESKTOP_VALIDATION.md).

### 18.8 Summary persistence (implemented in Stage 1H)

A one-shot OpenCode session is killed before any unload path runs, so Stage 1G's summary never reached
disk. With a sink configured, the observer now writes:

| Trigger | Behaviour |
| --- | --- |
| A `session.usage.updated` snapshot | written **immediately** (queued, never awaited into the event path) — low frequency, highest-value content |
| Project attribution from `session.created`/`session.moved` | written **immediately**, same reasoning: rare, high-value, and it arrives at the very start of a session — exactly when a one-shot host is most likely to be terminated |
| A dirty session + a timer | periodic checkpoint, `checkpointIntervalMs` (default 1000 ms, `unref`'d so it never keeps the host alive) — bounded write rate for busy tool traffic |
| `session.idle` (V1) / `session.execution.succeeded` (V2, when delivered) | flush |
| `session.deleted`, `dispose()` | flush, then release state |

The JSONL sink appends one newline-terminated record per write, serialised behind a single write chain
so the last complete line is always the newest summary. On its first write of a process it checks
whether an earlier process was killed mid-record and closes that fragment with a newline first, so a
torn write cannot corrupt the next record. This keeps the append-only contract: a temp-file-and-rename
scheme would discard earlier sessions and, on Windows, fail when a reader holds the destination open.

`checkpointIntervalMs: 0` disables the periodic timer only; arriving usage snapshots and unload still
write. With no `summaryFile`, no `DR_TOKEN_OBSERVER_SUMMARY_FILE` and no injected sink, **no write path
exists at all**.

Residual limitation, measured rather than assumed: if a session's **last** change is a tool call and the
host is killed inside the checkpoint interval, that tail is not written. The live runs lost nothing
because their final changes were a usage snapshot and a project attribution, both written on arrival.

### 18.9 Reproducing the live validation

```sh
CLI="$APPDATA/ai.opencode.desktop/cli/2.0.24/opencode-cli.exe"
cd <disposable-project>

# 1. discovery (no model call)
"$CLI" plugin list                     # → dr-token-observer  local  ...\.opencode\plugins\dr-token-observer.ts

# 2. load + registration + cleanup (no model call)
"$CLI" reload

# 3. one minimal synthetic session on a FREE model (check the model is still Free first)
"$CLI" run --standalone --print-logs --auto --title "synthetic probe" \
  --model opencode/longcat-2.5-preview-free \
  "Use the read tool to read fixtures/repeated-content.json twice with the default range. Do not summarise the file. Then reply exactly: DONE."
```

Use `--standalone` for a private server: connecting to the background service instead runs the session
outside this project's plugin scope, `--format json` produced no output in these headless runs, and a
private `serve`/`api --standalone` server does **not** load project plugins at all — only a real prompt
pipeline does. Pass `--title` so OpenCode's own title generation cannot make a second model call.

A two-read session must report `toolStartsObserved: 2`, `correlatedCompletions: 2`,
`reads.identifiedRequests: 2`, `reads.repeatedTargets: 1`, `adapter.pluginApi.line: "v2"`, and — since
Stage 1H — a `usage.sourceReported` block with real numbers in it. To check persistence, watch the
configured `observations.jsonl` **while the session runs**: it must already contain a line whose
`sourceReported.latest` matches the session export's own totals, even though the host never unloads.

**Stage 1I zero-cost recipe (cannot reach a provider).** The lifecycle/isolation runs deliberately name
an unresolvable model, so the session fails at model resolution before any request exists:

```sh
BASE="$TMPDIR/dr-token-stage1i-run2"
mkdir -p "$BASE/project/.opencode/plugins" "$BASE/iso/config" "$BASE/iso/data"
# stage the built adapter under .opencode/vendor/dr-token-opencode-observer/dist and a harness
# plugin under .opencode/plugins; the harness forwards the host's own ctx.location unless
# DR_TOKEN_STAGE1I_WRONG_PROJECT=1, and sets enabled:false when DR_TOKEN_STAGE1I_DISABLED=1
cd "$BASE/project"
XDG_CONFIG_HOME="$BASE/iso/config" XDG_DATA_HOME="$BASE/iso/data" \
  "$CLI" run --standalone --print-logs --auto --title "stage1i probe" \
  --model nonexistent/nonexistent-model "Reply exactly: DONE."
```

Expected: the process exits with `Model unavailable: nonexistent/nonexistent-model`; with a sink
configured, `observations.jsonl` already contains a summary with `lifecycle.createdEvents: 1` and
`project.verification: "matched"` when the session's `data.projectID`/`data.location` agree with the
host's `ctx.location`; with `DR_TOKEN_STAGE1I_WRONG_PROJECT=1` no summary and no sink file appear and the
snapshot shows `sessionsOutOfScope: 1`; with `DR_TOKEN_STAGE1I_DISABLED=1` nothing is processed at all.
`session.deleted`/`session.moved` are exercised deterministically by `tests/v2-host.ts` +
`tests/v2-lifecycle.test.ts`; no live run has produced them yet.
