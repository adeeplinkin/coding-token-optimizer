# Dr. Token benchmarking

This document describes the benchmark foundation in `benchmarks/`, what it can and cannot
measure today, and what is required before it can produce real-world evidence.

**Stage 1B provides infrastructure, not results.** Every run in this stage is a synthetic
fixture executed through the Stage 1A pass-through engine. No coding harness is executed, so
no token usage is measured and no savings are claimed.

## Goals

The benchmark exists to make future optimization claims *falsifiable*:

- quantify redundant token consumption during autonomous coding work
- prove that context needed to solve a task survived optimization
- detect regressions in task completion, tests, or recovery behavior
- keep measured, estimated, and unverifiable information clearly separate

The framework refuses to produce a positive result when correctness fails, and refuses to
invent numbers when a measurement does not exist.

## Running benchmarks

```sh
npm run benchmark                              # all fixtures, safe mode, default report path
npm run benchmark -- --mode balanced           # pick an optimization mode identifier
npm run benchmark -- --fixtures ./my-fixtures  # run a different fixture directory
npm run benchmark -- --out ./report.json       # choose the report output file
npm run benchmark -- --help                    # usage
```

The command builds the workspaces, runs every fixture twice (baseline and candidate), prints a
readable summary, and writes a JSON report to `benchmarks/reports/benchmark-report.json`
unless `--out` is given. Generated reports are ignored by Git.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Every correctness check passed (regardless of how many metrics were unavailable) |
| `1` | At least one correctness check failed; a report is still written |
| `2` | The benchmark could not be executed (bad arguments, unreadable fixtures) |

## What the framework measures today

| Measurement | Evidence in Stage 1B |
| --- | --- |
| Context preserved exactly (input equals output) | measured, per run |
| Required content still present (per labeled check) | measured, per run |
| Optimizer errors (failed decisions plus thrown errors) | measured, per run |
| Recovery/fallback attempts | measured, per run |
| Wall-clock duration | measured, but it varies between runs and is not a performance guarantee |
| Input, output and total tokens | **unavailable** |
| Tool calls | **unavailable** |
| Repeated file reads | **unavailable** |
| Task completion and test results from a real harness | **unavailable** |

Unavailable metrics carry an explicit reason in the report instead of a placeholder number.

## What the framework cannot measure yet

- Real token usage, because no coding harness reports its context to Dr. Token yet.
- Whether an optimization changes a real coding task's outcome.
- Repeated file reads or tool calls, which only a harness can observe.
- Any statement about Safe, Aggressive or Balanced mode effectiveness: no pass exists.

A report from this stage states plainly that it contains no evidence of real-world savings.

## Fixtures

Fixtures live in `benchmarks/fixtures/` as one JSON file per fixture:

```json
{
  "id": "002-ordinary-text",
  "description": "What this fixture covers.",
  "category": "ordinary-text",
  "expectExactPreservation": true,
  "requiredContent": [{ "label": "constraint", "text": "Do not modify unrelated files." }],
  "context": "...exact context passed to the optimizer..."
}
```

Rules enforced by the loader:

- `id` must be kebab-case and must equal the file name (without `.json`), which also guarantees
  that fixture ids are unique within a directory.
- `category` must be one of: `empty-context`, `ordinary-text`, `source-code`, `whitespace`,
  `unicode`, `repeated-information`, `error-message`, `instructions`.
- Unknown fields are rejected, so typos cannot silently disable a check.
- `requiredContent` entries carry a short `label` and the exact `text` that must survive.

Validation errors never echo fixture content, because recorded real contexts may be sensitive.
Unicode and whitespace fixtures use explicit escape sequences (`\u200d`, `\r\n`, `\t`) so exact
code points survive editors and transports.

The current fixture set is synthetic and small by design. It exercises the benchmark plumbing
and context-preservation behavior; it is **not** evidence about real coding agents.

## Runs, provenance, and comparability

Every run records provenance: fixture id, role, mode, harness, model, optimizer revision,
optimizer configuration, repository revision, a timestamp, and the evidence class of every
metric. Content is never recorded: runs store SHA-256 hashes and lengths instead.

Two runs may only be compared when their identity and provenance agree:

- same fixture id, with provenance matching the recorded fixture
- one `baseline` role and one `candidate` role
- same harness, same mode, same optimizer revision, same optimizer configuration — or, for a
  *declared controlled comparison*, the same everything except the one declared optimization
  axis (see the next section)

Anything else produces an `invalid` verdict with an explanation. The baseline is a plain
pass-through `OptimizerEngine` with no registered passes and is never weakened to make a future
optimization look better.

## Declared controlled comparisons (Stage 1S)

An A/B measurement of an optimization needs the one thing the comparability rules above forbid: a
baseline and a candidate whose optimizer configuration differs. Stage 1S therefore allows a
*declared* variant, so that exactly one optimization difference is permitted — and only that one.
A declaration names the experiment, the single axis it may move, and both arms:

```ts
const variant: DeclaredVariant = {
  declarationId: 'duplicate-elision-a',
  axis: 'optimizer-configuration',
  control: {
    variantId: 'control',
    role: 'baseline',
    optimizerConfiguration: 'pass-through',
  },
  treatment: {
    variantId: 'safe-mode-v1',
    role: 'candidate',
    optimizerConfiguration: 'pass-through+duplicate-elision',
  },
};

await runBenchmarkSuite({
  variant,
  candidateOptimizer: treatmentEngine, // the arm that actually exercises the treatment
});
```

The two arms deliberately record different configuration identities. What makes the pair
comparable is that both runs carry the declared arm identity, and every other comparability fact
still has to match:

| Requirement | Enforced by |
| --- | --- |
| Same declared experiment and axis | both arms must record the same `declarationId` and `axis` |
| Correct baseline/treatment assignment | the control arm must be `baseline`, the treatment arm `candidate` |
| Exactly one permitted difference | the recorded optimizer configurations must differ |
| No hidden difference | each recorded `configurationId` is re-derived from its own harness, revision, mode and configuration |
| Same task and input | same fixture id and an identical input hash |
| Same harness, mode and optimizer revision | equality checks |
| Same model, environment and project state | model and repository revision must both match, or both be unavailable |
| Same correctness criteria | identical correctness check names |
| Same measurement definitions | identical per-metric evidence classes |

Any failure produces `invalid` with a reason. The permitted difference never becomes a token
claim by itself: the correctness and token-evidence rules are untouched, so a treatment arm that
fails correctness is a `regression` however few tokens it used, estimates never produce
`benchmark-verified`, and missing token measurements stay `unavailable`.

Metadata is refused rather than repaired:

- a declaration that only one arm carries is `invalid` (a half-declared pair is not a controlled
  comparison);
- a malformed declaration — unknown or missing field, unknown axis, empty identifier, two arms
  that share a variant id or an optimizer configuration, or a control arm that is not on
  `baseline` — makes `runBenchmarkSuite` throw `InvalidVariantDeclarationError` before any run is
  recorded;
- an explicitly supplied `baselineConfiguration`/`candidateConfiguration` that contradicts the
  declaration is rejected, because the one permitted difference must have a single source of truth.

### Backward compatibility

- A comparison where **neither** run declares a variant follows the original rules exactly:
  different `configurationId` values are still `invalid`.
- An undeclared run records no `variant` field, and a report with no declared variant omits
  `controlledVariants` entirely, so a Stage 1B report is unchanged.
- `BENCHMARK_SCHEMA_VERSION` stays `1`: the declared-variant fields are additive and optional.

When a declaration is used, the report restates it under `controlledVariants`, so a reader can see
which experiment produced the numbers:

```json
"controlledVariants": [
  {
    "declarationId": "duplicate-elision-a",
    "axis": "optimizer-configuration",
    "arms": [
      { "variantId": "control", "role": "baseline", "optimizerConfiguration": "pass-through" },
      { "variantId": "safe-mode-v1", "role": "candidate", "optimizerConfiguration": "pass-through+duplicate-elision" }
    ]
  }
]
```

Declaring a variant makes a comparison *possible*; it does not make one *positive*. Until real
harness token usage exists, a declared pair still lands on `unavailable` like every other pair.

The command-line runner has no `--variant` flag yet: a declared comparison is run through
`runBenchmarkSuite` (as the variant tests do), while `npm run benchmark` keeps exercising the
undeclared path.

## How correctness is verified

Each run computes deterministic checks:

1. `engine-completed` — the optimizer returned a result instead of throwing.
2. `context-preserved-exactly` — output equals input, for fixtures that require it.
3. `required-content:<label>` — each required string is still present.
4. `unchanged-flag-consistent` — the engine's `contextUnchanged` flag matches the real output.

A run passes only when every check passes. If a pass throws or returns unusable output, the
Stage 1A engine falls back to the original context; the run then records a measured optimizer
error and a recovery attempt, and content-preservation checks still apply to the fallback.

## How comparisons work

`compareRuns` applies this precedence:

1. **Identity and provenance** problems → `invalid`. A pair where both runs declare the same
   controlled experiment is routed through the declared-variant rules first (see above); a pair
   where only one run declares a variant is `invalid`.
2. **Invalid measurements** (negative, non-finite, or fractional whole-number counts) → `invalid`.
3. **Baseline correctness failure** → `invalid` (the comparison would be meaningless).
4. **Candidate correctness failure** → `regression` with `correctnessRegression: true`. A
   candidate that reduces tokens while breaking required content is never a success.
5. **Missing token data** → `unavailable`.
6. **Estimated token data** → `unavailable`; estimates cannot support verification.
7. **Zero baseline total** → `unavailable` for the percentage, avoiding division by zero.
8. Otherwise: fewer tokens → `benchmark-verified`, more tokens → `regression`, equal → `no-change`.

In Stage 1B every real comparison lands on `unavailable`, because token usage does not exist.

## Evidence vocabulary

| Class | Meaning |
| --- | --- |
| `measured` | Obtained from an actual observation in this run |
| `estimated` | Calculated indirectly and explicitly labeled as an estimate |
| `benchmark-verified` | Supported by a valid controlled baseline/candidate comparison |
| `unavailable` | No reliable measurement exists; a reason is always recorded |

These classes are not interchangeable. `benchmark-verified` requires real token measurements and
passing correctness checks; `unavailable` never carries a value.

The optimizer core uses a related vocabulary for decisions: `none`, `estimated`, `measured`,
`benchmark-verified`, where `none` means nothing was measured. Stage 1A/1B decisions always use
`none`, and no decision claims token savings.

## Why synthetic fixtures are not evidence of savings

Passing fixtures show that the pipeline preserves context for the cases we wrote. They say
nothing about real coding sessions, because:

- no real harness context, tool output, or file-read behavior is involved
- the pass-through engine performs no optimization, so zero tokens are saved by definition
- the "candidate" runs use the same configuration as the baseline
- duration numbers vary between runs and are not a performance guarantee

Only a controlled comparison using real harness measurements can support a savings claim.

## Level 2 — the paired real-harness experiment (Stage 1U)

Level 0 (synthetic fixtures) and Level 1 (the deterministic request-level harness) run with no model.
Level 2 is the real thing: the same task solved twice by a real coding agent, once with the Safe Mode
pass off (control) and once with it on (treatment), compared through the declared-variant contract
above.

```sh
npm run level2:verify                       # verify the apparatus offline: no model, no cost
npm run level2 -- --plan                    # print the run plan and its minimum-sample checks
npm run level2 -- --rehearse                # both arms through a loopback scripted provider
npm run level2 -- --preflight --model <id>  # both runtimes' catalogues, the price row, a verdict
npm run level2 -- --live --approve-live --model <id> --runtime service --max-runs <n> \
  --max-cost-usd <n> --max-units <n>        # spend and usage caps; see docs/LEVEL2_PILOT_PREP.md
```

A live run is refused unless the runtime it is told to use reports a model catalogue that lists the
named model, and it stops before the next session once a cap is broken. A live session is also refused
as a measurement when no outbound request reached the repository-local plugin, because that means the
harness never engaged — the shape Stage 1U's pilot produced while looking successful — and when the
session does not report that its containment guard registered and checked the workspace. Containment is
enforced by the runtime's own explicit permission denies plus a guard plugin that refuses any tool call
resolving outside the session workspace (see [LEVEL2_CANARY_PREP.md](LEVEL2_CANARY_PREP.md) §4). The unit
and cumulative caps are checked *after* each session (they bound the sequence); on the service runtime
the per-session spending cap is also enforced **in session**, by a governor that calls the runtime's own
`session.interrupt` when the reported cost crosses it, and the wall-clock kill always applies. A live capped
session whose governor cannot arm is refused before any model process starts, and every arm run carries a
per-run nonce and a completion flag that its artifact must prove before it is accepted — so a crashed,
stale, partial or mismatched run cannot be published as a measurement (see
[LEVEL2_CANARY_PREP.md](LEVEL2_CANARY_PREP.md) §9). Reports list every planned run's disposition: `solved`,
`task-failed`, `invalid-measurement`, `unavailable-evidence` or `not-run`.

