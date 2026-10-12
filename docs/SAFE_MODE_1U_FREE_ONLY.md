# Stage 1U — the free-only model policy

**Scope.** The paired Level 2 experiment must stay inside an envelope that cannot spend money: approved
free models only, no auxiliary inference, no substitution, one configuration for both arms. This document
is the statement of that envelope, and of what the pinned runtime was measured to do with it.

**Status: implemented and verified offline; not verified by a live session.** Every claim below is either
a measurement of the pinned runtime (OpenCode Desktop `opencode-cli` 2.0.24, SHA-256 `37cafb7e…4d37fc`) or
a deterministic check in the standing gate. No live model call has been made under this policy, so no
statement about real-world token savings appears here.

**One implementation, two consumers.** `benchmarks/src/level2/free-model-policy.ts` is the only place that
decides what "free" means. The benchmark CLI and the arm driver
(`integrations/opencode/scripts/level2-arm.mjs`) both import it — the driver from the package's built
output, and it refuses to start if the import fails or if the module does not export the request-kind
vocabulary it needs. A second, drifting copy of this decision is how a paid model starts a session that
everything else believes is free.

---

## 1. The policy

| Question | Answer in code | Refusal when the answer is wrong |
| --- | --- | --- |
| Which models may a run name at all? | `FREE_ONLY_APPROVED_MODELS` — `opencode/mimo-v2.6-flash-free` (primary) and `opencode/muse-spark-1.3-contributor-free` (auxiliary, and the backup if the primary becomes unavailable) | `… is not one of the approved free models for this benchmark plan (…); changing the model set is a deliberate policy change, not a runtime detail` |
| Which provider? | `FREE_ONLY_PROVIDER` = `opencode`, expressed as a `provider.use` policy that denies **every** provider and allows only that one | the resolved-policy check refuses a policy that does not deny all others |
| What makes a model free? | Every applicable price tier the runtime reports — `input`, `output`, `cacheRead`, `cacheWrite` — is present and **exactly 0** (`FREE_ONLY_PRICE_FIELDS`, `isZeroPriceRow`) | the tier is named: `… is not free: the <runtime> runtime prices input=3, cacheWrite=3.75 (USD per million token(s)); every applicable tier must be zero` |
| A model the runtime lists but does not price? | not free — a row that does not exist cannot be zero | `the <runtime> runtime lists \`X\` but reports no price row for it, so no usage category can be shown to be free` |
| A model the runtime does not list? | not free | `the <runtime> runtime reported N model(s) and does not offer \`X\`, so its price cannot be verified` |
| A runtime with no catalogue at all (the no-account case)? | not free | `the <runtime> runtime reported no model catalogue at all, so nothing can be shown to be free (this is the missing-account case, not a model problem)` |
| No model named? | refused rather than defaulted | `no model was named, so the run cannot be attributed to an approved free model` |

A `-free` suffix is not evidence. The refusal cases in the tests deliberately use an identifier that
contains `free` and is not approved, and the positive cases use an identifier whose *price row* was read.

**When the policy refuses, the run is refused, not annotated.** The driver exits 2 before it spawns
anything (`Nothing was spawned, so this refusal costs nothing`), and an artifact whose policy block does
not re-derive to a verified free-only run is refused by the intake as `model-policy-unverified` rather
than compared.

---

## 2. The configuration both arms receive, and the measured effect of each key

`freeOnlyModelConfig()` builds one object. It has **no arm parameter and must never have one**: control and
treatment are separated by the Safe Mode switch alone, so a configuration that could differ per arm would
make every pair uncomparable. The driver writes it into the arm repository's `.opencode/opencode.json`
(merged with the containment policy) and records a digest of the exact bytes; the rehearsal asserts both
arms' digests are equal.

| Key written | Why | What the runtime was measured to resolve |
| --- | --- | --- |
| `model` | the free primary, so a session that is not told otherwise still resolves a free model | `model` in the runtime's `api config.get --standalone` document for this repository |
| `small_model` | the legacy key the runtime maps to `agents.title.model`, i.e. the model behind its auxiliary title request. Configuring it is what makes an auxiliary call that *does* happen free rather than merely unlikely | `agents.title.model` |
| `enabled_providers: ['opencode']` | the runtime turns this into a `provider.use` policy, so a paid provider cannot be substituted or fallen back to | `experimental.policies` containing `provider.use` **deny `*`** plus **allow `opencode`** |
| `compaction.auto: false` | automatic compaction composes a summarization request and would replace the very conversation the pass is measured on | `compaction.auto === false` |
| `autoupdate: false` | a runtime that updated itself mid-experiment would stop being the pinned revision | `update: "disable"` |
| `share: "disabled"` | no session content leaves the machine | `share: "disabled"` |

