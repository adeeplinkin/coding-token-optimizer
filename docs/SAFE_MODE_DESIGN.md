# Dr. Token — Safe Mode design (Stage 1O)

**Status:** design only. **No Safe Mode transformation is implemented, enabled or benchmarked.**
**Scope of this stage:** pick the first Safe Mode strategy, prove that the harnesses can support it,
and specify how it will be measured — or reject it and say why.
**Related:** [docs/OPENCODE_REQUEST_HOOK_VALIDATION.md](OPENCODE_REQUEST_HOOK_VALIDATION.md) (Stage 1P runtime validation of the hook this design depends on) · [docs/SAFE_MODE_M1_OBSERVATION.md](SAFE_MODE_M1_OBSERVATION.md) (Stage 1Q: the M1 observation-only opportunity analyzer) · [docs/BENCHMARKING.md](BENCHMARKING.md) · [docs/CODEX_VALIDATION.md](CODEX_VALIDATION.md) ·
[docs/CODEX_OBSERVER.md](CODEX_OBSERVER.md) · [docs/OPENCODE_OBSERVER.md](OPENCODE_OBSERVER.md) ·
[docs/adr/0003-safe-mode-strategy.md](adr/0003-safe-mode-strategy.md) ·
[docs/adr/0001-opencode-integration.md](adr/0001-opencode-integration.md) ·
[docs/adr/0002-codex-integration.md](adr/0002-codex-integration.md)

> **Headline.** The first Safe Mode experiment should be **exact duplicate tool-result elision at the
> OpenCode V2 request-assembly point**, with a *presence proof*: a repeated read-only result is replaced
> only when a byte-identical copy of the same content is **still present in the very same outgoing
> request**. That single condition makes the transformation information-preserving *by construction*
> rather than by cache management, and it is the only candidate whose equivalence Dr. Token can prove
> from the payload it is already holding. **Codex cannot support this experiment at all**: it has no
> channel to rewrite a tool result or the prepared request, so no equivalent substitution is possible
> there. Nothing is implemented in this stage.

---

## 1. Evidence vocabulary used in this document

This project already uses a fixed vocabulary; this document does not invent new strengths.

| Class | Meaning |
| --- | --- |
| **Runtime-verified** | Observed by executing the real host/runtime in this project (Stage 1G–1N). |
| **Contract-verified** | Read from the *published declaration* of the exact package version, whose digest is recorded in the repository. |
| **Contract-confirmed** | Stated by the vendor's documentation or by the pinned runtime source; not executed here. |
| **Unverified** | Not established by any of the above. Never a claim of support. |
| **Unsupported** | The harness documents or demonstrably has no such channel. |
| **Not implemented** | Dr. Token has not written it. Distinct from *unsupported*. |

**Rule that governs every claim below:** a capability is never promoted by inference. "The type allows
it" is *contract-verified*; "the host honoured it" is *runtime-verified*; the two are never merged.

---

## 2. What the previous stages established (the design's factual floor)

Only the following is used as fact. Everything else in this document is labelled.

**OpenCode — the V2 line the user's Desktop actually runs** (`@opencode/plugin@2.0.24`; the V2-only
runtime and the `path`/`data` differences were runtime-confirmed in Stages 1E–1J):

