# Stage 1U — Safe Mode validation and benchmarking apparatus

**Scope.** Turn Stage 1T's one-off loopback wire experiment into a repeatable gate, build the Level 2
paired control/treatment coding benchmark the design requires (§6.3), verify everything that can be
verified without a model call, and stop at the authorization gate for live runs.

**Status: the required validation is *not* complete.** The wire regression, the deterministic Level 1
harness, the pinned-runtime check and the entire Level 2 apparatus are done and verified offline. The
live measurement — real coding tasks, real provider-reported tokens — has **not** been run, because it
requires the user's explicit authorization to spend model calls. No savings are claimed, and none can
be until that run happens.

Nothing in this stage expands the optimizer. The only shipped-code change is observational: the Safe
Mode **apply** counters are now reported per session in the session summary, which is what makes
per-run mechanism evidence possible at all.

---

## 1. What was verified, and how

### 1.1 Preflight

| Item | Result |
| --- | --- |
| Stage 1T committed | `56c8eb4 feat: implement OpenCode Safe Mode duplicate elision` |
| Branch | `main`, working tree clean at the start of the stage |
| Baseline suite | 675 tests passing (19 core, 120 benchmark, 83 Codex, 453 OpenCode) — unchanged and still passing |

### 1.2 The wire regression (`npm run verify:wire`)

Stage 1T's experiment, made repeatable. The script **pins the runtime first and fails closed**: the
installed OpenCode CLI's version, byte size and SHA-256 must all match the pin recorded in
`integrations/opencode/src/runtime-pin.ts` (2.0.24, 206 128 008 bytes,
`37cafb7e6f9f80ae3d198dc5a248d9b8c24fde58b96cf865f823c633cb4d37fc`). A missing, unreadable or different
runtime prints the reason and exits 1 **without running anything** — a stale conclusion reported as a
current one would be worse than no check.

It then drives six real sessions through the installed runtime against a loopback capture server
(no model call, no credential, nothing billable):

| Run | Purpose |
| --- | --- |
| `wire-disabled` | Control: pass off |
| `wire-eligible` | Treatment: eligible duplicate |
| `wire-eligible-repeat` | Repeated execution of the treatment |
| `wire-ineligible-off` | Control with content below the eligibility threshold |
| `wire-ineligible-apply` | Treatment with content below the threshold |
| `wire-kind-unverified` | Treatment with an unverified request-kind basis (fail-closed path) |

Judged properties (19 checks, all PASS):

- **Eligible duplicate removal with exact marker placement** — the marker appears exactly once in each
  treatment request (the marker-collision rule forbids more).
- **The earlier original result remains intact** — the retained copy is byte-identical; Stage 1T's own
  `stage1t-verify-wire.mjs` re-runs as part of the gate (13 checks).
- **No unrelated request modifications** — the treatment body is byte-identical to the control body
  except for the substituted text; the script re-verifies it.
- **Disabled path** — with the pass off the elision module is never invoked (no decision record) and
  the body is unchanged.
- **Observe-only path** — the pass records an outcome but applies nothing unless explicitly enabled.
- **Ineligible path** — below-threshold content is never elided, in either arm.
- **Failure path** — an unverified request-kind basis refuses (`request-kind-unverified`) instead of
  guessing; the earlier Stage 1T checks assert this.
- **Safe bypass and rollback** — the same refusal paths a bypass switch relies on; additionally
  `safe-mode-apply-summary.test.ts` asserts that switching Safe Mode off makes the request hook inert
  and leaves the payload byte-identical (see §1.4).
- **Repeated execution** — a second, independent execution of the treatment produces a
  **byte-identical** outbound request (23 915 bytes both times), so the pass neither drifts nor
  double-edits.
- **Locality** — every one of the 18 captured requests went to the loopback provider base path, and the
  isolated environment contains no provider credential, so no provider could have been contacted.

Measured in the gate: control request 25 771 bytes, treatment 23 915 bytes. That is a **request-size**
fact, not a token measurement.

### 1.3 The Level 1 deterministic harness (`npm test`)

Design §6.2's gate, implemented over recorded request shapes with no model: information preservation
checked by an *independent* re-walker (which does not trust the planner), byte-identical retained parts,
intact tool-call/tool-result pairing, marker integrity, refusal cases for non-allowlisted tools, error
results, below-threshold duplicates and marker collisions, determinism and idempotence, boundedness, and
a seeded fuzz property test over randomized part lists. 103 tests.

### 1.4 The shipped-code change: per-session apply counters

Design §6.3 requires mechanism evidence per run: the pass's own counters, so a shorter request can be
attributed to *this* pass rather than to an unrelated difference. The counters already existed on the
observer (`getSafeModeApplySummary()`), but they were **not** in the session summary and were aggregated
per plugin instance.

Stage 1U makes them per session and includes them in the summary
(`SessionObservationSummary.safeModeApply`, `integrations/opencode/src/observer.ts`). Reasons this is the
right change and not scope creep:

- a summary describes one session; instance-wide counters filed under a session id would attribute one
  session's elisions to another;
- the counters are **request-size facts** (bytes replaced, bytes written as markers, refusals by
  reason) and carry the pass's own stand-alone notes, so no number can be read as a token figure;
- it is observation only: it changes no eligibility rule, no marker, no request.

Five new tests (`tests/safe-mode-apply-summary.test.ts`) pin the behaviour: per-session attribution and
instance-wide summation, the default shape staying unchanged when apply was never requested, rollback
(switching apply off makes the request hook inert and leaves the payload byte-identical while the
counters remain reportable), and the disabled-observer diagnostic.

### 1.5 What the runtime does *not* allow (a finding, not a workaround)

Stage 1U measured that `session.hook("http.request")` hands the outbound body over as a
**`ReadableStream`**. A plugin therefore cannot measure the request it is about to send: there is no
length and no body text at that hook. Two consequences are now explicit in the code and the docs:

- the Level 2 probe records only that the hook fired and how many times, and the artifact states
  `hook-unmeasurable`;
- real wire lengths and marker counts exist only where a loopback endpoint is in the request path
  (the rehearsal, and the wire regression), so a live run against a real provider is classified
  `fired-counters-only` rather than `fired`.

The exact byte identity — treatment request shorter by exactly `elidedBytes - markerBytes` — remains
asserted where it *can* be asserted: the wire regression over one deterministic request that both arms
send identically.

### 1.6 The Level 2 apparatus (`npm run level2:verify`, offline)

Design §6.3, built on Stage 1S's declared-variant contract (not reimplemented):

| Piece | What it does |
| --- | --- |
| Frozen task pack | Six synthetic repositories: read-and-edit, debug-failing-test, multi-file-change, repeated-reads (designed to create an eligible duplicate), no-duplicate-opportunity, edge-case-fix. Fingerprinted. |
| Repositories | Content-derived revision identity; a fresh copy per arm run; harness directories excluded from snapshots. |
| Independent grading | Each repository's own `node --test`, run **after restoring the pristine test files**, so an agent cannot grade itself by editing tests. |
| Plan | ≥ 5 tasks, ≥ 3 pairs per task (≥ 15 pairs, ≥ 30 arm runs), ABBA order per task, plan validated before execution. |
| Arm driver | One session per arm in an isolated config/data home; both arms load the same shipped plugin; only `DR_TOKEN_SAFE_MODE` differs. |
| Mechanism | Counters from the session summary plus (where observable) marker counts at the endpoint; `fired` / `fired-counters-only` / `no-opportunity` / `unexplained` / `not-applicable`. |
| Records | Arm observations map to the framework's `BenchmarkRunRecord` with declared-variant provenance; `totalTokens` is always `unavailable`; per-field values stay separate. |
| Report | Per-task pass/fail for both arms, verdicts, mechanism classification, per-field delta distributions, and an explicit "what this does not establish" list. |

Offline verification results (73 checks, all PASS — no model, no credential, no network; the count is
re-measured after each pass, most recently in §1.11):

- **Grader integrity, per task:** the starting state fails; the correct solution passes; a plausible
  wrong solution fails; **replacing the graded tests with trivially passing ones still fails** (the
  pristine restore is asserted, and the restore is reported).
- **Reproducibility:** the same pack always yields the same revision identity.
- **Plan:** minimum samples met and ABBA alternation verified; a tampered plan is detected.
- **Contract:** a declared control/treatment pair is *comparable* (verdict `unavailable`, refusal is
  what would have happened without the Stage 1S declaration); a treatment run that fails its task is a
  `regression` with `correctnessRegression: true`; feeding the treatment run as the baseline is
  `invalid`; a different instruction hash is `invalid`; a run with no wire observation still compares
  and is labelled `fired-counters-only`.
- **Report:** per-field deltas computed for fired pairs and refused pairs contribute none; the report
  renders its mandatory sections and carries no request content.

### 1.7 The scripted rehearsal (`npm run level2 -- --rehearse`)

The whole Level 2 pipeline, driven through the **real** runtime against a loopback scripted provider —
no model call, no credential, no cost. It is a plumbing check and it reports exactly that:

| Observation | Control | Treatment |
| --- | --- | --- |
| Session ran, artifact written | yes | yes |
| Outbound requests observed at the endpoint | 2 | 2 |
| Request kinds the runtime itself reported | `primary=2`, no other kind | `primary=2`, no other kind |
| Model named on the wire | `mimo-v2.6-flash-free` | `mimo-v2.6-flash-free` |
| Safe Mode markers at the endpoint | 0 | 1 |
| Mechanism verdict | `not-applicable` | `fired` |
| Pass counters | absent (pass off) | 1 assembly applied, 9 409 bytes replaced, 178 bytes of marker written |
| Task solved | no (scripted provider cannot code) | no — and the grader says so |
| Host-reported input/output tokens | 22 / 14 | 22 / 14 |
| Free-only configuration digest | `524ab65a5df6e4ef…` | `524ab65a5df6e4ef…` (byte-identical) |

