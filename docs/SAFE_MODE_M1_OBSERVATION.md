# Safe Mode M1 — observation-only opportunity measurement (Stage 1Q)

**Status (2026-10-11): implemented and verified — observation only.** The OpenCode V2 adapter now
contains an opt-in analyzer that measures how often an assembled model request contains **exact
duplicate tool-result content** the Stage 1O Safe Mode strategy could elide, and how large those
duplicates are. **Nothing is modified, in any mode**: the analyzer reads a request and returns counts,
the hook has no return-value channel, and with the opt-in off the adapter's registered surface is
exactly what it was before.

**Runtime this targets:** `opencode v2.0.24` (the Desktop app's bundled CLI), whose request-assembly
hook was runtime-verified in Stage 1P.
**Analyzer:** `integrations/opencode/src/opportunity.ts` (pure, exported).
**Integration:** `OpenCodeObserver.observeRequestContext` + the V2 adapter's opt-in
`session.hook("context")` registration.
**Tests:** 56 new (27 analyzer + 29 adapter-boundary); `npm test` = **exit 0, 544 tests** (19 core,
70 benchmark, 83 Codex, 372 OpenCode).
**Verdicts:** `npm run typecheck` / `build` / `verify` / `benchmark` = **exit 0**; benchmark = 16
correctness checks passed, 8 `unavailable` verdicts, **no savings claims**.
**Related:** [docs/SAFE_MODE_DESIGN.md](SAFE_MODE_DESIGN.md) ·
[docs/OPENCODE_REQUEST_HOOK_VALIDATION.md](OPENCODE_REQUEST_HOOK_VALIDATION.md) ·
[docs/adr/0003-safe-mode-strategy.md](adr/0003-safe-mode-strategy.md) ·
[docs/OPENCODE_OBSERVER.md](OPENCODE_OBSERVER.md)

> **Headline.** M1 is the measurement half of the Safe Mode design: it builds a content-free
> opportunity record from `session.hook("context")` and folds it into the observer's per-session
> summary. Its duplicate rule is **actual string equality between two `tool-result` parts of the same
> tool**, with the earlier copy necessarily still present in the same request — never a hash
> comparison, never a similarity score, never a cache. Replaying the recorded Stage 1P evidence
> through the analyzer reproduces every recorded count (1 duplicate group, 1 later copy, 135
> characters) and adds the eligibility classification the probe did not have: **the one live
> duplicate Stage 1P observed (135 characters) is below the design's 400-character threshold, so M1
> records it as a detected but ineligible duplicate — zero would-elide characters.** No token
> savings are measured, estimated or implied.

---

## 1. What M1 is, and what it is not

| Is | Is not |
| --- | --- |
| A deterministic, bounded, read-only analysis of one assembled request | A transformation — no request, tool result, instruction, permission or model setting is ever modified |
| A detector of exact duplicate tool-result text with a presence proof | A cache: it keeps no state between requests, sessions or processes |
| A measurement of duplicate **characters/bytes** in requests | A token measurement or a savings claim |
| Opt-in (`DR_TOKEN_SAFE_MODE=observe` or `safeMode: "observe"`) | A default behaviour: unset keeps the previous surface exactly |

## 2. Architecture

Three pieces, all observation-only:

1. **`opportunity.ts`** — a pure function, `analyseRequestOpportunities(context, limits)`. It walks
   `system` and `messages`, extracts the model-visible text of `tool-result` parts, compares text by
   string equality, and returns counters (`RequestOpportunityAnalysis`). It assigns to nothing it is
   given, retains nothing after it returns, and returns `undefined` for a payload that is not
   request-shaped.
2. **`OpenCodeObserver.observeRequestContext`** — the hook entry point. It contains every failure,
   resolves the session from the payload's `sessionID`, applies the existing project-scope gate
   (`#dropIfInactive` / the session's declared project), folds the analysis into the session's
   counters, and marks the session dirty for the existing checkpoint machinery. `DR_TOKEN_OPENCODE_OBSERVER=off`
   and the `enabled: false` option suppress it exactly like every other observation.
3. **The V2 adapter** (`plugin-v2.ts`) — registers `ctx.session.hook("context")` **only when
   `observer.isSafeModeObserving()`**. With the opt-in off, `ctx.session` is never read and the
   registered surface is the two tool hooks plus the event subscription, unchanged.

Opt-in semantics:

| Setting | Effect |
| --- | --- |
| unset / `off` | Safe Mode off; no session hook registered |
| `observe` | Observation enabled; the request hook is registered |
| `apply` | **Reported** (`safe-mode-apply-unavailable`) and downgraded to `observe`: apply is part of the design, is not implemented in this revision, and observation is the only Safe Mode behaviour that exists and it modifies nothing |
| anything else | **Reported** (`safe-mode-setting-ignored`); Safe Mode stays off |

## 3. Eligibility rules (design §4.2, mapped)

The design's conditions are evaluated where they are observable at this hook. "Eligible" means
*would-elide if the strategy ran here*, given only what the assembled payload can prove.

| # | Condition | In M1 |
| --- | --- | --- |
| E1 | The prepared request is exposed and parts map 1:1 to tool identity | Integration capability: registration only happens when `ctx.session.hook` exists; a missing capability is recorded (`unsupported-plugin-capability`), never approximated |
| E2 | Both parts are tool results of the **same** tool, and that tool is on the read-only allowlist (`read`) | Group identity = exact `name` + `namespace`; eligibility additionally requires `name === "read"` **and no namespace** (a namespaced tool is never treated as the built-in read) |
| E3 | Byte-identical text | Direct JavaScript string equality (the exact text is the map key). No hashing is used in the comparison path |
| E4 | The retained copy appears earlier and is still present | Structural: groups are computed within one request and nothing is removed, so the earlier copy is present by construction. Only **later** copies are ever called occurrences |
| E5 | Both results are completed | The request-level signal is `result.type`; `error` results are excluded and never compared |
| E6 | Duplicate length ≥ `minElidableChars` (400) | `minEligibleCharacters` (default 400, configurable via `opportunityLimits`); shorter duplicates are still **detected** and counted, then refused as `below-minimum-characters` |
| E7 | No part already contains the marker prefix | Scanned over compared tool-result texts, `text`/`reasoning` part texts and `system` parts; on a collision **every** would-be elision in that request is refused (`marker-collision`) |
| E8 | The request kind is `primary` | **Not observable at this hook**: the published `SessionContext` that `session.hook("context")` delivers has no `kind` member (the kind lives on the model-call hooks). M1 does not guess; eligibility is *content-level*, the summary notes say so, and the primary-only gate remains an apply-time requirement |
| E9 | The scan stays inside its work budget | Bounded scan (§5); when a bound is hit the request is marked `bounded` and all would-be elisions in it are refused (`scan-bounded`), fail-closed about transforming |

Additional v1 scope decisions, all recorded rather than approximated:

- Only `result.type === "text"` with a **string** `value` is compared. `json` and `content` results
  are contract-supported but their exact model-visible rendering is decided by the host's
  serialization, which this hook cannot read — so they are excluded as `result-type-unsupported`
  rather than guessed at. A `text` result whose value is not a string is `result-malformed`.
- `providerExecuted: true` parts are refused (`provider-executed`): their results may carry
  provider-side state.
- A text longer than the per-result bound is excluded (`payload-too-large`), **never truncated**:
  two truncated strings could compare equal while the full texts differ.

## 4. Measurement semantics

Recorded on the **session summary** as an optional `safeMode` section (present only while observation
is on; a default installation's summary shape is unchanged).

| Field | Meaning |
| --- | --- |
| `requestsObserved` | One `context` invocation = one counted **request assembly**. Retries re-invoke the hook and are counted again; two plugin instances observing the same request each count it. These are **not deduplicated request identities**, and the notes say so |
| `requestsUnusable` | An attributed request whose payload was not analysable; counted, never guessed into an all-zero reading |
| `requestsWithoutDuplicates` | Analysed requests that contained no duplicate occurrence (the design's `no-opportunity` case) |
| `requestsWithMarkerCollision` / `requestsBounded` | Request-level refusals (E7 / E9) |
| `messagesExamined`, `partsExamined`, `toolResultPartsExamined`, `comparedToolResultParts` | Scan counters; `partsExamined` counts message content parts **and** system parts |
| `duplicateGroups`, `duplicateOccurrences` | Detected exact duplicates: distinct groups, and later copies (`sum(count - 1)`) |
| `eligibleGroups`, `eligibleOccurrences` | Detected duplicates that pass every payload-visible rule |
| `duplicateCharacters` / `duplicateBytes` | Size of **all detected** occurrences — the measurement of duplicate volume |
| `candidateCharacters` / `candidateBytes` | Size of the **eligible** subset — the would-elide candidates |
| `excludedParts` | Parts that could not be compared, by stable reason (`tool-identity-missing`, `result-malformed`, `result-error`, `result-type-unsupported`, `payload-too-large`, `scan-bounded`) |
| `refusedOccurrences` | Detected occurrences refused, by stable reason (`tool-not-allowlisted`, `provider-executed`, `below-minimum-characters`, `marker-collision`, `scan-bounded`) |
| `minimumEligibleCharacters` | The effective E6 threshold, so refusal counts can be interpreted |
| `notes` | Static, content-free caveats |

**Units and the honest distinction.** `…Characters` are JavaScript string lengths (UTF-16 code
units), the same measure Stage 1P's `elidableChars` used; `…Bytes` are UTF-8 byte lengths. Both are
properties of the assembled request. **Neither is a token count, and no token figure is derived from
them** — "candidate characters" is not "saved tokens", and the summary's notes state it.

**Invariant:** `duplicateOccurrences = eligibleOccurrences + Σ refusedOccurrences`, asserted by both
the unit and adapter-boundary suites.

## 5. Bounds (strict processing and memory limits)

| Bound | Default | On overflow |
| --- | --- | --- |
| `maxMessages` | 4 000 | Scan stops; request marked `bounded` |
| `maxPartsPerMessage` | 500 | Scan stops at the bound (message parts and system parts alike); request marked `bounded` |
| `maxToolResultParts` | 500 | Scan stops; request marked `bounded` |
| `maxCharactersPerToolResult` | 1 000 000 | The part is excluded (`payload-too-large`); the request continues |
| `maxCharactersPerRequest` | 4 000 000 | Scan stops; the part is excluded (`scan-bounded`); request marked `bounded` |
| `minEligibleCharacters` | 400 | Duplicates are still detected; occurrences refused (`below-minimum-characters`) |

`bounded` is fail-closed about transforming: **every** would-be elision in a bounded request is
refused (`scan-bounded`), because E9 is one of the design's conjunctive conditions. Overridable per
instance via the `opportunityLimits` option; there is no unbounded mode and no persistence.

## 6. Privacy, bypass and failure posture

- **Counts only.** No tool text, prompt text, path, session content or digest of content leaves the
  analyzer; the summaries are written by the existing JSON Lines sink, unchanged. A canary sweep
  (synthetic tool content, prompt text and a path) asserts none of it appears in any written summary.
- **No new write path.** Nothing is persisted by M1 itself; it rides the existing opt-in summary sink
  and checkpoint machinery.
- **Bypass precedence unchanged.** `DR_TOKEN_OPENCODE_OBSERVER=off` / `enabled: false` suppress the
  request hook exactly like every other observation; Safe Mode `off` means the hook is never
  registered at all.
- **Fail-open.** The hook body is wrapped twice (observer + adapter); a payload that is not
  request-shaped is counted as unusable instead of fabricated; one part with a throwing accessor is
  excluded without losing the request or raising an internal error; a missing session domain is
  reported as an unsupported capability and the rest of the adapter keeps working.
- **Read-only by construction.** The V2 hook contract has no return-value channel (callbacks return
  `Promise<void> | void`), the analyzer only reads, and a deep-frozen request delivered through the
  real adapter is byte-identical afterwards.

## 7. Evidence

### 7.1 Automated tests (56 new; all 544 pass)

- **`tests/opportunity.test.ts` (27).** Exact duplicates (including three-way), UTF-16/UTF-8 unit
  accounting, near-duplicates (trailing whitespace, case, tab, NFC vs NFD), cross-tool text,
  allowlist / namespace / provider-executed refusals, error and unsupported result types, malformed
  results, oversized payloads, throwing accessors, marker collisions in tool results, text,
  reasoning and system parts, every bound, not-request-shaped payloads, the occurrence invariant,
  determinism, frozen-input purity and stable reason keys.
- **`tests/safe-mode-observation.test.ts` (29).** Through the **real V2 adapter boundary** (the
  strict fake host drives `setup` and the hooks exactly as V2 does): opt-in via env and plugin
  option, `apply` downgrade, invalid-setting reporting, missing session domain, a 135-character
  duplicate mirroring the Stage 1P evidence (detected, below threshold), an above-threshold eligible
  candidate, a configured threshold end-to-end, retries counted as separate assemblies, multiple
  sessions isolated, multiple instances not deduplicated, determinism across instances, no-opportunity
  requests, frozen-request immutability, throwing accessor containment, unusable and unattributable
  requests, observer bypass, project-scope refusal, deleted-session refusal, and the privacy sweep.

### 7.2 Offline validation against the Stage 1P evidence

The authorized Stage 1P run's evidence file (`runB.jsonl`, the only live request content ever
observed) records: `messages: 5`, `systemParts: 4`, `partTypes {text:2, reasoning:1, tool-call:2,
tool-result:2}`, `toolResults: 2`, `duplicateGroups: 1`, `duplicateLaterParts: 1`,
`elidableChars: 135`. The evidence file deliberately contains **no request content**, so the
validation reconstructs a request with the recorded structure and duplicate size (all character
counts are structural; the strings themselves are synthetic stand-ins) and replays the built
analyzer against it:

| Check | Result |
| --- | --- |
| `messagesExamined` = recorded `messages` | PASS (5) |
| `toolResultParts` = recorded `toolResults` | PASS (2) |
| `comparedToolResultParts` | PASS (2) |
| `duplicateGroups` = recorded `duplicateGroups` | PASS (1) |
| `duplicateOccurrences` = recorded `duplicateLaterParts` | PASS (1) |
| `duplicateCharacters`/`duplicateBytes` = recorded `elidableChars` | PASS (135 / 135) |
| `partsExamined` = 7 message parts + 4 system parts | PASS (11) |
| Eligibility (new in 1Q): 135 < 400 → `eligibleOccurrences` | PASS (0, refused `below-minimum-characters`) |
| Occurrence invariant | PASS |
| The two earlier (non-duplicate) records reproduced | PASS |

**Finding worth recording:** the single live duplicate Stage 1P observed would **not** be elided by
v1's default threshold. M1 records it as a detected duplicate with zero eligible characters — the
kind of honest distinction the measurement exists to produce.

### 7.3 Stage 1Q verification runs

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | **0** | core build + all four workspaces type-check |
| `npm run build` | **0** | all four workspaces compile |
| `npm test` | **0** | **544 passed** (19 core, 70 benchmark, 83 Codex, 372 OpenCode) |
| `npm run verify` | **0** | typecheck + build + tests (same 544) |
| `npm run benchmark` | **0** | 8 fixtures, 16 correctness checks passed, 8 `unavailable` verdicts, no savings claims |

## 8. Runtime-tested vs simulated

- **Runtime-verified (Stage 1P).** Delivery, timing and payload completeness of
  `session.hook("context")` on OpenCode 2.0.24, including one live byte-identical duplicate pair.
  M1 registers the same hook name and consumes the same payload shape.
- **Not re-run in Stage 1Q.** No model call and no OpenCode run happened for this stage. The
  adapter-boundary tests are deterministic synthetic deliveries through the real adapter code, and
  the offline validation replays recorded evidence — so M1's *counting semantics* are verified
  off-runtime, while the measurement of duplicates in **real work** is exactly what M1 is for and has
  not been collected yet.
- **Unverified at this hook.** E8 (request kind): the `context` payload carries no `kind`; the
  primary-only gate is enforced where the kind is observable (a future apply mode).

## 9. Files changed

| File | Change |
| --- | --- |
| `integrations/opencode/src/opportunity.ts` | **New.** Pure M1 analyzer, limits, reason types |
| `integrations/opencode/src/observer.ts` | Opt-in setting resolution, `observeRequestContext`, per-session counters, `safeMode` summary section |
| `integrations/opencode/src/types.ts` | `SAFE_MODE_ENV_VAR`, `SafeModeMode`, `SafeModeOpportunitySummary`, three diagnostics, notes, options |
| `integrations/opencode/src/types-v2.ts` | Verified `session.hook("context")` contract mirror, digest + verbatim excerpts, `ctx.session` |
| `integrations/opencode/src/plugin-v2.ts` | Opt-in `session.hook("context")` registration, doubly contained |
| `integrations/opencode/src/index.ts` | Public exports for the analyzer and its types |
| `integrations/opencode/tests/opportunity.test.ts` | **New.** 27 analyzer tests |
| `integrations/opencode/tests/safe-mode-observation.test.ts` | **New.** 29 adapter-boundary tests |
| `integrations/opencode/tests/v2-host.ts` | Session-domain support for the fake host |
| `docs/SAFE_MODE_M1_OBSERVATION.md` | **New.** This document |
| `docs/SAFE_MODE_DESIGN.md`, `README.md` | Status links |

## 10. Limitations and the next gates

1. **E8 (request kind) remains unobservable at this hook.** Apply mode must enforce it where the
   kind is observable; M1 records content-level eligibility and says so.
2. **The wire baseline is deliberately deferred.** The design's M1 gate mentions measuring the true
   sent size; the stage brief scoped 1Q to opportunity measurement, and a length-only body
   measurement is a separate privacy decision that belongs with M2's mechanism check.
3. **No real-work rates yet.** M1 must be run against ordinary sessions (opt-in) before anything is
   optimised; one synthetic case says nothing about rates.
4. **The comparison contract still needs the declared single-axis variant** (design §6.4) before any
   `benchmark-verified` verdict is possible.
5. **M2 is not implemented and not prepared here.** No mutation exists; whether the runtime honours a
   mutated `SessionContext` remains unverified and is M2's wire-check question.
