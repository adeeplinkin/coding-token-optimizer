# Safe Mode M2 — first apply pass, its request-kind gate and the wire-level shrink check (Stage 1T)

**Status: implemented, disabled by default, mechanism verified, not benchmarked.**
No token saving is claimed anywhere in this document.

Stage 1Q measured Safe Mode opportunities and modified nothing
([docs/SAFE_MODE_M1_OBSERVATION.md](SAFE_MODE_M1_OBSERVATION.md)). Stage 1R proved that a value a plugin
writes inside `ctx.session.hook("context")` is the value the runtime sends to the provider
([docs/OPENCODE_REQUEST_HOOK_VALIDATION.md](OPENCODE_REQUEST_HOOK_VALIDATION.md) §11). Stage 1T adds
the first actual transformation — `safe.exact-duplicate-tool-result-elision`, version 1 — behind an
explicit opt-in, resolves the request-kind gate that both earlier stages left open, and repeats the
Stage 1R experiment for a **size change**: with an eligible duplicate, does the real outbound request
become shorter, and is the elided duplicate the *only* thing that differs?

It also confirms E8 (the primary-only rule) three independent ways, including inside the installed
runtime's own dispatch site, so the gate is a verified fact rather than a guess about timing.

---

## 1. What Stage 1T is, and what it is not

**Is:**

- one pass, one version, one marker, one write site;
- off unless a caller explicitly asks for `apply` (`DR_TOKEN_SAFE_MODE=apply` or the `safeMode`
  plugin option);
- exhaustively tested through the real V2 adapter boundary, including malformed input, invalid kinds,
  duplicate content, idempotence, frozen/accessor payloads, privacy and unchanged originals;
- verified on the wire against a private loopback provider, with disabled, ineligible and
  unverified-kind controls.

**Is not:**

- a savings claim. Characters and bytes removed are properties of the assembled request; no token
  figure is derived from them (design §5);
- a claim that model behaviour is unaffected. Whether the marker changes model behaviour, and whether
  coding correctness survives the transformation, is **Stage 1U's** paired-task question. Stage 1T
  deliberately stops before it;
- a general Safe Mode. Aggressive and Balanced modes, a desktop UI, SQLite, other harnesses and any
  new adapter are out of scope.

---

## 2. The transformation

### 2.1 Rule

While the host assembles a model request, if two `tool-result` parts of the **same** read-only tool
inside the **same** request carry **byte-identical** model-visible text, the **later** part's
`result.value` is replaced with the versioned marker — but only when the earlier identical copy is
**still present in that same request**. Nothing else about the request is touched.

E3 + E4 are the whole safety argument: at send time the removed text exists elsewhere in the same
payload, so no information the model was going to receive is lost.

### 2.2 Identity and eligibility