Two things this establishes and one it does not. It establishes that the pipeline works end to end
(plugin load, arm switch, apply firing, marker at the endpoint, summary capture, artifact intake,
grading, report). It establishes that the grader fails a non-solving arm instead of passing it. It does
**not** establish anything about token savings — the scripted provider's usage numbers are constants,
and the arms are not byte-comparable.

### 1.8 Containment enforcement at the real plugin boundary (the integrity pass)

Loading the guard is not enforcing it, and the guard's own log of itself is not an independent
observation. This pass therefore asks a **real session** — the pinned runtime, the real generated
project-local plugin, the real `execute.before` interception point, pointed at a loopback scripted
provider so no model is called — for the calls the policy must refuse:

| Call | Expected | Observed |
| --- | --- | --- |
| `read` an in-workspace file | allowed | content reached the provider (non-vacuity control) |
| `write` an in-workspace file | allowed | the file exists afterwards (second control) |
| `read` an absolute path outside the workspace | refused | refused, guard reason `path-outside-workspace` |
| `read` `../canary-one-level-up.txt` | refused | refused, guard reason `path-outside-workspace` |
| `bash` a command that would write a marker outside | refused | refused, guard reason `denied-tool`, marker absent |
| `write` outside the workspace | refused | refused, guard reason `path-outside-workspace`, file absent |
| `apply_patch` a file outside the workspace | refused | refused, guard reason `denied-tool`, file absent |
| `webfetch` a loopback URL | refused | refused, guard reason `denied-tool`, target never contacted (0 requests at the probe's own listener) |
| `task` (a nested agent) | refused | refused, guard reason `denied-tool` |

Every refusal is confirmed in three places, none of which is the guard's own report: the result the
runtime sent on to the provider carries the guard's refusal wording and no content, the effect the call
would have had did not happen on disk, and the canary text never left the workspace. Both arms produce
the same refusals, reasons and per-tool counts (7 refused, 2 allowed each). With the guard **deliberately
prevented from registering** — a plugin module that exports everything except the guard factory — the
session still completes and writes a whole artifact, and the benchmark's engagement gate refuses it
because `guard` is not `loaded`. A third case is the Stage 1V wiring fault itself: a governor whose
start **throws** stops the client before any request is composed (measured: 21 ms, zero sessions
observed), the artifact records the failure, and the new session-completion gate refuses the run as
`session-exit-nonzero` — before this pass that artifact would have been publishable. Evidence:
`benchmarks/tests/containment-probe.test.ts` (9 tests, three real sessions) and the rehearsal's own
per-arm probes.

This pass found and fixed two ways a run could be published without being a measurement:

- **A crashed, killed or timed-out session was publishable.** The driver exits 0 as soon as it has
  written a whole artifact — the right contract for a process — so a session the runtime killed or the
  wall clock stopped arrived looking complete, with counters describing a partial run. It is now refused
  by name (`session-exit-nonzero`, `session-timed-out`, `session-outcome-unrecorded`) before grading.
- **A rehearsal artifact could have been read as live evidence.** The declared mode must now match the
  mode the caller started (`mode-mismatch`).

One further defect was caught by the probe itself, on its first run: with the wrong argument key the
runtime's schema rejected the calls *before* they reached the guard, so the path-refusal half of the
probe was vacuous while looking green. The probe now records argument-schema failures explicitly and its
tests fail if any scripted call never reached a tool.

### 1.9 The two gaps this pass closed before the canary

The canary preflight left two items open; both are now measured and both are prepared with a refusal,
not a promise (`LEVEL2_CANARY_PREP.md` §6.3, §6.4).

**The native permission layer is an observation gap, not a configuration problem.** The guard's own
evidence reports `permissionRules: null` because the pinned runtime does not hand a plugin the rules it
resolved — there is nothing for the guard to record. The runtime's own resolver *does* report them: asked
read-only before any session (`api config.get --standalone`, in the runtime's canonical vocabulary:
`external_directory`, `shell`, `subagent`, `webfetch`), it returns all four denies for both arms, and a
controlled run with the policy removed leaked an out-of-workspace read. So the layer is configured and
effective; only its plugin-side reporting is missing. It is therefore required from two directions: a live
session is refused before it starts if the read fails or any deny is absent, and a run whose artifact
carries no resolved rules (or only some) is refused as a measurement. A configuration reading is never
substituted for an observed refusal — the guard layer stays mandatory and independently enforced (§1.8).

**The instruction the session is given was unfair, and is corrected.** Every task prompt used to instruct
the agent to run its own suite (`node --test`) — impossible in a session whose shell the policy denies, so
a failing outcome could not be attributed to the code. All six prompts now state that the session has no
shell tool and that the suite is run outside it against pristine copies. Grading was not touched: it is
still each repository's own `node --test` over restored pristine tests, identical for both arms. The
change is pinned by a new offline check, `tasks:prompts-fit-the-session-they-run-in`, which fails if any
prompt asks for a denied tool or drops the no-shell statement, and which carries a positive control (the
detector must fire on the wording the pack used to carry). The pack fingerprint changes accordingly — a
different instruction is a different experiment, and this one is the one being authorized.

**Read-only re-checks on 2026-10-12** (no session, no model call, nothing spent):

| Check | Result |
| --- | --- |
| Runtime revision | OpenCode Desktop 2.0.24 (`SHA-256 37cafb7e…4d37fc`) — the pinned revision, matched by the wire gate |
| Model availability | `opencode/gpt-5.4-mini` listed by the `service` runtime (42 models), status `active`, context 400,000 tokens; **not** offered by the isolated private server (0 models) |
| Catalogue price row (the runtime's own) | input $0.75/M, output $4.50/M, cache read $0.075/M, cache write $0 |
| Preflight verdict | `OK [ok] — the service runtime offers the requested model` |

### 1.10 The authorized canary attempt, and the control-flow fix it forced

A single-use authorization for exactly two sessions (one task, one pair, `opencode/gpt-5.4-mini`, service
runtime) was executed **once** on 2026-10-12. It produced no measurement, and the reason was not the
harness: the provider refused every request upstream (`Upstream request failed: Insufficient account
funds`). Both runs are published as `invalid-measurement` (`session-exit-nonzero`), no grading ran, neither
repository changed, and the accounting is 0 units / $0.0000 reported. The live path remains **unvalidated**.

What the attempt did establish is that the gates hold under a real refusal: the plugin layer engaged (3 and
2 requests reached the `http.request` hook, all addressed to the provider), the containment guard loaded
with a known workspace in both arms, the native permission layer resolved all four required denies in both
arms' artifacts, the in-session governor armed before either CLI was spawned, and both artifacts carried
their own nonce with `complete: true` and `mode: live` — and **nothing was published as a measurement**.

Two defects the attempt exposed, both now fixed offline:

- **The plan launched the treatment arm after the control arm had already failed.** The loop recorded the
  invalid measurement and continued. It now lives in `benchmarks/src/level2/sequence.ts` as a function over
  the plan with the per-run execution injected, whose rule is that the first fatal outcome — no observation,
  a refused model, a disengaged harness, or a cap — ends the plan; every unattempted run is published
  `not-run`. A coding failure and missing token fields deliberately do **not** stop it.
- **The run started on a working tree with uncommitted changes**, so its report could not name the revision
  it measured. Live mode now reads `git status --porcelain` from the checkout's root and exits 2 before
  spawning anything if it is dirty; an unreadable tree is refused the same way. The check is read-only and
  never stages, commits, stashes or deletes, and true ignores (including this harness's own reports) do not
  count. On this checkout that means live runs are refused until the Stage 1U work is committed.

The request counts also needed a precise reading: 3 hook invocations for the control arm and 2 for the
treatment, for sessions that received no response. Those are **composed requests**, not provider attempts,
not completed requests and not evidence of a retry — the artifact and the report now say exactly that
(`LEVEL2_CANARY_PREP.md` §6.7). No retry is inferred anywhere.

**Remaining blockers to any further live attempt** (neither is in the harness's gift): the provider account
must be funded, and the checkout must be clean. The preflight cannot see a balance; it now reports the
tree state before authorization rather than after.

### 1.11 The free-only model pass (2026-10-12)

The plan is a paired experiment on **genuinely free** models only, and a `-free` suffix is not evidence of
anything. The model set, the configuration both arms receive, the price gate, and the request-kind
evidence are now one implementation (`benchmarks/src/level2/free-model-policy.ts`) that the benchmark side
and the arm driver both import — a second copy of "what counts as free" is how a paid model starts a
session everyone believes is free.

| Decision | Where it is enforced |
| --- | --- |
| Which models may be used at all | `FREE_ONLY_APPROVED_MODELS` — `opencode/mimo-v2.6-flash-free` (primary) and `opencode/muse-spark-1.3-contributor-free` (auxiliary/backup). Anything else is refused by name, whatever its price row says. |
| Which configuration both arms receive | `freeOnlyModelConfig()` — one object, **no arm parameter**, so control and treatment cannot be configured differently by accident: `model` = primary, `small_model` = auxiliary, `enabled_providers: ['opencode']` (with every other provider denied), `compaction.auto: false`, `autoupdate: false`, `share: 'disabled'`. Its digest is recorded by both arms. |
| May the run spend anything | The runtime's own `model.list` price row, asked **before** the session is spawned, must be present and explicitly **0** in all four tiers (input, output, cache read, cache write). A model that is unlisted, a row that is missing, or any non-zero tier refuses the run with the tier named. |
| Did the runtime really apply it | The runtime's own `api config.get --standalone` answer for *this repository's document*, re-read from the artifact: a dropped compaction key, a substituted primary or auxiliary, an extra allowed provider, or a missing deny-others rule are each refused. |
| Did the runtime compose auxiliary work | The runtime's `model.request` hook, which carries the request's own `kind`; every kind but `primary` counts as auxiliary, **including a kind the harness has never heard of**, and any auxiliary request refuses the run. Automatic title generation is suppressed by supplying the session title on the command line (`--title`), so no title request is composed at all. |
| Did any request name a different model | The loopback endpoint's own capture of the outbound body, and the model identifiers the hook reported, each compared against the approved set for its own shape (the body names the model without its provider — measured). |
| Is a zero reported cost a gap? | No: a reported `0` is kept as a **value**, and the token fields stay reported beside it, so a free session is not mistaken for a session whose usage went unreported. |

The **response** to a failure is always the same: refuse before the session starts, and refuse the artifact
afterwards as `model-policy-unverified` rather than comparing it. Evidence, in two independent channels:

- **Rehearsal (`npm run level2 -- --rehearse --task repeated-reads-catalogue`, 24/24).** The scripted
  provider's own capture shows 2 requests per arm, every one to `/v1/chat/completions`, every one naming
  `mimo-v2.6-flash-free` and carrying the 9-tool agent registry — so no title, compaction or generate
  request was composed, and no substitution happened. The hook side independently counted
  `primary=2` per arm on `model.request` (payload keys `agent, baseURL, headers, kind, model, sessionID`),
  and the runtime's resolved policy named the primary, the auxiliary, the provider deny-others rule and
  `compaction.auto: false` in both arms. Both arms' configuration digests match
  (`524ab65a5df6e4ef…`), and the only experimental difference remains `DR_TOKEN_SAFE_MODE`.
- **The price gate, at the driver's process boundary (`tests/free-only-driver.test.ts`).** A stub runtime
  answers the two read-only calls: a non-zero row is refused with the tier named (`input=3 …
  cacheWrite=3.75`), a listed model with no row and an empty catalogue are refused, and — the control that
  keeps those refusals meaningful — a zero row in all four tiers lets the *same* invocation walk past the
  gate and ask for the session. No session is ever reached in the three refusal cases, and the stub cannot
  reach a network.

A full statement of the policy, the measured configuration keys and the limitations is in
[SAFE_MODE_1U_FREE_ONLY.md](SAFE_MODE_1U_FREE_ONLY.md).

### 1.12 The pre-transmission model guard (2026-10-12)

The free-only pass (§1.11) closed the *provider* and the *measurement*, but neither can stop a request: the
allowed provider offers free and paid models alike, and an evidence gate refuses a measurement **after** the
call. A paid model could therefore have been transmitted, and only then refused as a measurement. This pass adds
the layer that acts **before dispatch**, and proves it against the installed runtime rather than against the
guard's own log.

The mechanism is `ctx.session.hook("model.request")` — read out of the pinned `opencode-cli` 2.0.24, the
runtime dispatches it at one site before any HTTP request and runs the callback with **no `try`/`catch`**, so a
thrown refusal propagates out of the dispatch and the request is never built. It is the same "throw to block"
property the containment guard uses at `tool.execute.before`, applied to the model request.

| Piece | Where it lives |
| --- | --- |
| The guard | `integrations/opencode/src/model-guard.ts` — a pure, total decision (`evaluateModelRequest`) plus one registered hook |
| The envelope | `benchmarks/src/level2/free-model-policy.ts` → `modelGuardPolicy()`, the same module the price gate and the benchmark checks read |
| Mandatory before the session | the arm driver refuses to spawn unless the module exports the guard factory **and** the summarizer, and the envelope agrees with *this* run's configuration, pair, kinds and digest |
| Mandatory in the artifact | the driver records the summarized guard block; the intake refuses `model-guard-unverified` for a missing block, an unregistered hook, an absent envelope, a wrong digest or any refusal |
| Mandatory at the gate | `checkLiveEngagement` refuses a session with no guard evidence or an unregistered hook, and refuses any session in which the guard refused a request |

**Refuses:** every model that is not on the approval list (a paid model, another provider's, an unknown id),
a request whose model cannot be read, a request kind that is missing or outside the runtime's vocabulary, the
approved auxiliary standing in for the primary, and — when the guard was built without an envelope — every
request. **Never does:** filter by provider (which would let an unlisted provider skip the guard) or rewrite a
model (which would measure a model nobody asked for).

**The proof is the endpoint, not the guard.** `benchmarks/src/level2/model-guard-probe.ts` starts real pinned-runtime
sessions against a loopback scripted provider — no credential, no model call — and reads the **provider's own
capture**:

| Case | Endpoint received |
| --- | --- |
| unapproved same-provider model, **guarded** | **nothing** — the guard refused before dispatch (`unapprovedRefusedBeforeTransmission`) |
| the same model, **unguarded** (the control) | the model arrives (`unapprovedControlReachedEndpoint`) |
| approved primary / approved auxiliary on a `title` request | the approved requests — the guard refuses no legitimate work |
| unapproved **title** model mid-session, guarded | the primary's requests only; one request refused and the session continued |
| an unknown identifier, guarded | nothing, refused by resolution (`runtime-refused-model`) — distinguished from a guard refusal so a typo cannot read as enforcement |

The endpoint case uses `opencode/exo-free` — same provider, **not** approved, but zero-priced — because it is the
strictly harder case: the price gate could not catch it. The same-provider **paid** id (`opencode/gpt-5.4-mini`)
is covered at the decision and plugin seams (`integrations/opencode/tests/model-guard.test.ts`, 27 tests).

---

## 2. Automated regression protection: how to run it

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm run verify` | typecheck, build, all unit/integration tests including the Level 1 harness, the runtime-pin tests and the apply-summary tests | Node |
| `npm run verify:wire` | the Stage 1T wire experiment as a repeatable gate (pin, six real sessions, 24 checks) | the pinned OpenCode Desktop runtime |
| `npm run level2:verify` | the Level 2 apparatus, offline (78 checks, including the free-only model-policy gate and the model-guard gates) | Node |
| `npx vitest run tests/level2-sequence.test.ts --root benchmarks` | the live arm sequence's stopping rule, by fault injection with an injected executor — no runtime, no provider, no cost (7 tests) | Node |
| `npm run level2 -- --rehearse` | the Level 2 pipeline against a loopback scripted provider, including the per-arm containment enforcement probes, both arms' resolved native permission denies, the pre-transmission model guard in both arms, and the free-only request/model evidence (28 checks) | the OpenCode CLI |
| `npx vitest run tests/model-guard-probe.test.ts --root benchmarks` | pre-transmission enforcement at the endpoint: a guarded unapproved model reaches no endpoint and the unguarded control does (10 tests, six real scripted sessions; skipped when the runtime or the built plugin is absent) | the pinned runtime + built plugin |
| `npx vitest run tests/containment-probe.test.ts --root benchmarks` | containment enforcement at the real plugin boundary (9 tests, three real sessions; skipped when the runtime or the built plugin is absent) | the pinned runtime + built plugin |
| `npx vitest run tests/free-only-driver.test.ts --root benchmarks` | the free-only guard at the arm driver's own process boundary, including the pre-spawn price gate against a stubbed runtime (9 tests) | Node |
| `npm run verify:all` | `verify` + `verify:wire` + `level2:verify` | the pinned runtime |

None of these requires a paid model call. `verify:all` fails closed on a machine whose OpenCode runtime
is missing or not the pinned revision — which is the intended behaviour, not an inconvenience.

---

## 3. Gate results

Current results (the integrity pass, final run):

| Command | Exit code | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | clean |
| `npm run build` | 0 | clean |
| `npm test` | 0 | 1024 tests passing (19 codex, 284 benchmarks, 83 core, 638 opencode) |
| `npm run verify:all` | 0 | typecheck + build + test + wire gate + offline Level 2 gate |
| `npm run verify:wire` | 0 | 24 wire-regression checks passed, 0 failed |
| `npm run level2:verify` | 0 | 78 Level 2 offline checks passed, 0 failed |
| `npm run level2 -- --rehearse` | 0 | 28/28 checks: the pipeline, the governor's live initialisation path, the containment enforcement matrix in both arms, the **pre-transmission model guard registered in both arms with zero refusals and each arm's own configuration digest**, both arms' resolved native permission denies, the byte-identical free-only configuration and both arms' composed request kinds and model identifiers; both arms honestly reported as not solving the task |
| `npx vitest run tests/model-guard-probe.test.ts --root benchmarks` | 0 | 10 tests, six real scripted sessions: the guarded unapproved model reaches no endpoint and the unguarded control does; the approved primary and auxiliary reach it; a mid-session substitution is refused while the session continues; an unknown id is refused by resolution |
| `npx vitest run tests/containment-probe.test.ts --root benchmarks` | 0 | 9 tests, three real scripted sessions: every prohibited call refused at the real plugin boundary, the unregistered-guard session refused by the gate, the throwing governor stopped before a request is composed |

Earlier in the same stage, before the integrity pass, the same gates reported 918 tests, 24 wire checks and
51 Level 2 offline checks; the additions are the session-completion and run-mode gates, the containment
protocol checks, the containment enforcement test and the instruction-fit gate. The free-only pass (§1.11)
took the same gates to 982 tests, 73 Level 2 offline checks and 24 rehearsal checks; the model-guard pass
(§1.12) took them to **1024 tests, 78 Level 2 offline checks and 28 rehearsal checks**.

Test count against the Stage 1T baseline: 675 → **1024** (982 before the model-guard pass).

---

## 4. The authorization gate (where this stage stops)

Real coding benchmarks require real model calls. Before any are made, here is the exact request.

| Item | Value |
| --- | --- |
| Harness | OpenCode Desktop `opencode-cli` 2.0.24 (the pinned runtime above), driven by `integrations/opencode/scripts/level2-arm.mjs` |
| Provider | **OpenCode Console (Personal)** — the credential already stored on this machine (`opencode auth list` reports it; no value was read, printed or copied). The benchmark adds no credential of its own. |
| Model | **your choice**: `--model <provider>/<id>`, from the list the runtime reports (`opencode models`). Nothing is hard-coded, and the identifier is recorded in provenance. Small coding-capable models keep the cost down; a `-free` variant would make the run cost-free if its quota allows. |
| Usage reporting | host-reported per-field token usage through the observer's session summary (verified live in the rehearsal: input and output were captured for both arms). Whether the chosen model also reports the cache fields is unknown until it runs; unreported fields stay `unavailable`. |
| Planned runs | 36 arm runs minimum (6 tasks × 3 pairs × 2 arms) — the design's minimum for any conclusion. Each arm run is one full agent session in a fresh copy of a synthetic repository. |
| Extra runs | up to 6 retries for infrastructure failures (a retry is a fresh session, recorded as an attempt). |
| Volume ceiling | 42 sessions. Each session is a handful of turns over a repository of a few kilobytes; the rehearsal's requests were tens of kilobytes of JSON per turn and its reported usage was in the tens of tokens. The realistic whole-run volume is therefore in the low millions of input tokens at most, `--max-runs 42` refuses to start above it, and the unit caps stop the sequence if a session misbehaves. **Pricing is now readable from this machine** — the runtime's own `model.list` returns a price row per model, in USD per million tokens — so a dollar cap is enforced too; the figures for the pilot's model are in [LEVEL2_PILOT_PREP.md](LEVEL2_PILOT_PREP.md). |
| Cheaper first step | 6 sessions (one task, three pairs) to validate the live path end to end — about one sixth of the volume — before committing to the full run. |
| Expected duration | tens of minutes to a few hours depending on the model and provider latency. |

Guards that run **before** any session is started: `--live` without `--approve-live` refuses (exit 2); a run above `--max-runs` refuses; a plan below the design's minimum samples refuses unless it is an explicitly labelled pilot; and the runtime the run is told to use must report a model catalogue that lists the named model.

> **Correction (added while preparing the pilot — see
> [LEVEL2_PILOT_PREP.md](LEVEL2_PILOT_PREP.md)).** The guard described in this section originally
> asked the CLI for its model listing *without* `--standalone`, so it was answered by the developer's
> background service while the sessions themselves ran on an isolated private server. It could pass
> while every session failed, and the pilot that was attempted did exactly that: 6 sessions, all
> refused in about two seconds with `Model unavailable: opencode/gpt-5.4-mini`, zero model calls and
> zero cost. The guard now probes **both** runtimes read-only through `model.list` and refuses the
> selected one unless its catalogue lists the model; `--runtime service` selects the runtime that does.
> The pilot also has spending caps now (`--max-cost-usd`, `--max-cost-usd-per-run`, and a per-session
> unit cap), and a session that reports no cost stops the run instead of continuing unmeasured.
>
> The same correction applies to two claims made elsewhere in this stage. First, this platform does
> **not** ignore `XDG_CONFIG_HOME`/`XDG_DATA_HOME`: the wire gate now asks the runtime for its own
> directories with the overrides and without them, and the isolated answer resolves inside the harness's
> own directories (with the private server's database written there), while the unisolated control
> resolves to the user's home. The earlier "not honoured" reading came from asking the question without
> `--standalone` — the background service answered about the developer's installation — and from asking
> `debug paths --standalone`, a flag that subcommand does not accept. Both are fixed, and the check now
> carries its own negative control so it cannot pass vacuously again. Second, the wire gate repeats the
> loopback-locality predicate nowhere: it asserts the request volume each session must produce instead,
> so a run that never composed its calls fails rather than passing quietly.

**Nothing will be executed without an explicit approval that names the model.** The commands are:

```sh
# pilot: one task, three pairs (6 sessions) — caps and runtime as prepared in LEVEL2_PILOT_PREP.md
npm run level2 -- --live --approve-live --model <provider>/<model> --runtime service \
  --pairs 3 --task <task-id> --max-runs 6 --timeout-ms 600000 \
  --max-units-per-run 1500000 --max-units 6000000 \
  --max-cost-usd-per-run 0.50 --max-cost-usd 2.00

# the whole experiment: six tasks, three pairs each (36 sessions, 42 with retries)
npm run level2 -- --live --approve-live --model <provider>/<model> --runtime service --max-runs 42
```

A rehearsal can be repeated at any time at zero cost, and the offline verification covers everything
that does not need a model.

### Note on the guards (added during this stage)

While checking the refusal paths, one `--live` invocation was started without the approval above and
with a model identifier the runtime does not offer. The sessions were killed after 1 ms, produced no
session summary and no captured request, and the identifier resolves to no provider, so nothing was
sent and nothing was billed. It should not have been started. The model-listing guard described above
was added in response: the same command now refuses before creating a directory or spawning a session.

---

## 5. Blockers and limitations

1. **Live measurement not performed** — the objective's items 3 (real coding correctness benchmarks)
   and 5 (measurement) are prepared and verified offline but not executed. Stage 1U is **not complete**
   until that run happens.
2. **No wire observation in live mode** — the runtime hands the outbound body to the hook as a
   `ReadableStream`. Live runs are therefore classified `fired-counters-only`; the exact byte identity
   is only asserted in the deterministic wire regression. A length-measuring loopback proxy in front of
   a real provider would close this gap and is deliberately *not* built here (untestable without
   provider access, and unnecessary for the correctness question).
3. **No session token total exists** — the host publishes none and its fields overlap, so
   `totalTokens` stays `unavailable` and the generic comparison verdict for a Level 2 pair is
   `unavailable` rather than `benchmark-verified`. Per-field deltas are reported separately.
4. **One pair per task is a plumbing check, not a result** — the rehearsal deliberately runs one pair;
   any live conclusion requires the design's minimum of three pairs per task over five tasks.
5. **The runtime pin covers one revision** — all wire evidence is evidence about OpenCode Desktop
   2.0.24 as installed here; a different revision refuses rather than extrapolating.
6. **Retry semantics** — a live run may need a retry for an infrastructure failure; retries are new
   sessions recorded as attempts, so an aborted session never becomes a datapoint.
7. **Containment is tool-layer, not an OS sandbox** — the guard and the runtime's permission policy act
   inside the tool pipeline. Nothing here stops a process the runtime started outside that pipeline, and
   nothing here is a container. The enforcement evidence covers the pinned revision only.
8. **The enforcement probe exercises the calls it scripts** — one call shape per channel, with the
   argument keys this pinned runtime declares. It cannot enumerate every argument a real model might
   invent; a call for an unlisted tool or an unreadable argument is refused by the same fail-closed
   rules the unit tests pin, but the model-facing variety is not something an offline probe exhausts.
9. **No session has run against a real model in this pass** — every result above is offline. What the
   canary must still establish is stated in §1.7 and in `LEVEL2_CANARY_PREP.md` §7.
10. **The one authorized canary produced no measurement** — both sessions were refused upstream for
    insufficient account funds (§1.10), so the live path is still unvalidated and no token, byte or
    correctness figure exists for it. Two blockers stand between here and another attempt: a funded
    provider account, and a clean checkout (which live mode now requires and this one is not).
11. **The free-only price row is verified for the model, not by a live session** — the four zero tiers of
    `opencode/mimo-v2.6-flash-free` were read from this installation's own `model.list` (1 452 completed
    steps at a reported $0.00), and the *refusal* path is exercised at the driver's boundary against a
    stubbed runtime, because no environment available offline reports a paid row for an approved model.
    What a live canary must still confirm is that a real session on this model reports cost 0 with its
    token fields present, and composes no auxiliary request against the real provider.
12. **The endpoint's model spelling is provider-less** — the runtime's outbound body names the model
    without its provider (measured: `mimo-v2.6-flash-free`), so the endpoint check compares against a
    closed set that contains both spellings of the approved ids only. A provider-qualified substitution
    (`anthropic/mimo-v2.6-flash-free`) is therefore caught by the *hook* reading and the resolved-policy
    check rather than by the body, and that division is asserted in the standing gate.
11. **The stopping rule is proven offline, not live.** The sequence tests inject the arm outcomes; a real
    fatal outcome mid-plan has not been observed since the fix, because that would need a live session.
13. **The pre-transmission guard is proven on a loopback endpoint and the pinned revision.** The
    model-guard probe shows an unapproved model reached no endpoint while the guard was loaded and did reach
    one without it, but it observes the *installed* runtime (2.0.24) and a *scripted* provider. It cannot prove
    what a future runtime that dispatches a model request through some other path would do, and it is not a
    live wire. The guard covers requests the pinned revision routes through `model.request`; a host that does
    not expose the hook is recorded as a missing capability and refuses the run rather than assuming coverage.

---

## 6. Git status

No commit and no push were made by this pass. The tree carries the Stage 1U work: on this checkout the
earlier fixes arrived as the commit `b5fb14e` ("fix: harden benchmark safety and measurement integrity"),
and this pass's changes are uncommitted working-tree edits. The free-only pass added four files
(`benchmarks/src/level2/free-model-policy.ts`, `benchmarks/tests/free-model-policy.test.ts`,
`benchmarks/tests/free-only-driver.test.ts`, `docs/SAFE_MODE_1U_FREE_ONLY.md`) on top of the integrity
pass's five (`containment-probe.ts`, `scripted-provider.ts`, `sequence.ts`, and their two test files), and
modified `benchmarks/src/level2/*`, the arm driver `integrations/opencode/scripts/level2-arm.mjs`, the
scripted capture server, and the documents that describe the gates. The exact `git status` is in the stage
report to the user. That the tree is dirty is now a **live-mode
blocker rather than a footnote**: live runs refuse to start on an uncommitted checkout (§1.10). See §7 of
[docs/SAFE_MODE_1T_APPLY_VALIDATION.md](SAFE_MODE_1T_APPLY_VALIDATION.md) for the working-tree
convention, and the stage report to the user for the exact `git status` output.