| Fact | Class |
| --- | --- |
| `ctx.tool.hook("execute.before")` and `("execute.after")` are delivered, with `tool`, `sessionID`, `id`, `input`, and (`after`) a completed `result` or an `error` | **Runtime-verified** (delivered) / **Contract-verified** (the `result` member is writable on the event) |
| `ctx.event.subscribe()` delivers the event stream (55 events in one live run) | **Runtime-verified** |
| `session.usage.updated` carries host-reported tokens (`input`, `output`, `reasoning`, `cache.read`, `cache.write`) and cost | **Runtime-verified** (values matched the runtime's own session totals) |
| Session lifecycle + project scope gate (`session.created/deleted/moved`) | **Runtime-verified** (Stage 1J) |
| `ctx.session.hook("context")` exists and its `SessionContext` exposes **mutable** `system`, `messages`, `options`, `tools` while the model request is assembled | **Contract-verified** (published 2.0.24 declarations); **invocation runtime-verified in Stage 1P** (fires per attempt, ~2 ms before the send, with the complete request: 4 system parts, the message list, 12 tool definitions). **A mutation is honoured: runtime-verified in Stage 1R** — a substituted value reached the provider wire with nothing else changed ([docs/OPENCODE_REQUEST_HOOK_VALIDATION.md](OPENCODE_REQUEST_HOOK_VALIDATION.md) §11) |
| `ctx.session.hook("http.request")` exposes the actual outbound `Request` (and `http.response` the response) | **Contract-verified**; **invocation runtime-verified in Stage 1P** |
| `ctx.session.hook("compaction")` can supply `result` and *skip the model request*; `ctx.permission.hook("evaluate")` can change `effect`; `ctx.tool.transform` can add/update/remove tool definitions | **Contract-verified** — unverified |
| `Tool.Result = { output?, content?, metadata? }` (members readonly; the *event* property is replaceable) | **Contract-verified** |
| Live requests carry **separate, complete `tool-result` parts** beside `tool-call` parts, and **two byte-identical `read` results in one request** were observed with the earlier copy still present (1 duplicate group, 1 elidable later copy, 135 characters) | **Runtime-verified** (Stage 1P §5) |
| V1 hooks (`tool.execute.before/after`, `experimental.*`) | Contract-verified for 1.18.35; **not loaded** by the 2.0.24 Desktop runtime (Stage 1E) |

**Codex** (`codex-cli 0.162.0-alpha.17.2`):

| Fact | Class |
| --- | --- |
| 16 hook deliveries in one real turn: `SessionStart`, `UserPromptSubmit`, **`PreToolUse` 6×**, **`PostToolUse` 6×**, `Stop`, `SessionEnd`, all six tool calls correlated by `tool_use_id`, one live repeated read | **Runtime-verified** (Stage 1N §14) |
| Tool input arrives as `{command}` for both `Bash` and `apply_patch` | **Runtime-verified** |
| `PreToolUse` can block (exit 2 + stderr, or `permissionDecision: "deny"` + reason) and can rewrite tool arguments (`allow` + `updatedInput`) | **Contract-confirmed** (v0.162.0 source) — not exercised |
| `PostToolUse` **cannot** rewrite the tool result (`updatedMCPToolOutput` is parsed as unsupported); it can add `additionalContext` or `decision: "block"`, which replaces the model-facing result with hook feedback, capped at roughly 2.5k model-visible tokens with spill | **Contract-confirmed** |
| No hook payload carries token usage | **Runtime-verified** (16 live payloads contained none) |
| The host's own `exec --json` stream reports `turn.completed.usage` (`input 60,884 · cached 57,216 · output 362`) | **Runtime-verified** — and **not ingested** |
| No whole-context or provider-request channel; hosted tools (`WebSearch`) excluded | **Contract-confirmed** / documented limitation |
| Desktop app executes user-level hooks | **Unverified** |

**Shared platform** (Stages 1A–1B, re-verified in Stage 1O): canonical `OptimizationRequest` /
`OptimizationResult` / `OptimizerPass` contracts with `evidence: none | estimated | measured |
benchmark-verified`; a pass-through engine that falls back to the original context on any pass failure;
a benchmark framework with per-metric evidence classes, provenance, correctness checks and an
accuracy-first `compareRuns`. `npm run verify` = **exit 0, 27 test files, 459 tests**; the synthetic
benchmark suite = **exit 0, 16 correctness checks passed, 8 `unavailable` verdicts**.

---

## 3. Candidate strategies, and which of them are real token reductions

The mission is to reduce **model-visible tokens**. A technique that only saves disk reads or tool
execution time is not a token optimization, even if it is cheap and safe. Each candidate is classified
on that axis first.

| # | Candidate | Reduces model-visible tokens? | Why |
| --- | --- | --- | --- |
| A1 | **Exact duplicate tool-result elision at request assembly** (the chosen one, §4) | **Yes** — the duplicate's characters leave the outgoing request | The content is removed from the request body the provider tokenizes |
| A2 | Rewrite the tool result at `tool.execute.after` (before it is stored) | Yes, but not provably | Removes characters, but equivalence depends on the *stored* copy surviving into a later request — which is not knowable at that moment |
| A3 | Cross-session content cache that serves a re-read from disk cache without re-running the tool | **No (by itself)** | Saves tool execution; the model still receives the content and still pays for it |
| A4 | Codex `PostToolUse` `decision: "block"` to replace a repeated read with feedback | No — and not equivalent | The result is *replaced by feedback*, not by identical content; capped and spilled; also signals a block |
| A5 | Prevent the second read (`PreToolUse` deny, or `tool.transform` removing the tool) | Arguably, but destroys behavior | The tool call disappears from the transcript; denial is not a successful read; changes agent semantics |
| A6 | Generic tool-output truncation / "compression" | Yes | Lossy by definition — cannot be proven equivalent |
| A7 | Prompt / instruction de-duplication, system-prompt minimisation | Yes, modest | Touches the highest-value content (instructions); safe subset exists but is a different experiment |
| A8 | Inject "you already read X" via `additionalContext` | **No — it adds tokens** | Pays only if the model then declines to read; a behavioral gamble, not a transformation |
| A9 | Cache and reuse a compaction summary (`session.compaction.result`) | Yes — it can skip an entire model request | Real savings, but it replaces generated content and needs its own equivalence story |
| A10 | Provider-side prompt caching / request ordering for cache hits | **No** — reduces *cost*, not tokens | A different axis; relevant only to measurement, not to this experiment |

**The distinction the brief asks for, stated plainly:** *detecting* a repeated read is an observation
Dr. Token already performs (runtime-verified on both harnesses). *Having permission and a channel to
reuse or alter its response* is a separate capability, and it is **not** the same on the two harnesses
(§5). Detection never implies the right to suppress.

---

## 4. The chosen first experiment

### 4.1 Name and one-sentence definition

**Safe Mode pass `safe.exact-duplicate-tool-result-elision`, version 1.**

> When the host is assembling a model request, if two tool-result parts of a *read-only* tool inside the
> **same** request carry **byte-identical** model-visible text, replace the **later** part's text with a
> fixed, explicit marker — but only when the earlier identical text is *still present in that same
> request*.

Everything else about the request is left alone.

### 4.2 Eligibility (all conditions required; any doubt means no elision)

| # | Condition | Why it is required |
| --- | --- | --- |
| E1 | The host exposes the prepared request (`session.hook("context")` or later equivalent) and the parts can be mapped 1:1 to their tool identity | Without the prepared request there is nothing to compare, and without tool identity the *kind* of part is unknown |
| E2 | Both parts are `tool-result` parts of the **same** tool, and that tool is on the **read-only allowlist** (`read` only in v1) | A repeated *mutation* result (patch, write, command) is not interchangeable, even when identical |
| E3 | The two texts are **byte-identical** (direct string equality on the exact model-visible text) | This is the equivalence proof. Not a hash comparison, not a similarity score |
| E4 | The retained copy appears **strictly earlier** in the **same** request and is **still present** | The presence proof: the information is in the payload being sent |
| E5 | Both results are `status: "completed"` | Error results carry meaning ("this failed again"); they are never elided |
| E6 | The duplicate's length ≥ `minElidableChars` (default 400) | Avoids noise-level markers for trivial outputs |
| E7 | No part in the request already contains the marker prefix `dr-token/safe-mode/` | Prevents a crafted tool output from impersonating or nesting the marker |
| E8 | The request kind is `primary` (not `compaction`, `title`, `generate`) | Compaction and title requests have different tolerance for altered history; v1 stays on the main loop |
| E9 | Total scan stays within the pass's bounded work budget (bounded number of parts, bounded total characters examined) | No unbounded resource growth on a pathological request |

Condition **E3 + E4 together are the whole safety argument**: at the moment of sending, the removed text
is present elsewhere *in the same payload*, so no information the model was going to receive is lost.
Nothing else in the design is load-bearing for correctness.

### 4.3 The marker (model-visible fidelity)

The replacement text is a single line, versioned and unmistakable:

```text
[dr-token/safe-mode/v1: duplicate of an identical earlier tool result for the same target; the original
content is still present above in this conversation and was not modified.]
```

Rules for the marker:

- it never claims to *be* tool output, and it never summarizes or paraphrases the elided content;
- it states only facts that are true at send time (verified by E3/E4 before it is written);
- it is content-free: no paths, no digests, no file names;
- if any part of the request already contains the marker prefix, the pass does nothing (E7).

### 4.4 Cache identity, lifetime and invalidation — answered by having none

The brief asks for cache identity, lifetime, invalidation, cross-session boundaries and concurrent-write
rules. The design answer is deliberate:

> **The pass keeps no cache. The request is the cache.**

| Question | Design answer |
| --- | --- |
| **Cache identity** | None. The "identity" of an elision is *the pair of part ids within one request*; it does not outlive the request |
| **Lifetime** | One request. The decision is recomputed from scratch every time the host assembles a request |
| **Invalidation** | Automatic: a new request is a new decision. There is no stored entry that could go stale |
| **Cross-session boundary** | No state crosses sessions because no state is kept. Sessions cannot contaminate each other |
| **Concurrent writes** | Nothing is cached, so there is nothing to invalidate. If a file changed between two reads, the two results differ (E3) and the pass does nothing |
| **Host reload / restart** | No persistence, so a reload loses nothing and cannot leave a half-applied state |
| **Path aliasing / symlinks** | Irrelevant to safety: equivalence is decided on **content bytes**, and the content is what the model receives. Path identity is used only for the human-readable record and stays hash-based |
| **Ranges and partial reads** | Also metadata. Two reads with different ranges produce different text; identical text is identical regardless of how it was produced. A truncated read that repeats is still a repeated read |
| **Tool errors** | Excluded (E5). Never elided |
| **Ambiguity** | No elision. The pass is *fail-closed about transforming* even though it is *fail-open about the host* |

This is what makes the strategy "minimal" in the brief's sense: it cannot rot, it has no TTL, no
invalidation bug class, and its worst case is doing nothing.

### 4.5 Explicit bypass, dry-run and fail-open

| Control | Behaviour |
| --- | --- |
| Global bypass (`DR_TOKEN_SAFE_MODE=off`, or plugin option `enabled: false`) | The hook returns immediately; the request is untouched; nothing is recorded |
| Dry-run (`mode: "observe"`, the default for the first milestone) | Eligibility and the would-be elision are recorded; **the request is never modified** |
| Apply (`mode: "apply"`, explicit opt-in) | The transformation runs, and its evidence is recorded |
| Fail-open to the host | Any exception, missing capability, unexpected shape, or unreadable part → return without mutating. The hook must never throw into the host's request builder (OpenCode's hook dispatcher has no error handling) |
| Fail-closed to the transformation | Any condition that is not positively verified → no elision |