An artifact must also prove that it describes a session which **ran to completion**. The driver exits 0
as soon as it has written a whole file — the right contract for a process, whose evidence must survive a
failure — so a session the runtime killed or the wall clock stopped used to arrive looking complete. It is
now refused by name (`session-exit-nonzero`, `session-timed-out`, `session-outcome-unrecorded`) before any
grading is attempted, and an artifact whose declared mode is not the mode the caller started — a
rehearsal's scripted counts offered to a live run — is refused as `mode-mismatch`.

Containment is **enforcement, not configuration**. The offline harness asks a real session, through the
real plugin boundary and a loopback scripted provider, for the calls the policy must refuse: an absolute
path outside the workspace, a traversal, a shell command, an out-of-workspace write, a patch, a fetch and
a nested agent. Each is refused with the guard's own wording visible in the result the provider received,
with no side effect on disk and no canary text on the wire, while an in-workspace read and write still
succeed — and a session whose guard was deliberately prevented from registering is **refused** by the
engagement gate rather than published.

The plan also stops as soon as a run stops being evidence. The first fatal arm outcome — a session that
produced no measurement at all, a runtime that refused the model, a session that never engaged the
harness, or a cap that forbids another session — ends the plan, and every remaining planned run is
published as `not-run` instead of being launched. A coding failure does not stop it: a task the model
tried and failed is a result, not an apparatus failure. The rule is a function over the plan with the
per-run execution injected, so it is fault-injected in tests with no runtime and no cost
(`benchmarks/tests/level2-sequence.test.ts`), and a live run additionally refuses to start on a working
tree with uncommitted changes — read-only, never repairing anything — because a report that cannot name
the revision it measured is reproducible by nobody. `benchmarks/tests/containment-probe.test.ts` holds that evidence;
[LEVEL2_CANARY_PREP.md](LEVEL2_CANARY_PREP.md) §6.1 states the matrix and its limits (tool-layer
containment, pinned revision only).

Containment has a second layer, and it is *required* rather than assumed: before a live session starts, the
harness asks the runtime for the permission rules it resolved for that repository and refuses to start if
any deny the policy declares is missing; a run whose artifact carries no such reading, or an incomplete
one, is refused as a measurement. The plugin event stream does not carry those rules in the pinned runtime
(`permissionRules: null` is a reporting gap, not a missing rule), so the reading comes from the runtime's
own resolver instead. Containment is what makes the task fair, and so is the instruction: the prompts state
that the session has no shell tool and that its tests are run outside it, because a task that orders an
agent to run a command the policy refuses cannot measure coding. See
[LEVEL2_CANARY_PREP.md](LEVEL2_CANARY_PREP.md) §6.3–§6.4.

The experiment is **free-only**, and free is a price, not a name. The approved set is the measured free
primary `opencode/mimo-v2.6-flash-free` plus the auxiliary/backup
`opencode/muse-spark-1.3-contributor-free`, and a model may be named only if the runtime's own `model.list`
row for it is present and **0** in every tier the runtime prices — input, output, cache read and cache
write. The check runs *before* a session is spawned, and an artifact whose policy block does not re-derive
to a verified free-only run is refused as `model-policy-unverified` instead of compared. Both arms receive
one configuration object with no arm parameter (primary, auxiliary, `enabled_providers: ['opencode']`,
`compaction.auto: false`, `autoupdate: false`, `share: 'disabled'`), digested per arm and re-checked against
the runtime's own resolved answer for the repository, so a dropped key is a refusal rather than a surprise.
Auxiliary inference is prevented rather than hoped for — automatic title generation is suppressed by
supplying the title on the command line, compaction is off — and the absence is measured: the runtime's
`model.request` kinds must show `primary` only, with the loopback endpoint independently confirming that
every request carried the agent tool registry. A synthetic per-kind hook name registers cleanly and never
fires in this runtime, which is why a zero from a hook that never ran is treated as silence, not absence.
[SAFE_MODE_1U_FREE_ONLY.md](SAFE_MODE_1U_FREE_ONLY.md) is the full statement, including what is still
unverified.