| Condition | Implementation |
| --- | --- |
| E1 capability | The pass is reachable only through the V2 `context` hook registration in `plugin-v2.ts`; a host without that capability records it and registers nothing |
| E2 same read-only tool | Group identity is exact `name` + `namespace`; eligibility additionally requires `name === "read"`, **no** namespace and `providerExecuted !== true` |
| E3 byte-identical text | Direct JavaScript string equality on the whole value — the text is the map key. No hashing in the comparison path |
| E4 earlier copy present | Structural: only **later** copies are targets, and nothing is removed |
| E5 completed, non-error | `result.type` must be exactly `text`; `error` is never elided |
| E6 size threshold | `minEligibleCharacters` = **400**, unchanged from M1 (E6's default). Shorter duplicates are still detected and counted, then refused |
| E7 marker collision | Any examined part already containing `dr-token/safe-mode/` refuses the **whole** request |
| E8 kind is `primary` | Section 3 |
| E9 work budget | A bounded scan refuses the whole request (`scan-bounded`) |

Anything else refuses. The pass never alters tool inputs, tool identity, system instructions,
permissions, model options, tool definitions or error results, and it is the **only** module in the
package containing a payload write: one `result['value']` assignment, asserted by
`tests/source-guard.test.ts`.

### 2.3 The marker

```
[dr-token/safe-mode/v1: duplicate of an identical earlier tool result for the same target; the original content is still present above in this conversation and was not modified.]
```

178 UTF-8 bytes (measured on the wire, §6). It is one line, versioned, unmistakable, content-free: it
never paraphrases the elided content, and it contains the M1 marker prefix `dr-token/safe-mode/`,
which is what makes a second pass over the same request refuse (E7) instead of eliding the marker.
The marker is shorter than the 400-character eligibility threshold, so it can never become an
eligible duplicate itself.

### 2.4 Failure posture

Fail-open at the edges, fail-closed about transforming:

| Situation | Behaviour |
| --- | --- |
| No `read` duplicate, or one below 400 characters | `attempted: true`, `applied: false`, nothing written |
| Payload frozen / accessor-backed `value` | The write throws or the guard fails → `assignment-guard-failed`, nothing written |
| A part whose payload cannot be read exactly | That part is skipped, never guessed at; the request is unaffected |
| Analyzer and locator disagree about how many occurrences are eligible | **`plan-mismatch`**: the whole request refuses, nothing is written |
| Any internal throw | Contained in the observer (`internal-failure`); the host's request builder never sees it |
| The host does not deliver the hook | Capability recorded as unavailable; the pass never runs |
| Requested while observation is disabled or the observer is bypassed | Reported (`safe-mode-apply-unavailable`); nothing is modified |

---

## 3. E8: the request-kind gate, verified

### 3.1 The problem

`SessionRequestKind` is `primary | compaction | title | generate`, but the published `SessionContext`
that `session.hook("context")` delivers has **no `kind` member** — the kind lives on the model-call
hooks. A pass that cannot show it is running on a primary request must not run at all.

### 3.2 The gate

Two positively verified facts, and a refusal when either is missing:

1. **`requestKindBasis === 'context-hook'`** — accepted only with the evidence in §3.3. The type also
   carries `unknown`, so a caller that cannot state a basis has an honest value to pass instead of a
   guess.
2. **payload shape** — the payload must be primary agent-loop shaped: a `messages` array, a non-empty
   `agent`, and a **non-empty** `tools` registry. The measured live primary requests each declared 12
   tool definitions; a payload that declares none is not the agent loop, whichever hook delivered it.

No timing, ordering or event correlation is used anywhere in the gate.

### 3.3 Verification, three ways

**(a) Contract.** `@opencode/plugin` 2.0.24 declares `SessionHooks` with a separate member per kind
(`context`, `compaction`, `generate`, `title`) alongside the model-call hooks. Mirror and verbatim
excerpt: `integrations/opencode/src/types-v2.ts`.

**(b) The runtime's own dispatch site.** In the installed `opencode-cli.exe` (version **2.0.24**,
206,128,008 bytes, sha256 `37cafb7e6f9f80ae3d198dc5a248d9b8c24fde58b96cf865f823c633cb4d37fc`) there is
exactly one place that maps a request kind to a hook name. The excerpt below is the binary's own
minified text; the only change is that it is wrapped at statement boundaries for page width, and no
character of it was edited:

```text
a=(c,d)=>(f,D)=>e.trigger("session",c,{...f,agent:d,tools:D});
return wb.of({primary:(c)=>s("primary",c,a("context",c.agent)),
compaction:(c)=>s("compaction",c,a("compaction",c.agent)),
generate:(c)=>s("generate",c,a("generate",c.agent)),
title:(c)=>s("title",c,(d)=>e.trigger("session","title",d))})
```

The same mapping reflowed for reading (**reformatted, not a quotation**):

```text
primary    → session hook "context"
compaction → session hook "compaction"
generate   → session hook "generate"
title      → session hook "title"
```