---

## 5. Harness compatibility: why this lands on OpenCode and not on Codex

The experiment needs one thing: a channel to change the **prepared request** (or, failing that, the
result before it is stored) without breaking the host.

| Capability the experiment needs | OpenCode V2 (2.0.24) | Codex (0.162.0-alpha.17.2) |
| --- | --- | --- |
| Observe a tool result | ✅ Runtime-verified (`execute.after`) | ✅ Runtime-verified (`PostToolUse`, `tool_response`) |
| Observe the *prepared request* (the exact model payload) | ✅ **Runtime-verified** (Stage 1P: the callback fires during assembly with the complete request) | ❌ **Unsupported** — no hook exposes the message list |
| Rewrite only the outgoing request, leaving the stored transcript intact | ✅ Contract-verified (the request context is a separate object) | ❌ Unsupported |
| Rewrite a stored tool result | ✅ Contract-verified (`execute.after` event `result` is replaceable) | ❌ **Unsupported** — `updatedMCPToolOutput` is parsed as unsupported |
| Replace a model-visible result with different content | ✅ Contract-verified | ⚠️ Only `decision: "block"` feedback — not identical content, capped ~2.5k tokens, and it *blocks* |
| Verify the transformation independently against the bytes actually sent | ✅ **Runtime-verified** for the call (`session.hook("http.request")` fires for each attempt; Stage 1P read only presence, never content) | ❌ No equivalent |
| Detect the repeated read | ✅ Runtime-verified | ✅ Runtime-verified (Stage 1N) |
| Host-reported token measurement | ✅ Runtime-verified (`session.usage.updated`) | ⚠️ No hook carries usage; `exec --json` does (runtime-verified), app-server/rollout documented |