A written file is **not** evidence that a setting took effect: the runtime validates and normalizes what it
loads, and a key it does not recognize is *omitted* from what it reports rather than rejected. So a live
session is refused when the runtime's own answer for this repository is missing, drops the compaction key,
substitutes the primary or the auxiliary, adds a second allowed provider, or loses the deny-others rule
(`resolvedPolicyRefusals`). The rehearsal ran this check in **both** arms and both resolved the expected
five settings (`control=524ab65a5df6e4ef treatment=524ab65a5df6e4ef`, then the same for the resolved
reading).

**Unavoidable auxiliary calls are configured, not hoped for.** The title agent's model is the approved
auxiliary model, so if the runtime ever composes a title request it cannot reach an unpriced model. The
rehearsal additionally proves that no such request is composed at all (§3).

---

## 3. Auxiliary requests: how they are prevented, and how the absence is measured

### 3.1 Prevention

- **Automatic title generation is suppressed by supplying the title.** The driver passes `--title <a
  constant literal that is identical in both arms>` on the session command line. Measured: with no title
  supplied the runtime composes a title request (and, when the title call does not settle, a second one on
  the session model); with one supplied it composes none. The title never reaches a model, so the constant
  carries no experiment-specific content.
- **Automatic compaction is disabled** through `compaction.auto: false` (§2).
- **Provider restriction** means a request cannot be routed to a second provider even if a model is
  requested that only that provider has.
- **Both arms use the same literal and the same configuration**, so the suppression is part of the shared
  apparatus rather than an experimental difference.

### 3.2 Measurement — and why hook *registration* proves nothing

The request kinds come from the runtime's own hook, `model.request` (`MODEL_REQUEST_HOOK`). Stage 1T read
the runtime's single dispatch site out of the shipped binary and confirmed it live: `context` fires for
primary requests, `compaction`/`generate`/`title` for their own kinds, and `model.request` for **all** of
them with the request's `kind` inside its payload. The measured payload keys are
`agent, baseURL, headers, kind, model, sessionID`.

The trap this design exists to avoid, measured in Stage 1U: the runtime **accepts any hook name without
validating it** and then never calls one it does not dispatch. A probe that registers a synthetic
per-kind name (`model.request:title` and friends) registers cleanly, records nothing, and reads *exactly
like* a session that composed no auxiliary request. So:

- only the one real hook name is registered, and a check that requires "no title request" must also require
  the invocation count of the `primary` kind to be **above zero from that same hook** — otherwise a zero is
  a silence, not an absence;
- a payload whose kind is not one the runtime declares is recorded as `unclassified` rather than dropped,
  and `auxiliaryRequestKinds()` counts **every** kind other than `primary` as auxiliary, including a kind
  this harness has never heard of;
- the hook name is a policy constant read by the driver, the benchmark and the tests, so all three cannot
  disagree about which channel the claim rests on.

The loopback endpoint provides a second, independent reading: an agent-loop request declares a tool
registry and an auxiliary one does not. The endpoint's own capture therefore counts requests with and
without a registry, and the rehearsal requires the two readings to **agree** (hook `primary` count =
endpoint `withToolRegistry` count, `withoutToolRegistry` = 0). A disagreement is a finding, not something
to average away.

---

## 4. Evidence

All offline: no model call, no credential, no cost.

### 4.1 The zero-model rehearsal

```
npm run level2 -- --rehearse --task repeated-reads-catalogue      # exit 0, 24/24 checks
```

The scripted provider's capture for the latest run, both arms, verbatim in shape:

| Arm | Request | URL | `model` in the body | `tools` in the body | bytes |
| --- | --- | --- | --- | --- | --- |
| control | 1 | `/v1/chat/completions` | `mimo-v2.6-flash-free` | 9 | 16 398 |
| control | 2 | `/v1/chat/completions` | `mimo-v2.6-flash-free` | 9 | 37 300 |
| treatment | 1 | `/v1/chat/completions` | `mimo-v2.6-flash-free` | 9 | 16 402 |
| treatment | 2 | `/v1/chat/completions` | `mimo-v2.6-flash-free` | 9 | 27 379 |

