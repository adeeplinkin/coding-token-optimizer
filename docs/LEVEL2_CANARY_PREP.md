# Level 2 canary — prepared, not authorized

**Scope.** This document prepares a **two-session canary** on `opencode/gpt-5.4-mini`: one task
(`repeated-reads-catalogue`), **one pair**, both arms (control then treatment). It exists to verify the
**live path** — that a real session starts on this installation, that the shipped plugin is loaded by the
repository the harness provisions, that a session summary reaches the harness, and that the paired
comparison runs — before the 6-session pilot is authorized.

It authorizes nothing. No live session has been run. Everything below is either a read-only measurement
(`model.list`, `config.get`, `debug paths`, `debug agents`, help output) or a **zero-cost run against a
loopback scripted provider** (`--rehearse`), plus the existing offline verification.

**Status: ready to authorize, with the limitations in §7 read first.** The one thing the canary cannot
tell you in advance is whether a *service-mode* session loads the repository-local plugin — that is
exactly what its first session measures, and §7 says what happens if it does not.

**Since the last review, both requested safeguards are implemented, tested and rerun:** containment is now
enforced in two layers (the runtime's own explicit permission denies plus a guard plugin that refuses every
call that leaves the session workspace, both evidenced by the session itself — §4), and the per-session
spending cap is now a real *in-session* stop on the service runtime (the runtime's own `session.interrupt`,
driven by the cost the runtime reports — §2, §3).

**The authorized Stage 1V canary then ran, and it failed — usefully.** The arm driver crashed before any
session started (the built module exports `startCostGovernor`, but the driver's helper pick list omitted it,
so the governor could not arm), and the harness published a previous run's artifact as that canary's
measurement. No model call was made and nothing was spent. Both defects are now fixed and covered by tests,
and the guarantees they were missing are stated in §9. No live session has completed, and none is authorized
by this document.

---

## 1. Model access and arm equivalence

> **Correction (2026-10-12, free-only pass — see §6.8).** The model this document was written around,
> `opencode/gpt-5.4-mini`, is a **paid** model, and the plan is now free-only: the primary is
> `opencode/mimo-v2.6-flash-free`, with `opencode/muse-spark-1.3-contributor-free` as the auxiliary and the
> backup. Everything in §1 about arm equivalence and configuration isolation still holds — the free-only
> configuration is itself byte-identical between the arms and its digest is recorded — but the model rows in
> the probes and in the §8 request below are superseded for any run authorized under the free-only policy.
> The paid figures are kept because they are measurements of this installation, not because they are the
> plan.

### The runtime that can run it

| Probe (read-only, zero cost) | Private server (`--standalone`) | Background service |
| --- | --- | --- |
| `api model.list` catalogue | **0 models** | **42 models** |
| `opencode/gpt-5.4-mini` listed | no | **yes** |
| price row (USD per million) | — | input **0.75**, output **4.50**, cache read **0.075**, cache write **0** |
| model status / limits | — | `active`, context 400,000 |

The canary therefore uses `--runtime service`, as §3 of the pilot preparation already established. A
standalone session cannot resolve any model on this installation.

### Both arms use the same configuration except the declared switch

Verified from a real two-arm rehearsal (both arms ran a session through the installed CLI against a
loopback provider):

| Input | Control | Treatment | Same? |
| --- | --- | --- | --- |
| Runtime invocation | `run --standalone --auto --model <id>` | `run --standalone --auto --model <id>` | **identical** |
| Observer plugin source file | one file | one file | **byte-identical** |
| Wire-probe plugin file | writes to the control artifact dir | writes to the treatment artifact dir | differs **only** in the artifact path it reports into (instrumentation, not experiment) |
| Containment guard plugin file | one file | one file | **byte-identical** apart from the evidence path it reports into (instrumentation, not experiment) |
| Containment permission policy (`.opencode/opencode.json`) | one document | one document | **byte-identical**; the SHA-256 is recorded in both artifacts |
| Model, runtime mode, timeout, caps, workspace layout | | | identical (one command, one set of options) |
| Task files and instruction | provisioned from the same frozen pack, one prompt file | | byte-identical on both sides |
| **Safe Mode setting** | `off` | `apply` | **the one difference** |

The rehearsal runs on the private server, so its invocation carries `--standalone`; the live canary runs on
`service` and carries no such flag. That is one flag, identical on both sides of the pair, and it is the
same in both arms of the live run — so the equivalence argument above transfers unchanged.

The observation confirms the switch reached the plugin rather than being assumed: the control arm
recorded `apply: null`, the treatment arm recorded `apply: { requestsAttempted, requestsApplied,
elidedOccurrences, elidedBytes, markerBytes }`. Independently, the declared-variant contract refuses a
pair whose arms disagree about the model, the repository revision, the harness or the mode.

### Nothing else in the developer's configuration can reach either arm

Measured (read-only fingerprint, not a claim): the developer's configuration home
(`~/.config/opencode`) holds `opencode.jsonc` (28 bytes) and `service.json` (64 bytes) and **no file
mentions Dr. Token**, so no global plugin install can set Safe Mode on the control arm. The service's own
`config.get` reports the same two configuration sources for both arms.

---

## 2. What can stop spending, and when — enforceable vs circuit breakers

This is the distinction the harness must not blur, so it is now printed before every live run and
repeated in `--preflight`:

**A live capped session whose governor cannot arm is now refused, not recorded.** The arming decision happens
*before* any model process is spawned (`planGovernorArming` in the shipped package): if the helpers are
missing, the driver exits 2 and no session starts. The run's own artifact is then checked against that
decision — a capped service session whose governor is not armed is refused as invalid by the harness rather
than compared (§9).

**Enforceable inside a session — three mechanisms, in order of how unconditional they are**

- **The wall-clock kill.** The arm driver arms a timer for `--timeout-ms` and terminates the CLI process
  when it fires (`integrations/opencode/scripts/level2-arm.mjs`). This is an OS-level stop and needs
  nothing from the runtime. The same value bounds the grading command. It is the one stop that always
  applies.
- **The native session interrupt, driven by reported cost.** On the service runtime the driver runs a
  supervisor whose loop lives in the shipped package (`startCostGovernor`). It polls the observer summary
  every 1.5 s, reads the cumulative cost the runtime reports through `session.usage.updated`, and calls
  the runtime's own `session.interrupt` through the CLI as soon as the per-session cap is crossed. The
  overshoot is therefore bounded by the spend of the steps that complete between a poll and the interrupt
  landing — *not* by the cap, and no longer by the whole session. If the interrupt does not confirm twice,
  the driver kills the client process instead and records that (`killedAfterFailedInterrupt`).