**Conclusion:** on Codex the *detection* half exists and is proven, and the *transformation* half does
not. A Codex "reuse the cached read" strategy would therefore have to either (a) change agent behavior
(block/deny, A5) or (b) substitute *different* content (A4) — both rejected in §3. **Codex is out of
scope for the first Safe Mode experiment**; it stays observation-only, and this is recorded as a
capability gap rather than worked around.

Two honest caveats about OpenCode, both of which shape the milestones in §11:

1. **Delivery and influence are settled; the *effect* is not.** Stage 1P runtime-verified that
   `session.hook("context")` fires during assembly with the complete request, and that the run behaved
   identically with the probe present and absent. Stage 1R then runtime-verified that the runtime
   **honours a mutated object**: a value written in the callback was the value captured on the wire
   (see [docs/OPENCODE_REQUEST_HOOK_VALIDATION.md](OPENCODE_REQUEST_HOOK_VALIDATION.md) §11). What is
   still unproven is the *effect* — that removing a duplicate leaves the model's answer correct — which
   is M2's wire check plus M3's deterministic gate. No token claim is possible before those.
2. The 2.0.24 declarations are the ones the repository already vendored (digests recorded in
   `integrations/opencode/src/types-v2.ts`); the API line is moving, so capability detection stays
   runtime and the adapter stays thin.

---

## 6. Benchmark design

The brief's order stands: **correctness first, and a candidate that cannot be shown correct is rejected
regardless of tokens.** This section defines three levels, in increasing cost, and the rules for each.

### 6.1 Level 0 — synthetic fixtures (exists today)

`benchmarks/` already runs fixture pairs through the real engine and reports
`available-unavailable` evidence honestly. Level 0 keeps working unchanged and is the *plumbing* check.
It can never support a savings claim, and the report says so in its own disclaimer.

### 6.2 Level 1 — deterministic request-level harness (new, no model, runs in CI)

A pure, deterministic test harness that feeds **recorded request shapes** (built in-repo, content
synthetic) through the real eligibility → transformation → safety-validation path and asserts:

1. **Information preservation** — every elided span's exact text is still present in the same
   transformed request (an *independent* checker re-walks the output; it does not trust the planner).
2. **Nothing else changed** — every retained part is byte-identical to its input; part count, order and
   roles are unchanged; only the designated parts differ.
3. **Structural validity** — the tool-call/tool-result pairing that the provider requires is intact
   (parts are rewritten, never removed).
4. **Marker integrity** — the only new text is the versioned marker; no part contains the marker prefix
   afterwards except the inserted ones (E7).
5. **Refusal cases** — identical text of a *non-allowlisted* tool, an error result, a below-threshold
   duplicate, a duplicate whose earlier copy is absent, and a request containing the marker prefix are
   all left **completely untouched**.
6. **Determinism** — the same input yields the same output and the same decision record; the pass is
   idempotent (running it on its own output changes nothing further).
7. **Boundedness** — a pathological request (very many parts / very large parts) stays inside the work
   budget and either elides or refuses, never loops or grows state.
8. **Fuzz/property** — randomized part lists never violate (1)–(4).

Level 1 is the gate. Failing it rejects the strategy outright.

### 6.3 Level 2 — paired real-harness experiment (needs authorization and budget)

**Design:** for each task, run the same prompt twice against the same repository revision with the same
model — once with the pass **disabled** (control) and once **enabled** (treatment) — each in a fresh
session, and compare with the existing provenance/comparison machinery.

| Control | How |
| --- | --- |
| Model differences | One pinned model identifier, recorded in provenance; never compared across models |
| Session state | A fresh session per run; no session reused between control and treatment |
| Cache effects | The *order* of pairs alternates (ABBA) per task so provider cache warm-up cannot systematically favour one arm; `cache.read` / `cache.write` are reported **separately** and never folded into one number |
| Prompt drift | The prompt is a file whose SHA-256 is recorded in provenance; a different hash invalidates the pair |
| Task complexity | Fixed task list spanning small/medium/large fixtures, defined before the run and not edited afterwards |
| Tool behavior | Tool-call count and repeated-read count are recorded per run (observer data), so a token change can be attributed |
| Instrumentation | Both arms load the same observer; only the pass's apply switch differs |

**Required measurements** (all from the brief, mapped to real sources):

| Measurement | Source | Evidence class |
| --- | --- | --- |
| Task completion and correctness | Task acceptance test + rubric, recorded per run | `measured` |
| Compilation / tests / functional behaviour | The fixture repo's own test command; exit status captured | `measured` |
| Input / output tokens | Host-reported `session.usage.updated` (OpenCode V2, runtime-verified) | `measured` |
| Cache-related fields | `cache.read` / `cache.write`, reported separately with semantics stated | `measured` |
| Additional latency | Wall-clock per turn *and* per-hook duration | `measured` (no guarantee implied) |
| Tool-call behaviour | Observer: starts, completions, correlation, repeated reads | `measured` |
| Failure rate | Failed turns / refusals / aborted sessions | `measured` |
| Internal observer/optimizer errors | Engine decisions (`failed`) + observer internal-failure counters | `measured` |
| Evidence provenance | Existing `createProvenance` + the run's prompt/repo/model/config identity | `measured` |

**Mechanism evidence (mandatory, and the part that most benchmarks skip):** a token delta is not
evidence that *this* pass caused it. Each treatment run must additionally prove the mechanism fired:

- the decision record lists the elided parts and removed character counts;
- the outbound request observed at `session.hook("http.request")` is **shorter by exactly the recorded
  removed length** (within the provider's framing), and the retained parts' digests are unchanged.
  This needs a **length-only** wire measurement — never content. The Stage 1P probe deliberately
  recorded body *presence* only, so extending it to a length is part of M2's work, not something this
  design may assume exists;
- if the mechanism cannot be shown to have fired, the run is recorded as **`no-opportunity`**, not as a
  zero-saving datapoint, and contributes nothing to the comparison.

**Rules of interpretation** (from the brief, made operational):

1. A single turn's usage is **never** proof of savings.
2. Estimates are never substituted for missing measurements; the metric stays `unavailable`.
3. A candidate whose correctness cannot be established is **rejected**, even with fewer tokens.
4. A delta inside run-to-run spread is reported as `no-change`, not as an improvement.
5. Tokens are never summed across overlapping host fields (Codex explicitly overlaps; see
   [docs/CODEX_OBSERVER.md](CODEX_OBSERVER.md) §9).
6. Any correctness failure in the treatment arm ends the experiment for that task.

**Statistical honesty:** ≥ 3 paired runs per task, ≥ 5 tasks (≥ 15 pairs), and the report gives the
distribution (per-pair deltas, median, spread) rather than one headline number. Fewer than the minimum
is reported as an incomplete experiment, never as a result.

### 6.4 A blocking gap this stage found: the comparison contract cannot express a treatment

`compareRuns` declares a pair `invalid` when `configurationId` differs, and `configurationId` includes
`optimizerConfiguration` (`harness | revision | mode | configuration`). A control arm with the pass
**disabled** and a treatment arm with it **enabled** necessarily differ there — so the existing framework
would reject exactly the comparison Safe Mode needs, even though `runBenchmarkSuite` already accepts
separate `baselineConfiguration` / `candidateConfiguration` values.

**This must be fixed before any `benchmark-verified` verdict is possible** — and it must be fixed by
*declaring* the treatment, not by weakening the guard:

- provenance gains a declared, single-axis **variant** (e.g. `variant: "control"` vs
  `variant: "safe-mode-v1"`), plus the identity every arm must share;
- comparability requires: same fixture/task, same harness, same model, same repository revision, same
  prompt hash, same mode — and **exactly one declared differing axis**;
- any second difference (or an undeclared one) stays `invalid`;
- the correctness precedence and the "candidate failure = regression" rule are untouched.

Until that exists, Safe Mode savings are **unmeasurable by the project's own standard**, and this
document claims none.

**Resolved in Stage 1S.** The contract above now exists. A `DeclaredVariant` names the two arms
and the single permitted axis (`optimizer-configuration`); the declaration is validated before any
run is recorded; both arms record their declared identity in provenance; and `compareRuns`
re-verifies every comparability fact except that one axis — same fixture and input hash, harness,
mode, optimizer revision, model, repository revision, correctness criteria and measurement
definitions — before it permits the comparison. A half-declared pair, a swapped arm assignment or
a second difference stays `invalid`, and undeclared comparisons keep the original strict
`configurationId` guard unchanged. See [docs/BENCHMARKING.md](BENCHMARKING.md) for the contract and
examples. This closes the *contract* gap only: no Safe Mode transformation is implemented, so no
savings are measurable in this stage and none are claimed.

---

## 7. Token measurement and provenance

### 7.1 The distinction the brief asks about

Four different things are easily conflated. They are separated here by contract stability, session
attribution, privacy cost and evidence quality.

| Source | What it is | Contract stability | Session attribution | Privacy impact | Desktop support | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| **Hook payloads** | lifecycle/tool metadata delivered to Dr. Token | Stable (Stages 1M/1N) | ✅ `session_id`/`turn_id` in the payload | None — nothing extra is read | ✅ both (delivery of user-level hooks in the app is *unverified*) | **No usage exists in them** — runtime-verified over 16 live payloads |
| **`codex exec --json`** | the CLI's own event stream; `turn.completed.usage` with `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` | Contract-confirmed (pinned source); **observed live** in Stage 1N | ✅ per turn, in the stream Dr. Token already launched | None beyond the run it launched; **no user conversation is read** | ⚠️ CLI-only (this is the benchmark/CLI surface, not the Desktop app) | **High** — real numbers for the exact turn, observed |
| **App-server `thread/tokenUsage/updated`** | JSON-RPC notification (per-turn `last` + cumulative `total`, cached/cache-write/reasoning, `modelContextWindow`) | Documented as experimental/unsupported for production; schema runtime-verified in Stage 1K | ✅ for threads the client itself owns | Low *if* a client owns the thread — but on this machine the Desktop app runs the app-server as a **private child process with no socket to attach to** | ❌ not attachable here | Medium (today: unavailable) |
| **Rollout `token_count` records** | locally stored session artifacts under the Codex home | Source-confirmed, moving | ✅ | **High** — the store holds every conversation; reading it means touching unrelated user data | shared store | Low-for-now (privacy cost outweighs) |
| **OpenCode `session.usage.updated`** | in-process event with host-reported tokens/cost | Runtime-verified (Stage 1H) | ✅ `sessionID`; the adapter already gates by project scope | None — the plugin already receives it in-process | ✅ (Desktop 2.0.24) | **High** — the value the host itself stores |

### 7.2 Recommendation (design only — nothing is implemented here)

1. **For benchmark and CLI runs**, use **`codex exec --json`** and **OpenCode `session.usage.updated`**.
   Both are `measured`, both are attributable to the exact turn, and neither requires reading anything
   the user did not ask Dr. Token to run. The Codex path adds no configuration change and no new
   permission surface.
2. **Attribution stays with the hooks.** The hook payloads carry the session/turn identity; usage comes
   from the other source; the **join key is the host's own session id** (`session_id` in the hook payload
   is the same id the stream reports — verified in Stage 1N, where the summary's `sessionId` equals the
   host thread id). Dr. Token must never invent an attribution when the join key is missing; the
   observation is then recorded as unattributed, exactly as the existing adapters already do.