Read out of that: no request without a tool registry (so no title, compaction or generate request), and no
request naming anything but the primary — in either arm. The hook side counted `primary=2` per arm with
`modelsNamed: {"opencode/mimo-v2.6-flash-free": 2}`, and the runtime's resolved policy named the primary,
the auxiliary, the provider deny-others rule and `compaction.auto: false`.

The arms' own configuration digests are equal (`524ab65a5df6e4ef…`); the only difference between the two
runs is `DR_TOKEN_SAFE_MODE=off|apply`, which is also what the rehearsal's own checks assert.

A rehearsal cannot check a price row — it holds no account and spends nothing — so it records
`catalogueSource: "not-checked"` **with the reason**, and a live run must show a verified zero row instead.
That asymmetry is itself checked in the gate.

### 4.2 The price gate, at the driver's process boundary

`benchmarks/tests/free-only-driver.test.ts` runs the real driver as a child process against a **stub
runtime** that answers its two read-only calls (`api config.get --standalone`, `api model.list
--standalone`) and refuses to run a session. Four measured cases:

| Catalogue the runtime reports for the approved model | Outcome |
| --- | --- |
| `input=3, output=15, cache read=0.3, cache write=3.75` | exit 2, `… is not free: the standalone runtime prices input=3 … cacheWrite=3.75 …`, `Nothing was spawned`; the runtime was asked only for `config.get` and `model.list` |
| the model listed with no price row | exit 2, `… reports no price row …`; no session requested |
| an empty catalogue | exit 2, `… reported no model catalogue at all …`; no session requested |
| all four tiers `0` (the control) | the **same** invocation walks past the gate and asks for the session — which is what makes the three refusals above a price decision rather than a blanket refusal |

The stub exists because no environment available offline reports a *paid* row for an approved model: the
installed runtime's private server has no catalogue without an account, and on the account that exists the
approved model's row is zero. The stub cannot reach a network, and the session it is asked for is refused
by the stub itself, so no inference is possible even if the gate regressed.

### 4.3 The standing gate

| Check | What it pins |
| --- | --- |
| `free-only:every-price-tier-must-be-explicitly-zero` | a zero row in all four tiers passes; a non-zero tier, an absent row, an unlisted model and a runtime with no catalogue are each refused by name |
| `free-only:the-approval-list-decides-before-the-price-does` | the primary and the backup are approved; any other identifier is refused even when its name contains `free`; a run that names no model is refused rather than defaulted |
| `free-only:the-configuration-is-one-object-for-both-arms` | one object, stable digest, and a substituted primary, substituted auxiliary, re-enabled compaction or a second allowed provider each fail the structural check |
| `free-only:the-runtime-must-confirm-every-setting-it-resolved` | every setting above, including the dropped-key case |
| `free-only:the-endpoint-names-the-model-in-its-own-spelling` | both spellings of an approved id pass; a substitution, a near-miss name, a foreign provider's same-named model, the auxiliary model standing in for the primary, and an absent identifier all fail |
| `free-only:every-request-kind-but-the-primary-one-counts-as-auxiliary` | every kind but `primary` counts as auxiliary, and the hook the counts come from is named in one place |
| `free-only:a-run-outside-the-policy-is-refused` | the positive control plus a substituted primary, an unapproved primary, a non-zero price row, an unsuppressed title call, a recorded pre-spawn refusal and a missing policy block |
| `free-only:an-auxiliary-request-refuses-the-run` | one composed title request refuses the run rather than being compared |
| `free-only:a-rehearsal-may-record-why-no-price-was-checked` | a rehearsal is accepted with its reason; the same artifact as a live run is refused |
| `free-only:a-reported-zero-cost-is-a-measurement-not-a-gap` | a free session reports cost `0` while its token fields stay reported, so the cap reads a value and does not stop the run |
| `engagement:missing-model-guard-evidence-is-refused` | a session whose artifact carries no pre-transmission model-guard block is refused rather than treated as bounded |
| `engagement:unregistered-model-guard-is-refused` | a guard that loaded but never registered its request hook is refused: the plugin having run is not the same fact as the runtime accepting the callback |
| `engagement:a-refused-model-request-is-refused` | a session in which the guard refused one request outside the envelope is refused as a measurement, even though nothing was sent |
| `model-guard:a-run-that-cannot-show-bounded-requests-is-refused` | a registered guard that refused nothing is accepted; a missing block, an unregistered hook, an unconfigured guard, a guard bounding a different policy digest and a session with one refusal are each refused as `model-guard-unverified` |
| `model-guard:registration-is-not-inferred-from-a-claim` | an artifact that asserts `guard: "loaded"` while recording `hookRegistered: false` is refused, so a driver cannot label an unregistered guard as armed |