Occurrence counts in the binary: `wb.of({primary` = **1**, `a("context",` = **1**,
`a("compaction",` = **1**, `a("generate",` = **1**, `trigger("session","title"` = **1**,
`s("primary"`/`s("compaction"`/`s("generate"`/`s("title"` = 1 each, that single dispatch helper
`trigger("session",c,` = **1**, and a direct `trigger("session","context"` = **0** — the `context` hook
has no other dispatcher anywhere in the binary. Each service method triggers exactly one hook name, and
the only method that triggers `context` is `primary`. `compaction`, `generate` and `title` are therefore
excluded **by construction**, not by observation.

Reproduce (read-only; the binary is Bun-compiled, so its embedded JavaScript is searchable as text):

```sh
EXE="$LOCALAPPDATA/Programs/@opencodedesktop/resources/opencode-cli.exe"
grep -aoE '.{0,900}wb\.of\(\{primary.{0,300}' "$EXE" | tr -c '[:print:]' '\n' | sort -u
for p in 'wb\.of\(\{primary' 'a\("context",' 'a\("compaction",' 'a\("generate",' 'trigger\("session","title"' \
         'trigger\("session","context"' 'trigger\("session",c,' 's\("primary"' \
         'session\.hook\("context"' 'session\.hook\("compaction"' 'session\.hook\("generate"'; do
  printf '%-36s %s\n' "$p" "$(grep -aoE "$p" "$EXE" | wc -l)"
done
node -e "const{createHash}=require('node:crypto'),f=require('node:fs');const h=createHash('sha256');\
h.update(f.readFileSync(process.env.LOCALAPPDATA+'/Programs/@opencodedesktop/resources/opencode-cli.exe'));console.log(h.digest('hex'))"
```

The `session.hook("context"|"compaction"|"generate")` counts (10 / 9 / 9) are *plugin registration*
sites for those names — built-in plugins attach the same callback to several kinds — and are not
dispatch sites. Only the single `wb.of({...})` object maps kinds to names.

**(c) A live session.** In a real 2.0.24 session against a loopback provider (zero cost, no model call,
no credential — §6), the adapter registered every candidate hook name and recorded each invocation
with the payload's key names:

| Hook | Invocations | Payload keys |
| --- | --- | --- |
| `context` | 2 | `agent, messages, model, options, sessionID, system, tools` |
| `title` | 1 | `messages, model, options, sessionID, system` |
| `model.request:primary` | 2 | `agent, baseURL, headers, kind, model, sessionID` |
| `model.request:title` | 1 | `agent, baseURL, headers, kind, model, sessionID` |

`context` fired once per `model.request` of kind `primary` (2 and 2), the title request fired `title`
and **no** `context`, and the two payload shapes are different: the `title` payload has no `agent` and
no `tools`, so it fails the shape gate as well.

A separate reconnaissance run tried to force a compaction request by declaring a 1-token context limit
on the synthetic provider's model; the runtime did not compact, and every request was `primary`. That
is recorded as an unsuccessful attempt, not as evidence — the exclusion above comes from (b).

### 3.4 Residual assumptions (stated, not hidden)

- A future runtime could map kinds to hook names differently. The gate would then be wrong on that
  runtime; nothing in this repository pins the mapping at runtime, and the pass would need re-verifying
  before apply is enabled outside a synthetic experiment.
- An experimental or undocumented path could trigger `context` for something that is not the primary
  agent loop. The shape gate is the second barrier, and anything unrecognised refuses.

Both are covered by the same refusal behaviour: the pass does nothing rather than something it cannot
account for.

---

## 4. Idempotence, concurrency and reloads

The pass keeps **no state**: the request is the cache (design §4.4). There is no cache, TTL, session
map, lock or file, and the module is synchronous, so two passes cannot interleave inside one request.
Two guards make a repeated or concurrent application harmless:

- the marker carries the M1 prefix, so a second pass over the *same* payload refuses outright (E7);
- every write re-reads the value at its location and writes only when it still equals the text the plan
  was made from (`assignment-guard-failed`), so a second plugin instance, a concurrent request or a host
  reload that changed the value first makes this pass skip.

Verified by test: the same payload delivered twice applies once
(`safe-mode-observation.test.ts`, adapter level) and two independent plugin instances observing one
request produce one elision and one refusal.

---

## 5. Bypass

| Setting | Effect |
| --- | --- |
| unset / `off` | Safe Mode inert; `ctx.session` is never read, no session hook is registered |
| `observe` | Content-free opportunity counting only; no write path is reachable |
| `apply` | Observation **plus** the pass, resolved to the `observe` mode with the apply switch on |
| anything else | Reported (`safe-mode-setting-ignored`); Safe Mode stays off |
| `DR_TOKEN_OPENCODE_OBSERVER=off` / `enabled: false` | Everything, including apply, is bypassed and a requested apply is reported (`safe-mode-apply-unavailable`) |

Apply cannot run without the observation path, because the observation path is what contains its
failures and counts its outcomes.

---

## 6. Wire-level evidence

The Stage 1R experiment was repeated for **size**. It uses a disposable project, a synthetic fixture,
the installed 2.0.24 CLI and a private loopback capture server standing in for the provider: no model is
called, no credential is used and nothing is spent. Sources:
`integrations/opencode/scripts/stage1t-setup.mjs`, `stage1t-run.mjs`, `stage1t-verify-wire.mjs`, and
`stage1r-capture-server.mjs` (extended with `--tool-calls`, default `1`, so Stage 1R's recorded run is
unchanged).

The synthetic model asks for the same `read` **twice in one assistant turn**, so the next assembled
request contains two byte-identical tool results of 1951 characters — above the 400-character
threshold. Five runs, each a real session against the capture server:

| Run | Setting | Fixture | Last request bytes | Markers on the wire |
| --- | --- | --- | --- | --- |
| `wire-disabled` | `off` (control) | 1951-char duplicate | 25,771 | 0 |
| `wire-eligible` | `apply` | 1951-char duplicate | **23,915** | 1 |
| `wire-ineligible-off` | `off` (control) | 201-char duplicate | 22,015 | 0 |
| `wire-ineligible-apply` | `apply` | 201-char duplicate | 22,015 | 0 |
| `wire-kind-unverified` | `apply`, basis `unknown` | 1951-char duplicate | 25,771 | 0 |

`node integrations/opencode/scripts/stage1t-verify-wire.mjs` — **13/13 PASS**, exit 0. The checks that
matter, with their numbers:

1. **the marker reaches the wire exactly once** in the treatment and never in any control;
2. **exactly one attribute of the body differs**: `$.messages[4].content` — no field removed, no field
   added, no other message touched, and the assistant message's `tool_calls` (both calls) identical;
3. **the differing value is the shipped marker, byte for byte** — compared against
   `SAFE_MODE_ELISION_MARKER` imported from the built module;
4. **the parsed value shrank by exactly `elidedBytes − markerBytes`**: 1951 → 178 characters
   (delta 1773 = 1951 − 178), which is the number the pass itself recorded;
5. **the serialized body shrank by exactly the escaped difference**: 25,771 − 23,915 = 1856 bytes,
   equal to `escaped(removed) − escaped(marker)`. The raw delta is larger than the parsed delta because
   the removed text contains characters JSON escapes; the verifier asserts the escaped form explicitly
   rather than conflating the two, and the pass never sees a serialization;
6. **the elided text is still present in the same request**: the control body held **two** identical
   copies, the treatment holds **one** — the earlier copy is untouched, which is E3 + E4 on the wire;
7. **ineligible control is byte-identical** with apply on and off (22,015 = 22,015), with
   `attempted: true, applied: false` and no marker anywhere;
