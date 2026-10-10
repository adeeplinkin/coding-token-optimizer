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
- same harness, same mode, same optimizer revision, same optimizer configuration

Anything else produces an `invalid` verdict with an explanation. The baseline is a plain
pass-through `OptimizerEngine` with no registered passes and is never weakened to make a future
optimization look better.

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

1. **Identity and provenance** problems → `invalid`.
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
| `benchmarks/src/comparison.ts` | Accuracy-first baseline/candidate comparison |
| `benchmarks/src/report.ts` | Report building and JSON writing |
| `benchmarks/src/benchmark.ts` | Suite orchestration |
| `benchmarks/src/cli.ts` | Command-line entry point |