- **The runtime's own agent step limit.** The containment configuration sets `agent.build.steps` and
  `agent.general.steps` to 20, which the runtime's config schema accepts and its resolved config carries
  (measured: `config.get` returns the `agents` block). The canary records the requests each session
  actually made (`wire.hookInvocations`), so the limit's effect is observed rather than assumed; its exact
  enforcement semantics are not established offline, so it is reported as a configured bound, never as a
  proven one.

**Post-session circuit breakers — the four caps**

- `--max-units-per-run`, `--max-units`, `--max-cost-usd-per-run`, `--max-cost-usd` are evaluated **after
  each session** and stop the run **before the next session starts**. A cap can therefore be exceeded by
  at most the single session that tripped it. They cannot stop a session in flight.

**What was checked, and what it showed**

| Candidate in-session control | Result |
| --- | --- |
| A CLI flag for requests, tokens or cost | **None.** `opencode run --help` lists `--model`, `--agent`, `--format`, `--file`, `--title`, `--thinking`, `--auto`, `--standalone`, `--session`, `--continue`, `--fork` — no limit of any kind. |
| A plugin hook that can abort a session | **None.** Every V2 hook callback returns `Promise<void> | void`; the only signal channel (`event.subscribe({ signal })`) aborts the plugin's own subscription, not the session. The shipped plugin is observation-only plus one versioned elision pass (ADR 0003), and it cannot stop a run. |
| A native per-agent step limit | **Now configured.** `ConfigAgent.Info.steps` is accepted by the runtime's config schema (measured: the resolved config carries `agents.build.steps`), and the containment configuration sets it to 20 for both arms. Offline observation cannot prove how the runtime enforces it, so the artifacts record it as configured and report the request count actually made. |
| A server operation that interrupts a session | **Implemented, wired, and probed offline.** `session.interrupt` is declared in the shipped `@opencode/protocol@2.0.24`; the governor calls it via `opencode api session.interrupt --param sessionID=…`. Probe against the real installation: a session created on the private server (`api session.create --standalone`, cost 0, no model call) was interrupted and returned the documented `{"interrupted":false}` — the operation is callable and its shape is as declared. What only a live session can confirm is interrupting a *running* generation (`{"interrupted":true}`); the canary records whichever outcome occurs. |
| An account- or plan-level budget | **Not observable.** The runtime's API surface has no balance, quota or credit endpoint, so a limit enforced by the Console (if any) cannot be read or relied on from here. |

**Consequence, stated plainly:** with the governor armed, a session's overshoot past the per-session cap
is bounded by the steps that complete in one poll window (1.5 s) plus the interrupt's latency; if the
runtime reports no cost at all, the governor has nothing to act on and the post-session tracker fails
closed on that rather than continuing with an invisible bound. The caps still bound the *sequence*, and
the wall-clock kill remains the unconditional per-session stop.

---

## 3. The numbers

| Quantity | Expected | Higher but plausible | Enforced cap |
| --- | --- | --- | --- |
| Model requests per session | 2–10 (the loopback rehearsal produced **3** per arm) | 30 | **20**, the runtime's own agent step limit in the containment config — observed as `wire.hookInvocations`; enforcement semantics unverified offline |
| Output tokens per session | a few thousand | 30,000 | **none in session**; the model's own per-request ceiling is 128,000 tokens (runtime catalogue) |
| Session wall clock | seconds | ~1 minute | **5 minutes**, then the CLI is killed (enforceable) |
| Conservative units per session (all reported fields added) | 0.25M | 2M | **1.5M** (checked after the session) |
| Reported cost per session | $0.05–$0.12 | $0.30 | **$0.50**, enforced in-session by the native session interrupt on the reported cost, and checked after the session |
| Two sessions, units | 0.5M | 4M | **3M** |
| Two sessions, reported cost | $0.10–$0.25 | $0.60 | **$1.00** |

**Hard bound on reported spend: $1.50** — the $1.00 total cap plus at most the overshoot of the one
session that trips the $0.50 per-session cap *if the in-session governor could not act* (an unreported
cost, or an interrupt the runtime would not confirm). With the governor armed and cost reported, the
realistic worst case is the cap plus the spend of one 1.5-second poll window. Units are an accounting
bound only: every reported token field added together, never reported as usage.

**What is enforceable, and what is only an estimate.** Enforceable on this machine: the wall-clock kill
(5 minutes per session, unconditional), the in-session interrupt on the cost the runtime reports, the
pre-spawn refusals (a session whose governor cannot arm, or whose runtime does not resolve the containment
denies, never starts) and the post-session unit/cost breakers that stop the *next* session. Not enforceable:
the provider's own accounting. There is no balance or quota endpoint in this runtime's API surface (see the
cost notes below), the per-request prefix is not measurable before a session runs, and list prices are an
estimate of what a session costs rather than a contract about what the account is charged. **$1.50 is
therefore the most this harness can stop at, not a cash ceiling** — nothing in this repository caps the
provider's own books.

Basis: the runtime's own price row (§1), and this machine's own recorded history — 23 sessions, median
$0.0698 per paid session. The largest recorded session was $1.74, on a **different provider and price
list**, so it is a shape reference, not a forecast.

**Cost that cannot be reliably bounded, named:**

1. **The request prefix.** The system instruction, tool schemas, environment notes and accumulated history
   the runtime re-sends on every request are not measurable before a session runs. So the per-session
   token figure is an estimate and the cap is the bound.
2. **Settlement.** No balance or quota endpoint exists in the runtime's API surface, so the dollar figure
   is the *reported* cost at list prices. Whether the account settles that in cash, credits or a plan quota
   cannot be read from this machine.
3. **An unreported cost stops the run.** A session that reports no cost ends the plan (`cost-unreported`)
   rather than continuing against a bound it can no longer see. A reported `0` is a value, not a gap.

---

## 4. Why a task cannot touch the developer's projects or configuration

**The harness's own writes.** Audited in `benchmarks/src/level2/repos.ts`,
`benchmarks/src/level2/runner.ts` and `integrations/opencode/scripts/level2-arm.mjs`: every path the
harness creates is under the workspace root (`%LOCALAPPDATA%\Temp\dr-token-level2` by default, or
`--workspace <dir>`) — the fresh repository copy for each arm, the prompt file, the artifact directory, the
per-arm isolated config and data homes, and the provider capture file. Grading restores the pristine
graded files from the task pack before running the repository's tests, so an agent that edits the tests
gains nothing.