8. **unverified kind is byte-identical to the disabled control** (25,771 = 25,771) with
   `attempted: false` and `refused['request-kind-unverified'] = 1`;
9. **kind evidence**: `context` invocations = `model.request:primary` invocations = 2, and
   `title` = `model.request:title` = 1.

Reproduce all five runs and the checks (nothing outside `%TEMP%/dr-token-stage1t` is written, and the
capture server listens on loopback only):

```sh
cd integrations/opencode/scripts
node stage1t-setup.mjs                                  # disposable project + harness plugin
B="$LOCALAPPDATA/Temp/dr-token-stage1t"
run() { node stage1t-run.mjs --base "$B" --name "$1" --mode scripted --tool-calls 2 \
        --read-path "$2" --hooks all --elision "$3" --kind "$4"; }
run wire-disabled        fixtures/big-content.json   off   context-hook
run wire-eligible        fixtures/big-content.json   apply context-hook
run wire-ineligible-off  fixtures/small-content.json off   context-hook
run wire-ineligible-apply fixtures/small-content.json apply context-hook
run wire-kind-unverified fixtures/big-content.json   apply unknown
node stage1t-verify-wire.mjs                            # 13/13 PASS, exit 0
```

Summary of the mechanism, stated the way it should be quoted: **an eligible duplicate made the real
outbound request 1,856 bytes shorter, the elided duplicate is the only difference, the earlier copy is
still there, and the controls did not change by a byte.**

This is a **request-size** measurement. It is not a token measurement, and no saving is claimed: the
provider here is a local capture server and the content is synthetic.

---

## 7. Verification results

All run on the final tree, from the repository root:

| Command | Result |
| --- | --- |
| `npm run typecheck` | **PASS** — core build + 4 workspace test-config type-checks, no diagnostics |
| `npm run build` | **PASS** — core, benchmarks, Codex and OpenCode workspaces compile |
| `npm test` | **PASS** — **675 tests in 33 files** (core 19, benchmarks 120, Codex 83, OpenCode 453), exit 0 |
| `npm run verify` | **PASS** — typecheck + build + test chained |
| `npm run benchmark` | **PASS** — synthetic benchmark report regenerated, exit 0 |
| `node integrations/opencode/scripts/stage1t-verify-wire.mjs` | **PASS** — 13/13 wire checks, exit 0 (§6) |

New and extended tests for this stage:

| File | Coverage added |
| --- | --- |
| `tests/safe-mode-elision.test.ts` | **New module suite (31 tests).** Opt-in default and bypass, the 400-character threshold, marker identity and bounds, every refusal reason, all seven non-agent-loop payload shapes, marker collision, bounded scan, later-copy-only replacement with every other field byte-compared back, error/`json`/non-allowlisted/namespaced/provider-executed exclusion, malformed parts, frozen payload, a value changed between plan and write, a hostile accessor that forces `plan-mismatch`, privacy of the outcome, statelessness, and the analyzer's own count |
| `tests/safe-mode-observation.test.ts` | **Extended to 36 tests.** Apply through the real V2 adapter: only the later duplicate replaced, ordering/identifiers/relationships untouched, summary counters and notes, ineligible and observe-only controls, two applications of one request, two plugin instances, `apply` arming, `apply` while bypassed |
| `tests/source-guard.test.ts` | **Extended.** Exactly one `result['value']` assignment in the whole package, one call site for the pass (behind the apply switch and the observe gate), the module reads no environment and writes no file, and the Stage 1R probe stays unreachable from the product |

Earlier suites were not weakened: no assertion was relaxed and no test was removed.

---

## 8. Runtime-tested vs simulated

**Runtime-tested (this stage, zero cost):**

- the pass running inside a real 2.0.24 session, against a loopback provider;
- the request-size change reaching the real outbound body, with all controls;
- the kind → hook mapping: live hook counts and payload shapes (§3.3c), plus the binary dispatch site
  (§3.3b);
