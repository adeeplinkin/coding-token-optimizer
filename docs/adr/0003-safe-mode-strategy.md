# ADR 0003 — Safe Mode strategy: exact duplicate tool-result elision with a presence proof

- **Status:** Proposed (design accepted for implementation planning; nothing implemented or benchmarked)
- **Date:** 2026-10-11
- **Stage:** 1O (Safe Mode architecture, feasibility and benchmark design)
- **Deciders:** Dr. Token maintainers
- **Related:** [docs/SAFE_MODE_DESIGN.md](../SAFE_MODE_DESIGN.md) · [docs/adr/0001-opencode-integration.md](0001-opencode-integration.md) · [docs/adr/0002-codex-integration.md](0002-codex-integration.md) · [docs/BENCHMARKING.md](../BENCHMARKING.md) · [docs/CODEX_VALIDATION.md](../CODEX_VALIDATION.md) §14

## Context

The observation foundation is now runtime-verified on both target harnesses. Version 1N observed a real
Codex turn end to end (16 hook deliveries, `PreToolUse`/`PostToolUse` 6× each, six correlated tool
calls, one exact repeated read identified live), and the OpenCode V2 adapter has runtime-verified
lifecycle, project isolation and host-reported token usage. Dr. Token can therefore *see* redundant
work. It cannot yet act on it.

The question this ADR settles is which single transformation may be attempted first, and on which
harness. The constraints that shape the answer:

1. Dr. Token's purpose is to reduce **model-visible tokens**, not tool executions or disk reads.
2. A transformation may only be adopted when its equivalence can be *proven*, not argued.
3. The two harnesses do **not** have the same capabilities, and treating them as one would be a
   correctness hazard.
4. The project's own comparison contract cannot yet express a treatment/control pair (see §6.4 of the
   design): `compareRuns` rejects differing `configurationId`s as `invalid`, and `configurationId`
   includes the optimizer configuration.
5. Development order is fixed: Safe, then Aggressive, then Balanced.

## Decision

Adopt **exact duplicate tool-result elision with a presence proof** as the first Safe Mode strategy, and
implement it on **OpenCode V2 only**.

- **The pass:** while the host assembles a model request, if two `tool-result` parts of the *same
  read-only* tool inside the same request carry byte-identical text, the later part's text is replaced
  by a fixed, versioned, content-free marker — **only when the earlier identical text is still present
  in that same request**.
- **No cache.** The pass keeps no state across requests, sessions, or processes. Identity, lifetime and
  invalidation questions are answered by not having a cache: the request being sent *is* the cache, and
  every decision is recomputed from it.
- **Fail-closed to transform, fail-open to the host.** Every eligibility condition is conjunctive; any
  doubt means the request is left untouched, and no failure may ever propagate into the host.
- **Observe first.** The first shipped milestone (`M1`) records would-elide decisions and measures the
  real sent request (`session.hook("http.request")`) **without mutating anything**; mutation requires an
  explicit opt-in (`M2`) plus the wire check.
- **Codex is explicitly out of scope** for this experiment. Codex has no channel to rewrite a tool
  result (`updatedMCPToolOutput` is parsed as unsupported in the pinned runtime) and no channel to reach
  the prepared request, so no equivalent or information-preserving substitution exists there. Codex
  stays observation-only, and the gap is recorded rather than worked around.
- **Capability gating is mechanical:** a strategy declares the capabilities it needs, and is not
  constructed at all when any is missing — unsupported capabilities are disabled, never approximated.
- **Measurement is a gate, not an afterthought:** the benchmark must show the mechanism actually fired
  (the outbound body shrank by exactly the recorded removed length, with retained parts byte-identical),
  or the run is recorded as `no-opportunity`.
- **Before any `benchmark-verified` verdict, the comparison contract must gain a declared single-axis
  variant** so a control/treatment pair is comparable without weakening the existing guard.

## Consequences

**Positive**

- The equivalence argument is structural, not statistical: at send time the removed text is provably
  present in the same payload. The transformer needs no cache, no TTL and no invalidation logic, which
  removes an entire bug class before any code exists.