---

## 5. The pre-transmission model guard

§1's policy restricts the **provider**; §4's gates refuse a *measurement* whose requests named the wrong model.
Both are necessary, and neither can stop a request: the allowed provider (`opencode`) offers free and paid
models alike, and a gate that refuses a measurement refuses it **after** the call. This section is the third
layer — the one that acts **before dispatch** — and the reason the free-only canary can be called free-only
rather than merely measured as such.

### 5.1 The mechanism, and where it operates

A separate plugin, `createModelGuardPluginV2` (`integrations/opencode/src/model-guard.ts`), registers exactly
one session hook and nothing else:

```
ctx.session.hook("model.request", (payload) => { … throw when the model is not approved … })
```

The layer is **`ctx.session.hook("model.request")`** — the same hook the request-kind counts come from — and it
operates inside the runtime's request assembly, *before* the provider request is built. Three facts make this
a supported mechanism rather than a trick, all recorded in
[OPENCODE_REQUEST_HOOK_VALIDATION.md](OPENCODE_REQUEST_HOOK_VALIDATION.md):

1. `model.request` is part of the **published** V2 session contract (`SessionHooks` in `@opencode/plugin@2.0.24`),
   and its payload carries the request's own `kind`, `model`, `baseURL` and `headers`.
2. The pinned `opencode-cli` 2.0.24 dispatches it at one site before any HTTP request:
   `U = yield* e.trigger("session", "model.request", { …l, baseURL, headers })`, and the returned object is what the
   runtime then uses for the route and the headers. There is no request before this point.
3. The hook dispatcher runs callbacks with **no `try`/`catch`**, so an exception propagates out of the dispatch
   site. That is the same property the vendor's own documented example relies on when it throws from
   `tool.execute.before` to block a tool — and the reason the observer's own rule has always been "never throw
   from a hook": a throw stops the operation it interrupts.

So a refusal here is a **thrown error**, exactly like the containment guard's refusal, and the operation it
interrupts is the model request.

### 5.2 What it refuses

| Request | Decision |
| --- | --- |
| `kind` is one of the runtime's declared kinds and the model is an approved id | allowed |
| the model is not an approved id (a paid model, another provider's model, an unknown id) | refused — `model-not-approved` |
| the model cannot be read out of the payload at all | refused — `model-unreadable` |
| `kind` is missing, or is not one of the runtime's declared kinds | refused — `request-kind-absent` / `request-kind-unsupported` |
| `kind` is `primary` but the model is the approved *auxiliary* | refused — `primary-model-substituted` |
| the guard was constructed without a usable envelope | every request refused — `not-configured` |

Two deliberate omissions, both stated rather than hidden:

- **No provider filter.** A registration filtered by `providerID` would make a request from an unnamed provider
  *skip the guard entirely* — the opposite of fail-closed — so no options are passed and every request is seen.
- **No rewrite.** A refusal does not substitute an approved model. Silently running a different model than the
  one the session asked for would produce a measurement describing neither model.

The guard emits content-free evidence (counts, request kinds, model **identifiers**, reasons) through a
caller-supplied sink and never writes a file of its own; the generated project-local guard does the file I/O,
so the shipped package keeps its rule that only its opt-in summary sink writes anything.

### 5.3 How it is made mandatory

A guard that is merely *available* proves nothing, so it is required at three seams:

1. **Before the session starts.** The arm driver imports the shipped module and refuses to spawn when it does
   not export `createModelGuardPluginV2` **and** `summarizeModelGuardEvidence`, when the policy module states no
   `modelGuardPolicy()` envelope, or when that envelope disagrees with *this* run's configuration (primary,
   approved pair, request-kind vocabulary or configuration digest). Refusals cost nothing because nothing has
   been spawned.
2. **In the artifact.** The driver records the guard's summarized evidence (`guard`, `hookRegistered`,
   `refused`, `policyDigest`) and the artifact intake refuses `model-guard-unverified` when the block is
   missing, the hook never registered, the envelope was absent, the digest is not this run's, or any request
   was refused.
3. **At the engagement gate.** `checkLiveEngagement` refuses a session with no model-guard evidence or an
   unregistered hook, and refuses as a measurement any session in which the guard refused a request — nothing
   was sent, but the session is no longer the free-only session the experiment declares.