3. **The app-server remains a future option, not the plan.** It is the only path to per-turn usage for a
   live Desktop session, but it is documented as experimental and unattachable here. It is therefore
   recorded as *unavailable today*, not as the design.
4. **Rollout files are refused by default**, because their privacy cost is unbounded relative to the
   benefit the other two sources already provide. If ever revisited, it must be opt-in, scoped to one
   thread id, and documented as reading user-owned files.
5. **Cache fields keep their semantics.** `cached_input_tokens` / `cache.read` are *not* "new input";
   they are reported separately, never summed into one headline number, and a saving claim must survive
   the mechanism check in §6.3 regardless of which field moved.

### 7.3 The interface to implement later (types only, no subsystem now)

A usage observation stays a *measurement with provenance*, matching the vocabulary already in
`benchmarks/src/types.ts` — no new subsystem is created in this stage:

```ts
/** Where a token figure came from, and how much it can be trusted. */
export type UsageSourceKind =
  | 'opencode-session-usage'      // runtime-verified, in-process
  | 'codex-exec-json-turn-usage'  // runtime-verified, per turn
  | 'codex-app-server-thread-usage' // documented, experimental, unattachable today
  | 'codex-rollout-token-count';  // refused by default (privacy)

export interface UsageObservation {
  readonly source: UsageSourceKind;
  /** Host-assigned identity; the join key with hook observations. Never synthesized. */
  readonly sessionId: string;
  readonly turnId?: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** 'measured' only when the source really reported it; never 'estimated' by derivation. */
  readonly evidence: 'measured';
  readonly observedAt: string;
}
```

Explicit non-goals: no model-context window inference, no cost estimation, no cross-session aggregation,
and no usage reading unless the user opted in.

---

## 8. Architecture and interfaces

### 8.1 Separation of concerns

The brief's six concerns map to six layers. The rule is that **only layer 3 changes model-visible
content**, and it may only do so when layer 2 said yes and layer 4 independently agrees afterwards.

```
          ┌──────────────────────────── harness adapters (thin) ────────────────────────────┐
          │  OpenCode V2: session.context → RequestView · apply outcome · http.request check  │
          │  Codex:      capability gap → strategy not registered (no request channel)        │
          └───────────────────────────────────────┬────────────────────────────────────────┘
                                                  │ RequestView (harness-neutral)
  1 Observation  ──────────────► tool identity, part kinds, exact text
  2 Eligibility  ──────────────► pure predicate → EligibilityDecision (content-free reason)
  3 Transformation ────────────► pure function → new part list (never mutates in place)
  4 Safety validation ─────────► independent re-check of the *output* → SafetyVerdict
  5 Evidence ──────────────────► content-free record: counts, lengths, digests, decisions
  6 Bypass / fallback ─────────► any failure or uncertainty → return the original request
```

Layers 2–5 are **pure and harness-independent**; each harness contributes only a view adapter. That is
what keeps harness-specific code thin and keeps the strategy testable without any host.

### 8.2 Interfaces (design sketch, not code in this stage)

```ts
export type HarnessCapability =
  | 'request.observe'      // can see the prepared request
  | 'request.rewrite'      // can hand the host a modified prepared request
  | 'result.rewrite'       // can hand the host a modified stored tool result
  | 'wire.observe'         // can observe the bytes actually sent
  | 'usage.report';        // host reports token usage

export interface HarnessCapabilities {
  readonly [capability in HarnessCapability]: boolean;
}

/** One part of a prepared request, reduced to what safety needs. */
export interface RequestPartView {
  readonly partId: string;                 // stable within one request
  readonly role: 'tool-result' | 'other';
  readonly toolName?: string;              // present for tool results
  readonly status?: 'completed' | 'error';
  readonly text: string;                   // exact model-visible text
  readonly digest: string;                 // sha256(text) — for records only
}

export interface RequestView {
  readonly sessionId: string;
  readonly requestKind: 'primary' | 'compaction' | 'title' | 'generate';
  readonly parts: readonly RequestPartView[];
}

export interface ElisionPlan {
  readonly keepPartId: string;             // the copy that stays
  readonly dropPartId: string;             // the copy replaced by the marker
  readonly removedLength: number;
  readonly removedDigest: string;
}

export interface EligibilityDecision {
  readonly eligible: boolean;
  readonly reason: string;                 // static, content-free
  readonly plans: readonly ElisionPlan[];
}

export interface TransformationOutcome {
  readonly changed: boolean;
  readonly parts: readonly RequestPartView[];  // rebuilt list; inputs never mutated
  readonly reason: string;                     // static, content-free
}

export interface SafetyVerdict {
  readonly safe: boolean;
  readonly violations: readonly string[];  // content-free codes
}

/** A Safe Mode strategy is pure: it decides, transforms, and can be re-verified. */
export interface SafeModeStrategy {
  readonly id: string;
  readonly description: string;
  readonly requiredCapabilities: readonly HarnessCapability[];
  evaluate(view: RequestView): EligibilityDecision;
  transform(view: RequestView, decision: EligibilityDecision): TransformationOutcome;
  verify(before: RequestView, outcome: TransformationOutcome, decision: EligibilityDecision): SafetyVerdict;
}
```

