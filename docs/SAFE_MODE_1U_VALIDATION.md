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

Offline verification results (44 checks, all PASS — no model, no credential, no network):

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
| Outbound requests observed at the endpoint | 3 | 3 |
| Safe Mode markers at the endpoint | 0 | 1 |
| Mechanism verdict | `not-applicable` | `fired` |
| Pass counters | absent (pass off) | 1 assembly applied, 9 409 bytes replaced, 178 bytes of marker written |
| Task solved | no (scripted provider cannot code) | no — and the grader says so |
| Host-reported input/output tokens | 33 / 21 | 33 / 21 |

Two things this establishes and one it does not. It establishes that the pipeline works end to end
(plugin load, arm switch, apply firing, marker at the endpoint, summary capture, artifact intake,
grading, report). It establishes that the grader fails a non-solving arm instead of passing it. It does
**not** establish anything about token savings — the scripted provider's usage numbers are constants,
and the arms are not byte-comparable.

---

## 2. Automated regression protection: how to run it

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm run verify` | typecheck, build, all unit/integration tests including the Level 1 harness, the runtime-pin tests and the apply-summary tests | Node |
| `npm run verify:wire` | the Stage 1T wire experiment as a repeatable gate (pin, six real sessions, 19 checks) | the pinned OpenCode Desktop runtime |
| `npm run level2:verify` | the Level 2 apparatus, offline (44 checks) | Node |
| `npm run level2 -- --rehearse` | the Level 2 pipeline against a loopback scripted provider | the OpenCode CLI |
| `npm run verify:all` | `verify` + `verify:wire` + `level2:verify` | the pinned runtime |

None of these requires a paid model call. `verify:all` fails closed on a machine whose OpenCode runtime
is missing or not the pinned revision — which is the intended behaviour, not an inconvenience.

---

## 3. Gate results

| Command | Exit code | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | clean |
| `npm run build` | 0 | clean |
| `npm test` | 0 | 831 tests passing (19 core, 152 benchmark, 83 Codex, 577 OpenCode) |
| `npm run verify` | 0 | typecheck + build + test |
| `npm run benchmark` | 0 | synthetic fixtures, all correctness checks passed; no savings claimed |
| `npm run verify:wire` | 0 | 19 wire-regression checks passed, re-runnable, byte-identical repeat |
| `npm run level2:verify` | 0 | 44 Level 2 offline checks passed |
| `npm run level2 -- --rehearse` | 0 | plumbing verified; both arms honestly reported as not solving the task |

Test count against the Stage 1T baseline: 675 → **831** (+156: 103 Level 1, 16 runtime pin, 5 apply
summary, 32 Level 2).

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

---

## 6. Git status

No commit and no push were made in this stage (explicitly out of scope). See §7 of
[docs/SAFE_MODE_1T_APPLY_VALIDATION.md](SAFE_MODE_1T_APPLY_VALIDATION.md) for the working-tree
convention, and the stage report to the user for the exact `git status` output.