### 5.4 Proof, at the endpoint rather than in the guard's own log

The enforcement is proven offline by `benchmarks/src/level2/model-guard-probe.ts`
(`benchmarks/tests/model-guard-probe.test.ts`, 10 tests): real pinned-runtime sessions against a loopback
scripted provider, **no credential and no model call**, with the **provider's own capture** as the observation.

| Case | What the endpoint received |
| --- | --- |
| approved primary, guarded | the approved primary's requests — so the guard refuses no legitimate work |
| approved auxiliary used for a `title` request, guarded | the approved auxiliary — the auxiliary is permitted *for an auxiliary kind* |
| an unapproved model of the **same provider**, guarded | **nothing at all** — the guard refused before dispatch |
| the **same model**, unguarded (the control) | the model arrives — proof the runtime would have sent it, so the guarded case's silence is the guard |
| an identifier no runtime knows, guarded | nothing, refused by **resolution** — reported as `runtime-refused-model`, distinct from a guard refusal |
| the approved primary with an unapproved **title** model, guarded | the primary's requests only; the title request was refused and the session continued |

The two facts that together establish enforcement are asserted as properties:
`unapprovedRefusedBeforeTransmission` (a registered guard, at least one refusal, **zero** endpoint requests) and
`unapprovedControlReachedEndpoint` (the unguarded control's capture is non-empty). Either alone proves nothing.
The guard's own record is never the observation: it says *what it decided*, and the probe reads the *capture*.

The endpoint proof uses `opencode/exo-free`, a same-provider model that is **not** approved but *is* zero-priced:
the strictly harder case, because the price gate could not have caught it and only the approval list can. The
same-provider **paid** identifier (`opencode/gpt-5.4-mini`) is covered at the decision and plugin seams by
`integrations/opencode/tests/model-guard.test.ts` (27 tests: refused for every request kind, and refused with a
throw at the plugin boundary) — the guard's decision is identifier-based, so a paid and a free unapproved id are
refused by the identical rule.

---

## 6. What this does not establish

1. **No live session has run under this policy.** The configuration, the request kinds and the refusals are
   measured offline; a canary must confirm the same on a real provider.
2. **The price row is the runtime's report, not an invoice.** `0` in all four tiers is the runtime's own
   answer for this model on this account. It is the strongest offline evidence available, and it is still a
   statement about what the runtime reports.
3. **The endpoint cannot name a provider.** The outbound body carries the model id without its provider
   (measured), so the body-level check is against a closed set of the approved ids in both spellings. A
   foreign provider's same-named model is caught by the hook reading and the resolved-policy check, and the
   set used here is asserted in the gate so it cannot widen silently.
4. **Kind classification is the runtime's vocabulary.** An auxiliary request composed on a channel the
   runtime does not report through `model.request` would not be counted. The endpoint's tool-registry
   reading is the cross-check that covers the shapes this runtime was measured to send.
5. **A rehearsal proves plumbing, not savings.** The scripted provider's usage numbers are constants; the
   byte reduction it shows (9 409 bytes replaced by a 178-byte marker) is a **size** fact and is never
   reported as tokens saved.
6. **The guard's coverage is the pinned runtime's dispatch path.** It bounds every request the pinned
   revision dispatches through `model.request`. A host that does not expose the hook is recorded as a missing
   capability, and the driver refuses to start a session whose guard cannot register — but a future runtime
   that dispatches a model request somewhere else would not be covered, which is why the revision is pinned
   and a different one is refused. The endpoint proof is a loopback provider, not a live one: a canary is what
   would confirm it on the wire the experiment will actually use.

---

## 7. Re-checking this offline

```
npm test                                                  # 1024 tests, incl. the free-only policy, driver,
                                                          # model-guard decision/plugin and probe suites
npm run level2:verify                                     # 78 offline checks, incl. the free-only and model-guard gates
npm run verify:wire                                       # 24 wire-regression checks
npm run level2 -- --rehearse --task repeated-reads-catalogue   # 28/28 checks, incl. the pre-transmission guard
npm run verify:all                                        # all of the above
```

The rehearsal writes its artifacts under `%LOCALAPPDATA%\Temp\dr-token-level2\repeated-reads-catalogue\
p0-<arm>\` (`provider-capture.jsonl` is the endpoint's own record, `artifacts/arm-observation.json`
carries the policy block, `artifacts/wire-kinds.jsonl` the hook counts).