- The transformation touches only the outgoing request, so the host's stored transcript, tool results and
  files stay exactly as they were — a much smaller blast radius than editing stored results.
- Everything except the view adapter is pure and harness-independent, so the strategy is fully testable
  with no host, in CI, for free.
- The capability gate makes "we didn't guess" a property of the code path rather than a policy promise.
- The experiment doubles as a measurement of reality: M1 answers how often duplicate reads actually
  happen, before anything is optimized.

**Negative / costs**

- **The strategy may not work at all**, because the hook it depends on
  (`session.hook("context")`) is *contract-verified, not runtime-verified*. M1 and M2 exist to settle
  that, and a negative result is a legitimate outcome of this ADR.
- Savings are bounded by the window in which two identical copies coexist in one request — compaction
  trimming one of them legitimately disables the elision. Expect modest, not dramatic, numbers.
- The v1 allowlist is deliberately one tool (`read`), so coverage starts small.
- The provider request will differ from the stored session history, so "what did the model see" becomes a
  question only Dr. Token's own records can answer — an auditability requirement that must be honoured.
- The benchmark framework needs a schema change (§6.4) before this can be verified by the project's own
  standard, which is additional work with no token benefit.
- Codex — the harness where repeated reads were actually measured live — gains nothing from this stage.

## Alternatives considered

1. **Rewrite the tool result at `tool.execute.after` (before it is stored).** Rejected as the *first*
   experiment: equivalence then depends on the earlier copy surviving into a future request, which is not
   knowable at that moment, so it requires a cache with lifetime and invalidation rules — precisely the
   staleness risk this design avoids. Retained as a possible later variant, and only with the presence
   proof re-established at request time.
2. **Cross-session content cache that serves a re-read without re-running the tool.** Rejected: it saves
   tool execution and disk I/O while the model still receives the content and still pays for it, so it is
   not a token optimization. It also introduces filesystem caching, staleness and privacy cost.
3. **Codex `PostToolUse` `decision: "block"` to replace a repeated read with feedback.** Rejected: this
   substitutes *different* content (hook feedback, capped at roughly 2.5k model-visible tokens with
   spill) and also signals a block. It is not an equivalence-preserving substitution and cannot be
   validated as one.
4. **Prevent the second read** (`PreToolUse` deny, or removing/altering the tool via `tool.transform`).
   Rejected: it changes agent behavior and tool-call semantics, and a denial is not a successful read.
   Whether a model *should* be told "you already read this" is a behavioral hypothesis, not a
   transformation Dr. Token can prove.
5. **Generic tool-output truncation or "compression".** Rejected: lossy by definition, cannot be proven
   equivalent, and violates accuracy-first.
6. **Inject an "already read" note via `additionalContext`.** Rejected: it *adds* tokens and pays off
   only if the model then declines to read — a gamble, not a transformation.
7. **Reuse a cached compaction summary (`session.compaction.result`), which can skip a whole model
   request.** Not rejected on merit — it is a promising later Safe Mode candidate with potentially larger
   savings — but deferred: it replaces generated content and needs its own equivalence story, so it must
   not be the first thing Dr. Token is allowed to change.
8. **Prompt/instruction de-duplication.** Deferred: genuinely a Safe Mode candidate, but it touches the
   highest-value content (instructions) and is a different experiment from repeated tool results.
9. **Provider-side prompt caching or cache-aware request ordering.** Rejected for this stage: it reduces
   *cost*, not model-visible tokens, and it belongs to measurement rather than to a transformation.

## Open questions

- Is `session.hook("context")` honoured at runtime by OpenCode Desktop 2.0.24? (M1/M2 settle it.)
- Does the host's usage counter move when the request shrinks, or does cache accounting hide it?
- How do two plugins that both rewrite `messages` interact?
- What is the real-world duplicate-read rate that M1 will measure, and is it large enough to justify M3–M5?
- Does the marker measurably change model behaviour on real tasks? (Level 2 answers it; correctness is
  the gate, not the metric.)
- What single-axis variant shape should provenance take so that future control/treatment experiments stay
  comparable without weakening the existing guards?

None of these may be answered by inference, and none of them may be answered by loosening a check.
