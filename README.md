# Dr. Token

**An open-source token optimizer for AI coding agents.**

Dr. Token aims to reduce unnecessary token usage during autonomous coding work **without sacrificing correctness or task completion**. It is designed to work *alongside* existing coding tools, not replace them.

> **Development status: Planning / early setup.** Dr. Token is not yet a working optimizer. There is no installer or verified token-savings benchmark available yet.

> **Current stage (Stage 1D):** the shared TypeScript core (contracts plus a pass-through engine), a reproducible benchmark foundation and the first coding-harness adapter exist. The OpenCode adapter **observes only** — it records tool calls, potentially repeated reads and the token usage OpenCode reports, and never modifies model context or agent behavior. No optimization mode, no verified live harness run and no desktop application is implemented yet.

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
- [ ] Record real OpenCode baseline behavior with the Stage 1D observer (the API research and the observation-only adapter are done; no live run has happened yet)
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

OpenCode work is documented separately: [docs/OPENCODE_OBSERVER.md](docs/OPENCODE_OBSERVER.md) (the Stage 1D observation-only adapter, its privacy rules and its unverified runtime surface) and [docs/OPENCODE_FEASIBILITY.md](docs/OPENCODE_FEASIBILITY.md) plus [docs/adr/0001-opencode-integration.md](docs/adr/0001-opencode-integration.md) (the Stage 1C API research and the architecture decision).

### What Stages 1A, 1B and 1D implement

- An npm workspaces layout containing the shared core (`packages/core`), the benchmark framework (`benchmarks`) and the OpenCode integration (`integrations/opencode`)
- A strict TypeScript configuration and a minimal toolchain (TypeScript and Vitest)
- Typed contracts: `OptimizationRequest`, `OptimizationResult`, `OptimizationMode`, `OptimizerPass` and `OptimizationDecision`
- A pass-through optimizer engine that returns the original context exactly as received, respects the global bypass switch, records a structured decision for every request, and falls back to the original context if a future pass ever fails
- A reproducible benchmark foundation: synthetic fixtures, deterministic baseline and candidate runs, correctness checks, provenance tracking, baseline-versus-candidate comparison, and a JSON report
- Automated tests covering pass-through, bypass, all three mode identifiers, whitespace/Unicode/code preservation, failure fallback, fixture validation, run recording, comparison guards and the benchmark CLI
- An observation-only OpenCode adapter (`@dr-token/opencode-observer`), verified against the published V1 `@opencode-ai/plugin` 1.18.35 hook contract: it counts tool executions, identifies potentially repeated file reads by a hashed (path, offset, limit) identity, collects only the token and cost fields OpenCode actually reports, keeps state per session and in memory with explicit bounds, exposes a bypass switch, and fails open in every hook. It registers no hook that can change agent behavior and writes nothing at all unless the user explicitly configures a summary file
- 248 automated tests across the three workspaces (19 core, 70 benchmark, 159 observer)

The optimizer never writes to disk: it only transforms the context it is given, in memory, and it never logs prompts, secrets or source code. Benchmark reports store hashes and labels rather than raw context.

### What is not implemented yet

- No optimization pass of any kind (Safe, Aggressive or Balanced)
- No token counting or token estimates in the optimizer or the benchmark framework: where no coding harness reports usage, token metrics stay **unavailable** rather than invented. (The Stage 1D OpenCode observer does read the per-message usage fields OpenCode reports, and still refuses to derive a session total)
- No verified savings claims of any kind
- No verified live coding-harness execution. The Stage 1D OpenCode adapter exists and is tested against deterministic mocked hook events, but it was never loaded by a running OpenCode installation (none was available), so none of its behavior is runtime-confirmed
- No optimization inside the OpenCode adapter: it observes and never suppresses, rewrites or replaces anything (OpenCode, Freebuff, OpenAI Codex and Claude Code remain unimplemented)
- No SQLite persistence, desktop application (Tauri, Rust, React) or Windows installer

## Contributing

Dr. Token is intended to be community-friendly and fully open source. Contribution instructions will be added as development begins. Please avoid claiming unverified performance improvements or integration support in proposals and documentation.

## License

Dr. Token is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE). Third-party components and assets remain subject to their respective license terms.