**Capability gating, not guessing.** A strategy is registered only when every capability in
`requiredCapabilities` is `true` for that harness. Otherwise it is reported as
`strategy-disabled: <reason>` and never approximated. This is how "unsupported capabilities are disabled
rather than guessed" is enforced mechanically:

| Harness | Capabilities | Consequence |
| --- | --- | --- |
| OpenCode V2 | `request.observe` ✅, `request.rewrite` ✅, `wire.observe` ✅, `usage.report` ✅, `result.rewrite` ✅ | eligible for the experiment, **gated behind runtime proof of the rewrite** |
| Codex | `request.observe` ❌, `request.rewrite` ❌, `result.rewrite` ❌, `wire.observe` ❌, `usage.report` ❌ (hooks) | **disabled**: the strategy is not even constructed |

### 8.3 Where this touches the existing core (minimally)

The shared core models a request as a single `context: string` (`OptimizationRequest`). A
request-with-parts view does **not** replace that. The proposed minimal shape:

- keep `OptimizationRequest`/`OptimizationResult`/`OptimizerPass` exactly as they are for string
  artifacts;
- add a **parallel** artifact view (`RequestView` / `RequestPartView`) and a strategy interface for it,
  so existing passes and benchmarks are untouched;
- reuse the existing evidence vocabulary (`none | estimated | measured | benchmark-verified`) and the
  existing decision shape (`passId`, `action`, `reason`, `contextUnchanged`, `evidence`) for reporting,
  with `reason` remaining static and content-free;
- reuse `benchmarks` provenance/comparison rather than inventing a second measurement stack — with the
  §6.4 variant fix.

### 8.4 Development order (unchanged)

**Safe → Aggressive → Balanced.** Nothing in this design licenses work on Aggressive or Balanced mode,
and neither mode may begin until Safe Mode has a passing Level 2 experiment and a published, honest
result. Aggressive Mode remains undefined on purpose.

---

## 9. Security and correctness

### 9.1 Non-negotiable invariants

| # | Invariant | How it is enforced |
| --- | --- | --- |
| I1 | No unintended modification of code or files | The pass never writes to the filesystem; it transforms an in-memory request view. Tool calls and files are untouched |
| I2 | No unauthorized permission changes | The strategy declares no permission capability and never calls `permission.hook("evaluate")`; the Codex adapter sets no permission field (Stage 1N §14.6) |
| I3 | No leakage of prompts, tool outputs or credentials | Records carry counts, lengths and digests only; the marker is content-free; nothing is persisted by the pass |
| I4 | No stale or mis-scoped content | There is no cache and no cross-session state (§4.4); each decision is derived from the request being sent |
| I5 | No altered result presented as equivalent unless validated | Elision requires byte-identical text present in the same request (E3/E4), and an *independent* verifier re-checks the output (§8.1 layer 4) |
| I6 | No fabricated savings | Only `measured` token figures are compared; estimates stay `unavailable`; mechanism evidence is mandatory (§6.3) |
| I7 | No unbounded resource growth | Per-request, bounded part scan, no persistence, no timers |
| I8 | No host-breaking failures | Double containment (observer + adapter), fail-open to the host, and the transformer is fail-closed in the face of doubt |
| I9 | No optimization when eligibility is uncertain | E1–E9 are conjunctive; ambiguous input means "do nothing" |
| I10 | The coding task comes first | Any correctness regression rejects the candidate outright, regardless of tokens |

### 9.2 Threat model