- hook registration succeeding for every candidate name, so a missing name cannot be mistaken for a
  quiet hook.

**Not runtime-tested:**

- compaction and generate requests were never produced live; their exclusion rests on §3.3b, not on an
  observed session;
- duplicate rates in ordinary work — M1 is for that and has not been run on real sessions;
- any effect on model behaviour or coding correctness (Stage 1U);
- any token effect (no token figure is derived anywhere).

**Synthetic-only:** every fixture, the scripted provider and the disposable project.

---

## 9. Files changed

| File | Change |
| --- | --- |
| `integrations/opencode/src/safe-mode-elision.ts` | **New.** The pass: gate, plan, guarded writes, content-free outcome |
| `integrations/opencode/src/observer.ts` | Apply setting, `#recordElisionOutcome`, the single `applySafeModeElision` call site after the M1 analysis, apply summary, two diagnostics |
| `integrations/opencode/src/types.ts` | `SafeModeSetting` (`'off' \| 'observe' \| 'apply'`), `SafeModeApplySummary`, diagnostics, notes |
| `integrations/opencode/src/types-v2.ts` | Updated note: the kind reaches apply mode through the hook name |
| `integrations/opencode/src/plugin-v2.ts` | Documentation of what the opt-in hook does in each mode |
| `integrations/opencode/src/index.ts` | Public exports for the pass and its types |
| `integrations/opencode/tests/safe-mode-elision.test.ts` | **New.** 31 module tests |
| `integrations/opencode/tests/safe-mode-observation.test.ts` | Adapter-boundary apply tests |
| `integrations/opencode/tests/source-guard.test.ts` | Single-writer and single-call-site guards |
| `integrations/opencode/scripts/stage1t-setup.mjs`, `stage1t-run.mjs`, `stage1t-verify-wire.mjs` | **New.** The isolated experiment: disposable project, real-runtime driver, wire verifier |
| `integrations/opencode/scripts/stage1r-capture-server.mjs` | `--tool-calls` (default 1) and per-call streamed `index`, so one assistant turn can request the same read twice |
| `docs/SAFE_MODE_1T_APPLY_VALIDATION.md` | **New.** This document |
| `docs/SAFE_MODE_M1_OBSERVATION.md`, `docs/SAFE_MODE_DESIGN.md`, `README.md` | Status, E8 and roadmap updates |
| `packages/core/src/types.ts`, `docs/OPENCODE_OBSERVER.md` | Roadmap wording: three harnesses (OpenCode, Codex, Freebuff) |

No product file outside `integrations/opencode` changed behaviour.

---

## 10. Limitations and what Stage 1T did not do

1. **Model behaviour is unvalidated.** The transformation is implemented and mechanically verified; its
   effect on a model's coding correctness has not been measured. That is Stage 1U's paired-task
   benchmark and it is a gate, not a metric.
2. **No real-work rates.** One synthetic duplicate in one experiment says nothing about how often
   ordinary sessions contain eligible duplicates, or how large they are.
3. **A compaction request was never observed live.** The exclusion is verified in the runtime's
   dispatch site and the live title evidence, not by producing a compaction.
4. **The 400-character threshold is deliberately conservative and untouched** (E6): duplicates below it
   are counted and refused, and the marker itself is far below it.
5. **No token measurement.** Character and byte counts are request properties; the benchmark framework
   still reports token metrics as *unavailable* rather than inventing them, and design §6.4's declared
   single-axis variant is still missing, so no `benchmark-verified` verdict is possible yet.
6. **Aggressive and Balanced modes were not started**, no new harness adapter was added, and no desktop
   UI, SQLite or model call was introduced. The pass is one allowlisted tool (`read`) with exact
   string equality; widening that is a later, separately-evidenced decision.
7. **Nothing was committed or pushed**; this stage ends before any real-world benchmarking.