**Nothing outside the envelope is transmitted.** The free-only policy bounds the provider and the artifact
gate bounds the *measurement*, but neither can stop a request: `opencode` offers free and paid models alike,
and a refused measurement is refused after the call. A third layer acts *before* dispatch — a plugin hook,
`ctx.session.hook("model.request")`, whose callback the pinned runtime runs with no `try`/`catch`, so a thrown
refusal propagates out of the request assembly and the request is never built. It permits only the approved
pair; refuses every other model (a paid one under the same provider, another provider's, an unknown id), an
unreadable model and an unsupported request kind; and it never rewrites a model. It is mandatory three ways:
the arm driver refuses to spawn without the guard factory and summarizer and an envelope matching *this*
run's configuration; the artifact must carry the guard's summarized evidence or it is refused as
`model-guard-unverified`; and the engagement gate refuses a session in which the guard refused a request,
because it left the declared envelope. Enforcement is proven at the endpoint, not from the guard's own log:
`benchmarks/tests/model-guard-probe.test.ts` starts real sessions against a loopback scripted provider and
shows the guarded unapproved model reaching **no** endpoint while the unguarded control reaches one. The full
statement, including that it covers the pinned revision's dispatch path only, is
[SAFE_MODE_1U_FREE_ONLY.md](SAFE_MODE_1U_FREE_ONLY.md) §5.

The **two-session canary** that verifies the live path before the 6-session pilot — its exact command,
model, expected spend, enforceable-versus-post-session limits and authorization request — is
[LEVEL2_CANARY_PREP.md](LEVEL2_CANARY_PREP.md). The 6-session pilot's price list, expected volume, hard
caps and remaining uncertainty are in [LEVEL2_PILOT_PREP.md](LEVEL2_PILOT_PREP.md).

### What a Level 2 run is

- **Frozen task pack** (`benchmarks/src/level2/tasks.ts`): six synthetic repositories spanning
  reading-and-editing, debugging a failing suite, a multi-file change, a repeated-read task designed
  to *create* an elidable duplicate, a task with no duplicate opportunity at all, and an edge-case fix.
  The pack is fingerprinted, so a changed pack is visibly a different experiment.
- **Independent grading**: each repository ships its own `node --test` suite, and grading **restores
  the pristine test files** before running them. An agent that rewrites the tests gains nothing; the
  offline verification proves this by grading a repository whose tests were replaced with trivially
  passing ones (it still fails).
- **Fresh session, fresh repository**: one session per arm run, in a newly provisioned copy. The
  runtime is chosen explicitly: `--runtime standalone` gives the session a private config and data home,
  while `--runtime service` runs it on the already-running background service — the only runtime on the
  development machine that holds an account model catalogue — and swaps the arm's switch from an
  environment variable to explicit options in the repository-local plugin file. The artifact records
  which was used and what that means for isolation.
- **One declared difference**: both arms load the same shipped plugin; only `DR_TOKEN_SAFE_MODE`
  differs (`off` versus `apply`).
- **ABBA ordering** per task, so provider cache warm-up cannot systematically favour one arm, and the
  order each pair actually ran in is recorded.
- **Minimum samples**: at least 5 tasks and at least 3 pairs per task (≥ 15 pairs, ≥ 30 arm runs).
  Fewer is reported as an incomplete experiment, never as a result.

### Mechanism evidence, and its honest limits

A token delta is not evidence that this pass caused it, so every treatment run must show the pass
fired, and every control run must show it did not:

- the pass's own counters (`requestsApplied`, `elidedBytes`, `markerBytes`) travel in the session
  summary the shipped observer writes;
- where a loopback provider endpoint is in the request path, the marker is counted at that endpoint,
  and a control arm must show zero markers;
- a treatment run whose mechanism cannot be confirmed is classified `unexplained` and excluded from
  every comparison; a run with nothing eligible to elide is `no-opportunity`, which is **not** a
  saving of zero.

The runtime hands the outbound body to `session.hook("http.request")` as a `ReadableStream`, so a
plugin **cannot** measure the request it is about to send (measured in Stage 1U). A live run against a
real provider therefore has no wire observation and is labelled `fired-counters-only` rather than
`fired`. The exact byte identity — treatment request shorter by exactly
`elidedBytes - markerBytes` — is asserted by the wire regression over one deterministic request
(`npm run verify:wire`), where both arms send the same request.

### Token fields

Level 2 reports each host-reported token field separately (input, output, reasoning, cache-read,
cache-write) and never sums them. The framework's `totalTokens` metric stays **unavailable** by
construction, which means the generic comparison verdict for a Level 2 pair is `unavailable` rather
than `benchmark-verified`: the correctness gate and every comparability guard still run, but no
"verified improvement" verdict can be produced from overlapping fields. Per-field deltas are reported
as a distribution (median, range, sample count, sign consistency) over the pairs whose mechanism fired.

## Adding a real coding-harness benchmark later

1. Add an adapter that produces an `OptimizationRequest` from real harness context and records
   the harness, model, and repository revision it came from.
2. Extend the harness integration to report token usage per task; record it as `measured`, or as
   `estimated` when it is derived indirectly.
3. Record task outcome signals (task completed, tests passed, repairs required, tool calls,
   repeated reads) as measured metrics.
4. Run each task with the unoptimized baseline and with the candidate under the same harness,
   model, mode, and revision, then compare with `compareRuns`.
5. Store only hashes and labels in reports unless the recorded content is explicitly safe to keep.

The runner already accepts an injected optimizer and per-run provenance, so real runs can be
added without replacing the framework.

## Module map

| File | Purpose |
| --- | --- |
| `benchmarks/src/types.ts` | Fixture, measurement, provenance, run, comparison, and report types |
| `benchmarks/src/measurement.ts` | Evidence-aware measurement constructors and metric validation |
| `benchmarks/src/fixtures.ts` | Fixture loading and schema validation |
| `benchmarks/src/provenance.ts` | Version constants, configuration ids, provenance construction |
| `benchmarks/src/runner.ts` | Deterministic fixture execution, correctness checks, run records |
| `benchmarks/src/comparison.ts` | Accuracy-first baseline/candidate comparison, including declared controlled comparisons |
| `benchmarks/src/variant.ts` | Declared-variant validation and arm provenance |
| `benchmarks/src/report.ts` | Report building and JSON writing |
| `benchmarks/src/benchmark.ts` | Suite orchestration |
| `benchmarks/src/cli.ts` | Command-line entry point |
| `benchmarks/src/level2/tasks.ts` | The frozen Level 2 task pack, with correct and wrong solutions |
| `benchmarks/src/level2/repos.ts` | Repository provisioning, revision identity, snapshotting |
| `benchmarks/src/level2/grade.ts` | Independent grading against pristine tests |
| `benchmarks/src/level2/plan.ts` | ABBA run plan and minimum-sample enforcement |
| `benchmarks/src/level2/variants.ts` | The Level 2 declared variant and per-arm settings |
| `benchmarks/src/level2/mechanism.ts` | Mechanism classification from counters and endpoint evidence |
| `benchmarks/src/level2/records.ts` | Arm observations to framework run records |
| `benchmarks/src/level2/observation.ts` | Strict artifact intake (mechanism recomputed, never trusted) |
| `benchmarks/src/level2/report.ts` | Experiment building, per-field distributions, Markdown and JSON |
| `benchmarks/src/level2/runner.ts` | Provisioning, arm driver invocation, grading, assembly, the runtime-catalogue probe and the isolation verdict |
| `benchmarks/src/level2/budget.ts` | Per-session and total caps in both currencies (units and reported USD) |
| `benchmarks/src/level2/guards.ts` | The refusals that stand between an authorization and a live call |
| `benchmarks/src/level2/verify.ts` | The offline verification suite |
| `benchmarks/src/level2/cli.ts` | `--offline-verify`, `--plan`, `--rehearse`, `--live` |
| `integrations/opencode/scripts/level2-arm.mjs` | One arm, one session, content-free evidence |