**Measured, not asserted.** A full two-arm rehearsal (two real sessions through the installed CLI) left the
developer's configuration home byte-for-byte unchanged — same files, sizes and mtimes before and after —
and added nothing to the working tree.

**Containment, in two enforced layers (added since the last review).** In service mode the session runs on
the developer's own runtime, so `--auto` was never a containment argument; the harness now writes an
explicit policy and a guard, and refuses to count a session that cannot show both:

1. **The runtime's own permission policy.** Each arm's repository carries a byte-identical
   `.opencode/opencode.json` (SHA-256 recorded in both artifacts) that denies `external_directory`, the
   shell (`bash`), the subagent tool (`task`) and `webfetch`. The CLI's own help says `--auto`
   auto-approves only permissions that are **not explicitly denied** — so these denies survive `--auto` by
   construction. The runtime's own resolver is now **asked, before any session starts**
   (`api config.get --standalone`), and both arms' artifacts record what it resolved; a live session is
   refused if any required deny is absent, because half-observed containment is not containment (§6.3).
2. **A guard plugin that refuses the calls no path check can make safe.** The same guard file is loaded by
   both arms (byte-identical apart from its evidence path). It refuses the shell/subagent/fetcher/patch
   tools outright, refuses any call whose declared path resolves outside the session workspace (`..`,
   absolute paths, sibling directories, UNC/device/`~` targets, unreadable path arguments, shell-like
   `command`/`cmd`/`script` arguments under any tool name), and is fail-closed: a call it cannot classify
   is refused, not allowed. A refusal is a thrown error, which the host's tool pipeline turns into a
   failed tool call — measured: the session continued and exited 0. A host that cannot register the hook,
   or a session whose workspace the host never declared, is recorded as unguarded and the arm is
   **refused as a measurement** by `checkLiveEngagement`.

**Measured end to end, not argued.** The rehearsal now runs a containment probe through the installed
runtime: the scripted provider is pointed at a file **outside** the session's repository copy, and a
canary token in it must never appear in the provider's own capture of what it received; a control run
reads a file *inside* the repository and its text must appear (without that half, a session that never
read anything would look contained). Result (2026-10-11, `npm run level2 -- --rehearse`): the
in-workspace read reached the provider, the out-of-workspace read was refused by the guard
(`path-outside-workspace`, 1 recorded refusal) and its token never reached the provider, the session
exited normally, and both arms recorded `guard: loaded` with `rootKnown: true`.

**The residual risk, stated rather than hidden.** Containment is enforced at the *coding agent's tool
layer*, which is every mutation channel the agent has — but it is not an OS sandbox. A runtime defect
outside the tool pipeline, or a process the runtime starts on its own, is not covered; that needs
AppContainer/low-integrity execution or an equivalent, and is the documented next step if the pilot needs
the shell tool. **The canary denies the shell** (an arbitrary command has no argument a path check can
trust, and the enforcement probe observes that call refused). The prompts were corrected accordingly:
they no longer instruct a session to run a command it cannot run, and they say so instead (§6.4). The
denial is identical in both arms, grading is unchanged and independent, and the canary's coding outcomes
remain a plumbing result rather than a fidelity statement about shell-enabled task solving.

---

## 5. The exact command to authorize

```sh
npm run level2 -- --live --approve-live \
  --model opencode/gpt-5.4-mini \
  --runtime service \
  --task repeated-reads-catalogue --pairs 1 \
  --max-runs 2 --timeout-ms 300000 \
  --max-units-per-run 1500000 --max-units 3000000 \
  --max-cost-usd-per-run 0.50 --max-cost-usd 1.00
```

Equivalent, and usable without npm:

```sh
node benchmarks/dist/level2/cli.js --live --approve-live \
  --model opencode/gpt-5.4-mini --runtime service \
  --task repeated-reads-catalogue --pairs 1 \
  --max-runs 2 --timeout-ms 300000 --max-units-per-run 1500000 --max-units 3000000 \
  --max-cost-usd-per-run 0.50 --max-cost-usd 1.00
```

> The root `level2` script needed a trailing `--` to forward arguments: without it npm consumed the flags
> and the CLI received only their values (`Unknown argument "repeated-reads-catalogue"`). Fixed and
> verified on 2026-10-11 with `npm run level2 -- --plan --task repeated-reads-catalogue --pairs 1`, which
> now reaches the CLI with its flags intact. With no extra arguments the script still runs the default
> offline verification.

What it does, in order: (1) evaluates every refusal before starting anything (approval, model named, CLI
present, plan within `--max-runs`, one per-session and one total cap in force); (2) probes the runtime
read-only and refuses to start unless `service` lists the model; (3) prints the bounds line, which states
what is enforced in-session (the native interrupt governor on reported spend, and the wall-clock kill) and
what is only checked after each session (the unit and cumulative caps); (4) runs **two**
sessions — `repeated-reads-catalogue` pair 0, control first, then treatment — each in a fresh copy of the
repository; (5) grades each session against pristine tests; (6) checks that each session actually engaged
the harness (§6); (7) stops before the next session if a cap is broken, or immediately if the runtime
refuses the model; (8) writes `benchmarks/reports/level2/level2-live-<timestamp>.md` and `.json`.

Preview it first, at zero cost:

```sh
npm run level2 -- --preflight --task repeated-reads-catalogue --pairs 1 \
  --model opencode/gpt-5.4-mini --runtime service \
  --max-runs 2 --timeout-ms 300000 --max-units-per-run 1500000 --max-units 3000000 \
  --max-cost-usd-per-run 0.50 --max-cost-usd 1.00
```

---

## 6. The zero-cost checks that must pass before authorizing

