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
   construction. The policy resolves as expected in the runtime's `config.get` on the private server;
   whether a *service-mode* session loads project configuration is recorded by the session's own evidence
   (below) rather than assumed.
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
the shell tool. **The canary denies the shell**, so the task's "run `node --test`" instruction cannot be
obeyed inside a session: that is deliberate (an arbitrary command has no argument a path check can
trust), it is identical in both arms, and it means the canary's coding outcomes are a plumbing result,
not a fidelity statement about shell-enabled task solving.

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

| Check | Command | Result (2026-10-11) |
| --- | --- | --- |
| Whole repository | `npm run verify:all` | **exit 0** — typecheck, build, **918 tests passed** (611 opencode + 205 benchmarks + 83 core + 19 codex), wire-regression gate **24 checks / 0 failures**, Level 2 offline **51 checks / 0 failures** |
| Live path plumbing + every safeguard (real sessions, loopback provider, no model) | `npm run level2 -- --rehearse --task repeated-reads-catalogue` | **PASS (9/9)** — both arms ran a session, 3 requests each, control `not-applicable`, treatment `fired` (9,409 bytes elided, 1 marker at the loopback endpoint); both arms **armed the in-session governor** (the live initialisation path) and produced an **accepted artifact** (this run's own nonce, complete); containment probe: in-workspace read reached the provider, out-of-workspace read refused, its canary token never reached the provider, session exited 0, both arms `guard: loaded`, `rootKnown: true` |
| Model availability | `--preflight` above | **OK** on `service`; 42 models; the requested model listed and priced (input 0.75, output 4.50) |

The rehearsal was repeated to confirm the two new checks are not flaky (the containment probe depends on a real CLI session reaching a loopback provider); it passed both times. The run also now **fails loudly** when a live session produced no plugin-observed outbound request at all.
A session whose repository-local plugin never loaded used to produce a well-formed artifact and an
observation that read like a "no-opportunity" treatment run — which is Stage 1U's failure mode wearing a
successful shape. That case now stops the plan and prints the artifact path, and it is covered by tests.

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
8. **The shell tool is denied in the canary.** See §4: `repeated-reads-catalogue` asks the agent to run
   `node --test`, and a contained session cannot. Both arms are identical in this and grading runs outside
   the session, but the canary's task outcomes must not be read as what a shell-enabled pilot would
   produce.

---

## 8. Authorization request

I am asking for authorization to run **exactly** the command in §5, once.

That request is **withdrawn pending review of §9**: the Stage 1V attempt uncovered two measurement-integrity
defects (a governor that could not arm, and a stale artifact published as a result). They are fixed and
verified offline, but a fresh authorization should follow a review of the fixes, not this document alone.

- **model** `opencode/gpt-5.4-mini`, **runtime** `service`;
- **two sessions** (one task, one pair, both arms), 5-minute timeout each;
- **caps** 1.5M units / $0.50 per session, 3M units / $1.00 in total; the per-session spending cap is also
  enforced **in session** through the runtime's native session interrupt (overshoot bounded by one
  1.5-second poll window), while the unit and cumulative caps remain post-session breakers;
- **containment** the byte-identical native permission policy plus the guard plugin, with the session's
  own evidence required before any arm is counted (§4), including the rehearsal's end-to-end probe;
- **expected spend** $0.10–$0.25, higher-but-plausible $0.60, hard bound on reported spend **$1.50**
  ($1.00 total cap plus the one session's overshoot if the governor could not act);
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
5. **the observation contract holds** — identity, counters and evidence, recomputed rather than believed.

Any failure produces `accepted: false` and a named reason. There is no path by which a crashed, stale, partial
or mismatched run reaches a comparison.

**Every planned run appears in the report.** Reports now carry a *Run dispositions* table with one row per
planned arm run, classed as `solved`, `task-failed`, `invalid-measurement`, `unavailable-evidence` or
`not-run`. Before this, a refused run simply vanished: the pair count was short, but nothing said which run
was missing or why, which is how a crashed canary read as an incomplete one. The four classes are also
asserted by the offline gate, so a run that produces no measurement is published as exactly that.

**Verified offline (no model call, nothing spent).** `npm run verify:all` exits 0: 918 tests (611 opencode +
205 benchmarks + 83 core + 19 codex), the wire regression at 24/0, and the Level 2 offline gate at 51/0 —
including direct checks that a crashed driver, a stale artifact, a partial artifact and a capped session
without an armed governor are all refused, and that a valid run is still accepted. The rehearsal now runs the
same governor initialisation and artifact-intake paths a live run does, and its 9 checks include the two
above; the Stage 1V crash would today fail at zero cost in the rehearsal instead of on a paid run.

**Still true, and unchanged:** containment is enforced at the coding agent's tool layer, not by an OS sandbox
(§4), and the in-session cost bound acts on the cost the runtime reports, so a session that reports no cost
gives it nothing to act on (§2).
