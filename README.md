# Dr. Token

**An open-source token optimizer for AI coding agents.**

Dr. Token aims to reduce unnecessary token usage during autonomous coding work **without sacrificing correctness or task completion**. It is designed to work *alongside* existing coding tools, not replace them.

> **Development status: Planning / early setup.** Dr. Token is not yet a working optimizer. There is no installer or verified token-savings benchmark available yet.

> **Current stage (Stage 1B):** the shared TypeScript core (contracts plus a pass-through engine) and a reproducible benchmark foundation exist. No optimization mode, no real coding-harness integration and no desktop application is implemented yet.

## Planned integrations

The initial target harnesses are:

- **OpenCode** — first integration to investigate and prototype
- **Freebuff**
- **OpenAI Codex**
- **Claude Code**

Each tool has its own integration interfaces and limitations. Compatibility and the ability to intercept or improve context handling must be verified individually; **support is not yet implemented or guaranteed**.

## Guiding principle: accuracy first

Dr. Token will optimize unnecessary work, not blindly shorten prompts. It should preserve instructions, relevant source code, important errors, failing tests, and other information needed to solve a coding task. When an optimization is unsafe or uncertain, the intended behavior is to keep the original context or bypass optimization.

## Planned capabilities

- Detect repeated, unchanged file reads and other redundant context retrieval
- Cache trustworthy project information across sessions, with change detection
- Reduce irrelevant file-search results and unnecessary exploration where a harness allows it
- Reuse useful project context across supported coding tools when technically feasible
- Provide a local desktop dashboard for configuration, usage visibility, and a global bypass switch
- Distinguish **measured**, **estimated**, and **benchmark-verified** savings

These are product goals, **not currently available features**.

## Optimization modes

Development and testing will follow this order:

1. **Safe** — conservative optimizations, preserving source information when uncertain
2. **Aggressive** — stronger techniques, only after Safe mode has been benchmarked
3. **Balanced** — informed by evidence from Safe and Aggressive evaluations

All three modes must prioritize reliable coding outcomes over token reduction.

## Planned technology stack

| Area | Technology |
| --- | --- |
| Shared optimizer | TypeScript |
| Windows desktop shell | Tauri and Rust |
| Desktop interface | React |
| Local persistence | SQLite |
| Version control | Git and GitHub |

The initial release target is **Windows**. A local AI model will not be required for the first release.

## Benchmarking standards

Any savings claim should be based on controlled comparisons with an unoptimized baseline. Evaluations will consider:

- Input, output, and total tokens where measurable
- Task completion, test results, and regressions
- Completion time, tool calls, repeated reads, and recovery attempts
- Whether context was lost or a coding task needed repairs

**Shorter prompts do not count as a success if the resulting code is worse.**

## Roadmap

- [ ] Establish the TypeScript core, Windows desktop foundation, and tests
- [ ] Investigate OpenCode integration and record baseline behavior
- [ ] Implement and thoroughly benchmark Safe mode
- [ ] Implement and benchmark Aggressive mode
- [ ] Develop and benchmark Balanced mode
- [ ] Investigate and integrate Freebuff, Codex, and Claude Code as their interfaces permit
- [ ] Prepare an installer, documentation, and public release

## Development setup (contributors)

**No end-user installer exists yet.** Contributor setup covers the shared core and the benchmark foundation.

Requirements: Node.js 22.12 or newer (Vitest 5 supports `^22.12.0`, `^24.0.0` and `>=26.0.0`) and npm.

```sh
npm install        # install development dependencies (workspace root)
npm run typecheck  # strict TypeScript type-checking (core, benchmarks and tests)
npm run build      # compile the shared core and the benchmark framework
npm test           # run the automated test suites (Vitest)
npm run benchmark  # run the synthetic benchmark suite and write a JSON report
npm run verify     # typecheck, build and tests in one command
```

The benchmark report is written to `benchmarks/reports/benchmark-report.json` (ignored by Git). See [docs/BENCHMARKING.md](docs/BENCHMARKING.md) for what the framework measures, how runs are compared, and what it cannot measure yet.

### What Stages 1A and 1B implement

- An npm workspaces layout containing the shared core (`packages/core`) and the benchmark framework (`benchmarks`)
- A strict TypeScript configuration and a minimal toolchain (TypeScript and Vitest)
- Typed contracts: `OptimizationRequest`, `OptimizationResult`, `OptimizationMode`, `OptimizerPass` and `OptimizationDecision`
- A pass-through optimizer engine that returns the original context exactly as received, respects the global bypass switch, records a structured decision for every request, and falls back to the original context if a future pass ever fails
- A reproducible benchmark foundation: synthetic fixtures, deterministic baseline and candidate runs, correctness checks, provenance tracking, baseline-versus-candidate comparison, and a JSON report
- Automated tests covering pass-through, bypass, all three mode identifiers, whitespace/Unicode/code preservation, failure fallback, fixture validation, run recording, comparison guards and the benchmark CLI

The optimizer never writes to disk: it only transforms the context it is given, in memory, and it never logs prompts, secrets or source code. Benchmark reports store hashes and labels rather than raw context.

### What is not implemented yet

- No optimization pass of any kind (Safe, Aggressive or Balanced)
- No token counting or token estimates; token usage is reported as **unavailable**, never invented
- No verified savings claims of any kind
- No real coding-harness execution (OpenCode, Freebuff, OpenAI Codex, Claude Code)
- No SQLite persistence, desktop application (Tauri, Rust, React) or Windows installer

## Contributing

Dr. Token is intended to be community-friendly and fully open source. Contribution instructions will be added as development begins. Please avoid claiming unverified performance improvements or integration support in proposals and documentation.

## License

Dr. Token is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE). Third-party components and assets remain subject to their respective license terms.