| Check | Command | Result (2026-10-12, after the control-flow fix) |
| --- | --- | --- |
| Whole repository | `npm run verify:all` | **exit 0** — typecheck, build, **1024 tests passed** (638 opencode + 284 benchmarks + 83 core + 19 codex), wire-regression gate **24 checks / 0 failures**, Level 2 offline **78 checks / 0 failures** |
| Stop-on-first-failure (fault injection, offline) | `npx vitest run tests/level2-sequence.test.ts --root benchmarks` | **7 tests PASS** — a run with no measurement, a refused model, a disengaged harness and a broken cap each stop the plan with one launch; the failed run keeps its disposition, the rest are `not-run`, and a coding failure or missing token fields do **not** stop it |
| Clean-tree prerequisite | read-only guard call on this checkout | **REFUSED** — `27 uncommitted change(s)` (re-read after the free-only pass; the count is whatever the tree holds when the guard runs), no session would start (§6.6); the clean-tree case is the control |
| Live path plumbing + every safeguard (real sessions, loopback provider, no model) | `npm run level2 -- --rehearse --task repeated-reads-catalogue` | **PASS (28/28)** — both arms ran a session, 2 requests each, control `not-applicable`, treatment `fired` (9,409 bytes elided, 1 marker at the loopback endpoint); both arms **armed the in-session governor** (the live initialisation path) and produced an **accepted artifact** (this run's own nonce, complete, and a session that exited 0); both arms' **containment probes** (§6.1) refused every prohibited call with no trace and enforced identically; both arms' **pre-transmission model guards** registered their request hook with 0 refusals, each bounded to its own configuration digest (§6.9); both arms' artifacts carry the runtime's **own resolved permission denies** (`4 rule(s), missing [none]`, §6.3); and both arms received the **byte-identical free-only model configuration** (`524ab65a5df6e4ef…`) whose **composed requests are all `primary`**, naming only the approved primary model (§6.8) |
| The free-only price gate, at the driver's boundary | `npx vitest run tests/free-only-driver.test.ts --root benchmarks` | **PASS (11/11)** — a non-zero price row, a listed model with no row and an empty catalogue are each refused before a session is asked for, while an all-zero row lets the same invocation through (the control), against a stub runtime (§6.8); and the driver refuses to start when the plugin module cannot supply the pre-transmission guard |
| Pre-transmission model guard, at the endpoint | `npx vitest run tests/model-guard-probe.test.ts --root benchmarks` | **PASS (10/10)** — real scripted sessions read through the provider's own capture: the guarded unapproved model reached no endpoint, the unguarded control did, the approved models did, a mid-session substitution was refused while the session continued (§6.9) |
| Containment enforcement against the installed runtime | `npx vitest run tests/containment-probe.test.ts --root benchmarks` | **PASS (9/9)** — one real scripted session per case, checked against the provider's own capture and the filesystem (§6.1) |
| The instruction a session can obey | inside `level2:verify` | **PASS** — `tasks:prompts-fit-the-session-they-run-in`: no prompt asks for a denied tool, each states the no-shell condition, and the detector fires on the wording the pack used to carry (§6.4) |
| Model availability | `--preflight` above | **OK** on `service`; 42 models; the requested model listed and **active**, context 400,000 tokens, priced at input **$0.75**/M, output **$4.50**/M, cache read $0.075/M, cache write $0 |

### 6.1 Containment enforcement, proven rather than reported

Loading the guard is not enforcing it, and the guard's own log of itself is not an independent
observation. The harness therefore asks a real session — the real runtime, the real generated
project-local plugin, the real `execute.before` interception point — for the calls the policy must
refuse, using a loopback scripted provider so no model is called. Each arm's rehearsal probe and the
standalone enforcement test ask for the same matrix:

| Call | Expected | Observed |
| --- | --- | --- |
| `read` an in-workspace file | allowed | content reached the provider (the non-vacuity control) |
| `write` an in-workspace file | allowed | the file exists afterwards (the second control) |
| `read` an absolute path outside the workspace | refused | refused, guard reason `path-outside-workspace`, path never sent |
| `read` `../canary-one-level-up.txt` (traversal) | refused | refused, guard reason `path-outside-workspace` |
| `bash` a command that would write a marker outside | refused | refused, guard reason `denied-tool`, marker absent |
| `write` outside the workspace | refused | refused, guard reason `path-outside-workspace`, file absent |
| `apply_patch` a file outside the workspace | refused | refused, guard reason `denied-tool`, file absent |
| `webfetch` a loopback URL | refused | refused, guard reason `denied-tool`, the target was never asked (the probe's own listener recorded zero requests) |
| `task` (a nested agent) | refused | refused, guard reason `denied-tool` |

Every refusal is confirmed in three independent places, none of which is the guard's report of
itself: the tool result the runtime sent on to the provider carries the guard's refusal wording and
no content; the effect the call would have had did not happen; and the canary text never left the
workspace. Both arms produce the same refusals, reasons and per-tool counts. The test also runs the
case that a green-looking harness would get wrong: with the guard **deliberately unable to register**
(a plugin module without the guard factory), the session still completes and writes a complete
artifact — and the benchmark's own engagement gate refuses it, because `guard` is not `loaded`. That
is the difference between "the guard said it loaded" and "the run cannot be published if it did not".
A third case is the Stage 1V wiring fault itself: with a governor whose start **throws**, the driver
stops the client before any request is composed (measured: 21 ms, zero sessions observed), records the
failure in the artifact, and the run is refused as `session-exit-nonzero` rather than published as a
session that measured nothing.

**Limits.** This is tool-layer containment, not an OS sandbox: the guard sits in the runtime's tool
pipeline, so a process the runtime started outside that pipeline is not covered by it. The evidence
covers the **pinned runtime revision** only — a different build can load plugins differently, which
is why the wire gate fails closed on one.

### 6.2 The measurement gates this pass added

A run reaches the report only if its artifact proves: the driver exited 0, the file is this run's own
(nonce), it is whole (`complete`), it declares the mode the run was started in, **and the session it
describes ran to completion**. The last two are new, and both were real holes:

- **A crashed, killed or timed-out session used to be publishable.** The driver exits 0 as soon as
  it has written a whole artifact — the right contract for a process, whose evidence must survive a
  failure — so a session the runtime killed or the wall clock stopped arrived looking complete. Its
  counters describe a partial run. `checkSessionCompletion` now refuses `session-exit-nonzero`,
  `session-timed-out` and `session-outcome-unrecorded` by name, before grading is attempted.
- **A rehearsal could have been read as a live measurement.** A rehearsal drives the same driver,
  plugins and artifact shape; only its provider is a script. The declared mode must now match the
  mode the caller started (`mode-mismatch`), so scripted counts can never stand in for a session.

Each is pinned by unit tests, by a standing `level2:verify` check with a positive control, and by the
rehearsal's own refused-run accounting. The rehearsal was repeated to confirm the two checks are not
flaky (the containment probe depends on a real CLI session reaching a loopback provider); it passed both
times. The run also now **fails loudly** when a live session produced no plugin-observed outbound request
at all — a session whose repository-local plugin never loaded used to produce a well-formed artifact and an
observation that read like a "no-opportunity" treatment run, which is Stage 1U's failure mode wearing a
successful shape.

### 6.3 The native permission layer: an observation gap, not a configuration problem

The guard's own evidence file reports `permissionRules: null`, and the honest reading of that is narrow:
**the pinned runtime does not hand a plugin the permission rules it resolved.** The event a plugin
receives for a session carries no rule list, so there is nothing for the guard to record. That is a gap
in what the runtime *reports to a plugin* — not evidence that a rule is missing — and it was measured
rather than argued:

- **the runtime's own resolver reports the rules for the arm's repository.** Asked read-only before any
  session starts (`api config.get --standalone`), it returns the four denies this policy declares —
  `external_directory`, `shell`, `subagent` and `webfetch`, each `deny` — for both arms. The artifact
  records the action, the effect and a resource *class*; never a path;
- **the canonicalisation is the runtime's own.** The repository config declares `bash`/`task`; the
  resolver reports `shell`/`subagent` (observed 2026-10-11). A check that looked for our spelling would
  have found nothing and called a working policy missing — which is why the requirement is stated in the
  runtime's vocabulary;
- **removing the configuration makes a session leak.** A controlled run with the policy removed read a
  file outside the workspace, which is what "the second layer is doing something" looks like when it is
  observed instead of inferred.

Because the plugin event stream cannot show it, the layer is evidenced the only other way it can be —
from outside, and required:

1. **A live session is refused before it starts if the runtime does not resolve the denies.** The driver
   reads the rules before it spawns the CLI; if the read fails, or any required deny is absent, it exits
   2. A session would otherwise run with only the plugin layer in force — and the plugin layer is the one
   the harness proves, so it is the wrong moment to discover the other is unconfigured.
2. **A run whose artifact carries no resolved rules, or an incomplete set, is refused as a measurement**
   by `checkLiveEngagement(…, { requireNativePermissions: true })`, which the live path and the offline
   gate both exercise: the unobserved case and the partly-resolved case are pinned as refusals, and a
   fully resolved case is the positive control that keeps those from passing vacuously.

The rehearsal prints the same fact for both arms: *both arms showed the runtime's native permission denies
(the second containment layer) — control=4 rule(s), missing [none] treatment=4 rule(s), missing [none]*.
Enforcement of the plugin layer stays mandatory and independent of all of this — a session whose guard did
not register is refused (§6.1), and this section never substitutes a configuration reading for an observed
refusal. What is *not* claimed: the resolved rules are read on the private server for a standalone probe,
so they show what the runtime resolves from this repository's config; whether a *service-mode* session
loads that same project configuration is a separate fact, and the one the canary's first session is there
to establish (§7.2).

### 6.4 The instruction the session is given

The canary denies the shell, and the task pack used to instruct the agent to run its own suite ("Run
`node --test` until every test passes"). No contained session can obey that — and an instruction no
session can obey is a **fairness** defect before it is a containment finding: a failing outcome can no
longer be attributed to the code rather than to the impossible instruction, which is Step 6's
"correctness must be attributable" requirement read literally.

The prompts now state what is true instead: *"This session has no shell tool, so the tests cannot be run
from inside it; they are run outside the session against pristine copies."* Nothing else about the task
moved. Grading is unchanged and independent — each repository's own `node --test`, run after
**restoring the pristine test files** — and both arms receive the identical prompt bytes against the same
repository revision, the only difference being `DR_TOKEN_SAFE_MODE`. The pack fingerprint changes with the
prompt text, which is intended: this is a different experiment from the one the old prompts described.

It is pinned, not promised. `level2:verify` now carries `tasks:prompts-fit-the-session-they-run-in`, which
fails if any prompt asks for a shell command or omits the no-shell statement, and which carries its own
positive control: the detector must fire on the exact wording the pack used to carry, or the check would
pass vacuously. The containment deny itself is untouched — the benchmark was corrected, not the policy.

### 6.5 The first fatal arm outcome ends the plan

The 2026-10-12 canary measured a control-flow defect, not a measurement: the **control** session exited
non-zero (`Upstream request failed: Insufficient account funds`), its run was correctly refused as
`session-exit-nonzero` — and the **treatment** session was launched anyway. A single-use authorization was
therefore spent twice to learn one thing, and the second session could not have differed from the first.

The cause was where the loop lived: inside `cli.ts`, which no test can import, where an invalid
measurement recorded a disposition and then `continue`d. The sequence is now a function over the plan in
its own module, with the per-run execution **injected**, so "the second arm never launched" is a fact about
a returned list rather than a claim about control flow.

**Fatal — the plan stops, and every remaining run is published `not-run`, never launched:**

| Condition | Code |
| --- | --- |
| No observation at all: a crashed, killed or timed-out session, a missing/stale/partial/foreign artifact, a mode mismatch | `invalid-measurement` |
| The runtime refused the model, so no request was composed | `model-refused` |
| The session did not engage the harness (no plugin request, no guard, no workspace, no native-permission evidence, wrong arm) | `not-engaged` |
| A cap decides no further session may start — including an unreported cost while a spending cap is set | `budget` |

**Not fatal, deliberately:** a `task-failed` run (the model tried, the code did not pass) and an
`unavailable-evidence` run (the task ran, the host reported no token field). Those are results about the
model, and stopping on them would end an experiment because the model had a bad run.

Evidenced offline by fault injection, at zero cost: `benchmarks/tests/level2-sequence.test.ts` runs the
sequence against a fake executor that records what was launched, and the offline gate carries
`sequence:a-fatal-arm-outcome-stops-the-plan` — which fails if a fatal outcome launches a second arm, if
the failed run loses its disposition, or if the unattempted runs are not published as `not-run`.

### 6.6 A live run needs a clean checkout

A live run is an experiment against a **revision**. The 2026-10-12 canary started on a tree carrying
uncommitted work, so its report could not name what it had run against — reproducible by nobody, including
its author. Live mode now refuses to start in that state: `git status --porcelain` is read from the
repository root of the checkout containing the harness, and any tracked modification or untracked file
(true ignores, which is what this harness's own reports are, do not count) produces exit 2 **before any
session starts**. An unreadable tree — git missing, not a repository — is refused the same way, because
"could not tell" is not "clean".

The check is read-only and says so: it never stages, commits, stashes or deletes. The preflight prints the
state so an operator sees the refusal before authorizing rather than after:

```text
working tree:       DIRTY (27 uncommitted change(s)) — a live run would be REFUSED; commit or stash them first
```

(The count is a reading, not a constant: it was 23 before the free-only pass and 27 after it, because the
same pass added files. What matters is that it is non-zero, which is the state this checkout is in.)

On this checkout that is the current, intended outcome: the Stage 1U work is uncommitted, so the canary
cannot be re-run until it is committed. Pinned by `guards:a-dirty-working-tree-refuses-a-live-run` in the
offline gate (with the clean-tree case as the control that keeps it from passing vacuously) and by unit
tests over the porcelain parser and the injectable git reader.

### 6.7 What a request count counts

The failed canary recorded **three** hook invocations for the control arm and **two** for the treatment,
for sessions that received no model response at all. That difference is real and it is easy to misread, so
the artifact now states the categories:

| Quantity | Observable? | Value in that run |
| --- | --- | --- |
| `http.request` callbacks — one per request the runtime composed and was about to send | **Measured** | 3 (control), 2 (treatment) |
| Whether a composed request was a retry of an earlier one | **Not observable** | unknown — the harness does not infer retries |
| Requests the provider actually attempted | **Not observable** | unknown |
| Requests that completed with a response | **Not observable as a count**, but the consequence is | **0** — no response content and no usage were reported for any request |
| Wire bytes, marker counts | **Not observable in live mode** (the body is a `ReadableStream`) | none claimed |

The honest reading of 3 and 2: the runtime composed three and two outbound requests and the provider
refused them upstream. Nothing here says the provider attempted six requests in total, and nothing here
says the runtime retried — that would need a per-attempt signal the plugin does not receive. A session that
received no response reports no usage **for that reason**, not because the request count was zero.

### 6.8 Free-only models: the envelope the canary must stay inside

The experiment runs on **genuinely free** models only. The selected model is
`opencode/mimo-v2.6-flash-free` (backup and auxiliary: `opencode/muse-spark-1.3-contributor-free`), and
free means the runtime's own price row is present and **0** in all four tiers it reports — input, output,
cache read and cache write. The `-free` suffix decides nothing.

What is enforced, by whom, and where it is verified offline:

| Decision | Enforced by | Offline evidence |
| --- | --- | --- |
| Which models may be named | the approved-model list, before the session is spawned | `free-only:the-approval-list-decides-before-the-price-does`; an unapproved `-free`-suffixed identifier is refused |
| Whether the run may spend | the runtime's own `model.list` row through the free-only price gate (§6.8.1) | `free-only:every-price-tier-must-be-explicitly-zero` plus the four driver-boundary cases below |
| What both arms are configured with | one configuration object with **no arm parameter**, digested per arm | `free-only:the-configuration-is-one-object-for-both-arms`; the rehearsal shows equal digests (`524ab65a5df6e4ef…`) |
| Whether the runtime applied it | the runtime's own `api config.get --standalone` answer for this repository | `free-only:the-runtime-must-confirm-every-setting-it-resolved`; the rehearsal shows it resolved in both arms |
| Whether auxiliary inference happened | `--title` on the session command line, `compaction.auto: false`, and the runtime's own `model.request` kinds | the rehearsal's 28 checks: `primary=2` per arm and **no other kind**, with the loopback endpoint independently showing every request carrying the agent tool registry |
| Whether a substitution happened | the endpoint's capture of the model id in the body, and the model ids the hook reported | the rehearsal shows `mimo-v2.6-flash-free` only; `free-only:the-endpoint-names-the-model-in-its-own-spelling` pins the closed set |
| Whether a refused run can be read as a measurement | the artifact intake | `free-only:a-run-outside-the-policy-is-refused` — `model-policy-unverified`, not a comparison |

The full statement is in [SAFE_MODE_1U_FREE_ONLY.md](SAFE_MODE_1U_FREE_ONLY.md).

#### 6.8.1 The price gate, measured at the driver's boundary

Because the installed runtime offers no paid row for an approved model on this machine (its private server
has no catalogue without an account, and the approved model's row is zero on the account that exists), the
gate is measured against a **stub runtime** that answers the driver's two read-only calls and refuses to run
a session — no network, no inference possible even if the gate regressed:

| Catalogue reported for the approved model | Observed outcome |
| --- | --- |
| `input=3, output=15, cache read=0.3, cache write=3.75` | exit 2 — the tier is named (`input=3 … cacheWrite=3.75`), `Nothing was spawned`, and the runtime was asked only for `config.get` and `model.list` |
| listed, but with no price row | exit 2 — `reports no price row`; no session requested |
| an empty catalogue | exit 2 — `reported no model catalogue at all`; no session requested |
| all four tiers `0` | the **same** invocation walks past the gate and asks for the session — the control that proves the three refusals are about the price |

What the canary must still confirm live: that a real session on the free model reports cost `0` **with its
token fields present**, and composes no auxiliary request against the real provider.

### 6.9 The pre-transmission model guard: nothing leaves for A model outside the envelope

§6.8 restricts the *provider* and the *measurement*; neither can stop a request, because `opencode` offers free
and paid models alike and a refused measurement is refused **after** the call. The layer that acts **before
dispatch** is a plugin hook, `ctx.session.hook("model.request")`, whose callback the pinned runtime runs with no
`try`/`catch` — so a thrown refusal propagates out of the request assembly and the request is never built. It is
the same "throw to block" mechanism the containment guard uses at `tool.execute.before`.

| Decision | Enforced by | Offline evidence |
| --- | --- | --- |
| Which model a request may name | the guard plugin inside the session, at `model.request`, before the request is built | the model-guard probe: the guarded unapproved model reached **no** endpoint while the unguarded control did (§6.9.1) |
| Whether the guard is actually in force | the driver refuses to spawn without the guard factory and summarizer; the artifact must carry the block; the gate refuses a session with no guard evidence | `model-guard:a-run-that-cannot-show-bounded-requests-is-refused`, `model-guard:registration-is-not-inferred-from-a-claim`, `engagement:missing-model-guard-evidence-is-refused`, `engagement:unregistered-model-guard-is-refused` |
| Whether a refusal is a measurement | the artifact intake | `engagement:a-refused-model-request-is-refused` — a session in which the guard refused one request is refused, because it left the declared envelope |
| Whether both arms are bounded identically | the same generated guard and the same envelope in each arm, digested | the rehearsal: both arms `guard=loaded (hook registered)`, 0 refusals, each arm's own configuration digest |

The full statement, including what the guard cannot promise, is in
[SAFE_MODE_1U_FREE_ONLY.md](SAFE_MODE_1U_FREE_ONLY.md) §5.

#### 6.9.1 The guard, measured at the endpoint

`benchmarks/src/level2/model-guard-probe.ts` (`benchmarks/tests/model-guard-probe.test.ts`, 10 tests) starts real
pinned-runtime sessions against a loopback scripted provider — no credential, no model call — and reads the
**provider's own capture**, not the guard's log:

| Case | Endpoint received |
| --- | --- |
| unapproved same-provider model, **guarded** | **nothing** — refused before dispatch |
| the same model, **unguarded** (the control) | the model arrives — proof the runtime would have sent it |
| approved primary / approved auxiliary on a `title` request | the approved requests, so the guard refuses no legitimate work |
| unapproved **title** model mid-session, guarded | the primary's requests only; one refused and the session continued |
| an unknown identifier, guarded | nothing, refused by resolution (`runtime-refused-model`), distinguished from a guard refusal |

The endpoint case uses `opencode/exo-free` — same provider, **not** approved, but zero-priced — because the price
gate could not have caught it and only the approval list can. The same-provider **paid** id
(`opencode/gpt-5.4-mini`) is covered at the decision and plugin seams by `integrations/opencode/tests/model-guard.test.ts`
(27 tests: refused for every request kind, and refused with a throw at the plugin boundary).

What the canary must still confirm live: that the guard travels through a real service-mode session and registers
its hook there, and that a real session composes no auxiliary request — both of which the offline rehearsal shows
on the pinned runtime but a live provider is what actually exercises.

---

## 7. Limitations this canary cannot remove

1. **Service mode is not hermetic.** Both arms share this installation's runtime, so the run describes
   *this installation*, not a pristine one. Both arms see the same environment, so the pair is still
   apples-to-apples.
2. **The first session is the verification of the live path.** Nothing offline can confirm that a
   service-mode session loads repository-local plugins. The engagement check turns that risk into a
   reported failure instead of a silently empty measurement.
3. **The in-session cost stop has limits.** The governor acts on the cost the runtime *reports*: a session
   that reports none gives it nothing to act on, and the post-session tracker fails closed on that. The
   overshoot between a poll and the interrupt landing is bounded but not zero. And the interrupt of a
   *running* generation can only be confirmed by a session that actually crosses its cap — the expected
   spend makes that unlikely here, so if it never fires, that path is verified as far as the offline probe
   (a real idle session on the private server returning the documented shape) and the unit-tested loop.
4. **The task pack is below the design's minimum samples.** One task, one pair, 2 sessions. This is a
   plumbing-and-direction check and the report is labelled as unable to support a conclusion about tokens
   or correctness overall.
5. **No savings claim is made or implied**, whatever the canary reports. Per-field values are never summed
   into a "total", and the elision counters describe bytes removed from an assembled request, not tokens
   saved.
6. **Retries are not automatic.** A retry is a fresh session that the caps count like any other; the budget
   is per experiment, not per attempt.
7. **A listed model can still be refused at run time.** The plan stops on that refusal rather than repeating
   it (this is what Stage 1U measured).
8. **The shell tool is denied in the canary.** See §4 and §6.4: the prompts no longer ask for a command
   the policy refuses — they state the limit instead — so the instruction is satisfiable as written. The
   deny is unchanged and observed (the enforcement probe asks a real session for exactly that call and
   sees it refused, §6.1). Both arms are identical in this and grading runs outside the session, but the
   canary's task outcomes still must not be read as what a shell-enabled pilot would produce.
9. **Containment is tool-layer, not an OS sandbox.** The guard and the runtime's permission policy both
   act inside the tool pipeline. Nothing here stops a process the runtime started outside it, and nothing
   here is a container. The enforcement evidence (§6.1) covers the pinned runtime revision.
10. **The enforcement probe exercises the calls it scripts.** It asks for one call shape per channel with
   the argument keys this pinned runtime declares; it cannot enumerate every argument a real model might
   invent. A call for an unlisted tool or an unreadable argument is refused by the same fail-closed rules,
   which the unit tests pin, but the model-facing variety is not something an offline probe can exhaust.
11. **The 2026-10-12 canary produced no measurement.** Both sessions were refused upstream by the provider
   (`Insufficient account funds`); the run is published as two `invalid-measurement` rows, no grading ran,
   no repository changed, and 0 units / $0.0000 were reported. The live path is therefore **still
   unvalidated**: the canary established that the failure gates work, not that a session can be measured.
12. **A live run now also requires a clean checkout** (§6.6). On this checkout that prerequisite is not met
   — the Stage 1U work is uncommitted — so the canary cannot be re-run until it is committed, and the
   decision to commit is the operator's, not this harness's.
13. **The free-only envelope is verified offline.** The approved models' zero price rows are read from this
   installation's own `model.list`, and the *refusal* paths (an unapproved model, a non-zero tier, an
   absent row, an empty catalogue) are exercised at the driver's boundary against a stub runtime, because
   no environment available here reports a paid row for an approved model. What the canary must show that
   nothing offline can: a real session on the free model reporting cost `0` with its token fields present,
   composing no auxiliary request, and staying on the approved model (§6.8, and
   [SAFE_MODE_1U_FREE_ONLY.md](SAFE_MODE_1U_FREE_ONLY.md) §5).
14. **The pre-transmission guard is proven on a loopback endpoint and the pinned revision.** The model-guard
   probe shows an unapproved model reached no endpoint while the guard was loaded and did reach one without
   it, but it observes the *installed* runtime (2.0.24) against a *scripted* provider: it covers every request
   the pinned revision routes through `model.request` and cannot speak for a runtime that dispatches a model
   request by another path. A host that does not expose the hook is recorded as a missing capability and
   refuses the run rather than assuming coverage (§6.9).

---

## 8. Authorization request

I am asking for authorization to run **exactly** the command in §5, once.

The pre-spawn review this request was waiting on has now happened: the two measurement-integrity defects
(§9) are fixed and verified offline, and the passes since closed the fairness of the instruction (§6.4),
the evidence for the native permission layer (§6.3), the plan's stopping rule (§6.5) and the checkout
prerequisite (§6.6). Nothing below is a new request; it is the same command, re-stated against today's
measurements. **No live call is authorized by this document.**

**It must not be run yet, for two reasons that are not in the harness's gift to fix.** (1) The provider
account behind `service` refused the last attempt upstream for insufficient funds (§7.11), so a fresh run
would spend authorization to fail the same way; the preflight cannot see a balance. (2) Live mode now
requires a clean checkout (§6.6) and this one is dirty — the Stage 1U work is uncommitted. When both are
resolved, the same command is the one to authorize, and the preflight re-checked immediately before it is
the gate.

- **model** for a run under the free-only policy, `opencode/mimo-v2.6-flash-free` (backup/auxiliary
  `opencode/muse-spark-1.3-contributor-free`), whose price row this installation reports as **0 in all four
  tiers** (§6.8). The paid `opencode/gpt-5.4-mini` line this request originally carried (listed by the
  `service` runtime, status `active`, context 400,000 tokens) is superseded; it is a paid model and the plan
  is free-only. **runtime** `service` (OpenCode Desktop 2.0.24, the pinned revision);
- **two sessions** (one task, one pair, both arms), 5-minute timeout each, no retries;
- **caps** 1.5M units / $0.50 per session, 3M units / $1.00 in total; the per-session spending cap is also
  enforced **in session** through the runtime's native session interrupt (overshoot bounded by one
  1.5-second poll window), while the unit and cumulative caps remain post-session breakers;
- **containment** the byte-identical native permission policy — *read from the runtime before the session
  and required on both arms* (§6.3) — plus the guard plugin, with the session's own evidence required
  before any arm is counted (§4), including the rehearsal's end-to-end enforcement probe (§6.1);
- **the instruction** the prompts now state that the session has no shell tool and that grading runs
  outside it, so a session is graded on a task it can actually perform (§6.4); grading stays independent
  and identical for both arms;
- **expected spend** $0.10–$0.25, higher-but-plausible $0.60; **$1.50 is the most this harness can stop
  at**, not a cash ceiling — it is $1.00 of total cap plus one session's overshoot if the governor's
  interrupt could not land, and the caps act on the cost the runtime *reports* (§2, §7.3), so the true
  ceiling is "whatever the provider books before the interrupt", not a number this repository enforces;
- **no retry** without a new authorization, and no other stage started afterwards.

The 6-session pilot and the 36-session experiment are **not** part of this request.

---

## 9. Measurement integrity: a run is only a measurement if it can prove it is one

The Stage 1V canary produced a report that looked like a measured experiment while no session had run. Two
defects made that possible, and both are now closed in code with tests that fail if either returns.

**The governor arms before a model process exists, or the run is refused.** `planGovernorArming` (in the
shipped package) decides, from the mode, the runtime, the cap and which helpers the imported build actually
exposes, whether the supervisor can start. For a live capped service session that answer must be yes: the
driver exits 2 before spawning the CLI when it is not, and the harness separately refuses an observation
whose governor is not armed while a cap was configured. Fixing the missing `startCostGovernor` import alone
would not have been enough — a build can be broken in ways nobody enumerated, so the rule is "prove it
armed", not "assume the import worked".

**Every arm run carries a run identity, and its artifact must prove it.** The runner generates a nonce per
run, passes it to the driver, and removes any artifact already at the reused workspace path. The driver
stamps the nonce and a `complete: true` flag into its final write. Intake then requires, in order:

1. **a clean exit** — a non-zero driver exit is fatal, whatever the artifact at that path says;
2. **the artifact exists and parses**;
3. **it is marked complete** — a truncated write that happens to land on valid JSON is still rejected;
4. **the nonce matches** — an artifact left by an earlier run at the same path is refused as `artifact-foreign`;
5. **the declared mode is the mode that was asked for** — a rehearsal's scripted counts cannot be read as a
   live measurement (`mode-mismatch`);
6. **the session ran to completion** — the driver exits 0 as soon as it has written a whole artifact (the
   right contract for a process, whose evidence must survive a failure), so a killed, crashed or
   timed-out session used to arrive looking complete; it is now refused by name (`session-exit-nonzero`,
   `session-timed-out`, `session-outcome-unrecorded`) **before** grading is attempted;
7. **the observation contract holds** — identity, counters and evidence, recomputed rather than believed.

Any failure produces `accepted: false` and a named reason. There is no path by which a crashed, stale, partial
or mismatched run reaches a comparison. Step 6 also closes the governor's worst case end to end: with a
governor whose start throws, the driver stops the client before a request is composed (measured: 21 ms, zero
sessions observed) and the run is refused rather than published as a session that measured nothing.

**Every planned run appears in the report.** Reports now carry a *Run dispositions* table with one row per
planned arm run, classed as `solved`, `task-failed`, `invalid-measurement`, `unavailable-evidence` or
`not-run`. Before this, a refused run simply vanished: the pair count was short, but nothing said which run
was missing or why, which is how a crashed canary read as an incomplete one. The four classes are also
asserted by the offline gate, so a run that produces no measurement is published as exactly that.

**Verified offline (no model call, nothing spent).** `npm run verify:all` exits 0: 982 tests (611 opencode +
269 benchmarks + 83 core + 19 codex), the wire regression at 24/0, and the Level 2 offline gate at 73/0 —
including direct checks that a crashed driver, a stale artifact, a partial artifact, a rehearsal artifact
offered to a live run, a stopped session, a session carrying no containment evidence, an unregistered guard,
a capped session without an armed governor, a run whose runtime never reported its permission rules and a
run that reported only some of them are all refused, and that a valid run is still accepted. The rehearsal
runs the same governor initialisation and artifact-intake paths a live run does, and its 24 checks include
those plus the per-arm containment enforcement matrix (§6.1), the native permission layer in both arms
(§6.3), the instruction-fit gate (§6.4) and the free-only request/model evidence (§6.8); the Stage 1V crash
would today fail at zero cost in the rehearsal instead of on a paid run.

**Still true, and unchanged:** containment is enforced at the coding agent's tool layer, not by an OS sandbox
(§4) — and it is now *observed* being enforced rather than reported as loaded (§6.1). The in-session cost
bound acts on the cost the runtime reports, so a session that reports no cost gives it nothing to act on
(§2); a governor that cannot start at all stops the session and refuses the run (§9, step 6).