| Threat | Concrete scenario | Mitigation |
| --- | --- | --- |
| **False equivalence** | Two parts are treated as duplicates but differ (whitespace, Unicode, line endings) | Direct byte comparison on the exact text (E3); an independent checker re-verifies presence of the removed span |
| **Marker spoofing / nesting** | A tool output contains Dr. Token's marker text, or a file tries to make the marker ambiguous | E7: if any part already contains `dr-token/safe-mode/`, the pass refuses |
| **History corruption** | Removing a part breaks tool-call/tool-result pairing | Parts are rewritten, never removed; structure preserved; Level 1 asserts pairing validity |
| **Privacy leak via records** | Records containing file content or paths (the observer's rule, restated) | Counts, lengths and sha256-only fields; the marker names nothing |
| **Permission escalation** | The strategy quietly enabling a tool, or a Codex hook returning a decision | No permission capability is declared; the Codex adapter still writes no stdout and exits 0 |
| **Stale/poisoned cache** | An old file version served for a new read | Structurally impossible: no cache exists |
| **Resource exhaustion** | A huge request makes the pass scan unboundedly | Bounded scan budget (E9); on overflow, no elision |
| **Host compatibility break** | The host renames or changes `session.hook("context")`, or the shape is not what was expected | Capability detection at load; any mismatch disables the strategy (never a partial guess) |
| **Marker misread by the model** | The model treats the marker as content and behaves oddly | The marker is explicit and truthful at send time; the retained copy is present; Task-correctness runs would catch systematic harm, and the bypass is one setting away |
| **Measurement self-deception** | A token delta attributed to the pass when it was provider caching | Mechanism evidence + separate cache fields + ABBA ordering (§6.3) |
| **Two plugins rewriting the same request** | Another plugin also edits `messages` | The pass re-reads the parts it is given and never trusts an earlier plan; on unexpected content, no elision. Coordination beyond this is an open question (§12) |

### 9.3 Rollback and bypass

| Level | Action | Effect |
| --- | --- | --- |
| 1 | `mode: "observe"` (the first shipped milestone) | Nothing is transformed; only records are written |
| 2 | `DR_TOKEN_SAFE_MODE=off` / plugin option `enabled: false` | The hook returns immediately; the host behaves exactly as without Dr. Token |
| 3 | Remove the plugin entry from the project's OpenCode configuration | The plugin never loads |
| 4 | Remove `integrations/opencode` and any built package | Full removal; the observer's own summary file (if configured) is the only artifact, and it is append-only text |
| 5 | Codex | Unchanged and still observation-only — no optimization to roll back |

There is no persistent Safe Mode state to clean up: no cache, no database, no daemon, no timers.

---

## 10. Failure scenarios and their expected handling

| Scenario | Expected behaviour |
| --- | --- |
| The host does not deliver `session.hook("context")` (or the payload is not the expected shape) | Capability detection disables the strategy; the adapter reports `strategy-disabled`; the observer keeps working |
| The mutated request is **not** honoured by the host | Detected at `http.request` (no shrink) → the apply mode is reported as **ineffective**, no savings claim is made, and the milestone stops. **Not observed in Stage 1R**: the edit reached the wire |
| The request contains no duplicate | Normal, expected, and the most common case: record `no-opportunity` |
| The duplicate's earlier copy has already been trimmed by compaction | No elision (E4) — the pass never assumes a copy outside the payload it holds |
| A file changed between the two reads | Different content → no elision |
| The tool result is an error, a partial read, or a non-allowlisted tool | No elision |
| A part cannot be mapped to a tool identity | No elision |
| The pass throws, times out, or exhausts its budget | The original request is used, unchanged; the failure is recorded as a content-free counter |
| The host is reloaded / a session ends mid-flight | Nothing to reconcile; the next request is evaluated from scratch |
| Two sessions run concurrently | Independent: no shared state exists |
| The model's task outcome worsens in treatment runs | The candidate is rejected; the experiment stops; the finding is published |

---

## 11. Implementation milestones (not started)

| Milestone | Deliverable | Gate to pass |
| --- | --- | --- |
| **M1 — observe only** — ✅ **implemented (Stage 1Q)** | OpenCode V2 adapter builds a request view from `session.hook("context")` in observe mode and records content-free would-elide decisions; see [docs/SAFE_MODE_M1_OBSERVATION.md](SAFE_MODE_M1_OBSERVATION.md) | Recorded Stage 1P evidence replayed offline: every count reproduced, and the one live duplicate (135 chars) is correctly classified *ineligible* against the 400-char threshold. Still open: duplicate rates in **real** work, the (c) wire baseline, and E8's primary-only gate (not observable at this hook). **No mutation** |
| **M2 — apply behind an opt-in flag** | The transformation runs in `mode: "apply"`; the wire check proves the body shrank by the recorded amount and retained parts are unchanged | Mechanism proven end-to-end before any benchmark — the **influence half is already proven (Stage 1R)**; the apply-mode shrink check is still M2's own gate |
| **M3 — the correctness gate** | Level 1 harness (§6.2) in CI, including the independent preservation checker and the refusal cases | All Level 1 assertions pass; failing rejects the strategy |
| **M4 — benchmark schema** | Declared single-axis variant in provenance + comparability rule (§6.4) | A control/treatment pair compares as `unavailable`/`benchmark-verified`, never `invalid` |
| **M5 — Level 2 experiment** | Paired control/treatment runs with mechanism evidence and the §6.3 controls | Published result, or a published rejection |
| **M6 — widen the allowlist (only after M5)** | Add shell reads the observer's classifier already identifies as single-file reads, with the same byte-equality + presence rules | Each addition re-earns M1–M5 evidence |
| **Codex** | Not scheduled. Blocked by capability (no request/result rewrite). Revisit only if the runtime documents a channel | — |

---

## 12. Open questions this stage deliberately leaves open

1. **Would a mutated request be honoured?** ✅ **Answered: yes (Stage 1R).** Stage 1P settled delivery, timing and payload completeness; Stage 1R captured the outbound body and found the substituted value on the wire, with no other field changed. See [docs/OPENCODE_REQUEST_HOOK_VALIDATION.md](OPENCODE_REQUEST_HOOK_VALIDATION.md) §11. What remains open is the *effect* on task correctness (M3–M5), not the mechanism.
2. **Does an in-place rewrite of `event.result` reach the model on 2.0.24?** Contract-verified only; not needed for M1 (request-level elision avoids it), but relevant for a later, cheaper variant.
3. **How do two plugins that both edit `messages` interact?** Unknown; the design refuses on unexpected input rather than coordinating.
4. **Does the marker change model behaviour measurably?** Only Level 2 can say — and that is exactly why correctness is a gate, not a metric.
5. **What is the real duplicate-read rate in ordinary work?** Unknown; M1 measures it before anything is optimized.
6. **Do injected/elided bytes move any host usage counter?** Unknown; the mechanism check is the bridge between "we changed the request" and "the host counted fewer tokens".
7. **Does the Codex Desktop app deliver hooks?** Still the largest Codex unknown (Stage 1N §14.9).

## 13. What Stage 1O did not do

- No Safe Mode transformation exists, in any mode, in any harness.
- No Aggressive or Balanced Mode work was done or planned.
- No new harness adapter, no Codex Desktop hook installation, no desktop UI, no SQLite, no telemetry.
- No model call was made, and no Codex turn was started.
- No benchmark savings are claimed, estimated or implied anywhere in this document.
- No file in this repository was committed or pushed (Stage 1O is documentation only, plus the Stage 1N
  evidence closeout).
