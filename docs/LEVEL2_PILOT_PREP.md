# Level 2 pilot — prepared, not authorized

**Scope.** This document prepares the **6-session pilot** on `opencode/gpt-5.4-mini`: one task
(`repeated-reads-catalogue`), three pairs, both arms (6 arm runs). It states the applicable price list,
the expected token volume, the hard caps that will be enforced, and the uncertainty that remains. It
does **not** authorize anything: the 6-session pilot and the 36-session experiment both wait for an
explicit approval naming the model.

**Status: blocked on one decision, not on money.** The pilot as previously configured cannot start at
all — the measured cause is in §3, and the fix (`--runtime service`) is in §4. A live run is now refused
before it starts unless the runtime it is told to use can actually offer the model.

---

## 1. Price list (USD per million tokens)

Read from the runtime's own model catalogue, `model.list`, over the pinned runtime
(`opencode-cli` 2.0.24, `opencode api model.list`, 2026-10-11). The runtime is the component that
computes the reported cost of a session, so this is the price list behind every cost figure the harness
records.

| Field | `opencode/gpt-5.4-mini` |
| --- | --- |
| Input | **$0.75** / M tokens |
| Output | **$4.50** / M tokens |
| Cache read | **$0.075** / M tokens |
| Cache write | **$0** / M tokens |
| Reasoning | billed as output (the catalogue carries no separate reasoning row) |
| Reported status | `active`, `enabled: true` |
| Limits | context 400,000; max input 272,000; max output 128,000 |
| Released | 2026-03-17 |

Cross-check: the catalogue the runtime fetches from `https://models.opencode.ai/api.json` (5,389,867
bytes, `ETag "dc800728d62b322f8bcce55fa8bfe76a"`, fetched 2026-10-11) carries the identical rows
(`input 0.75`, `output 4.5`, `cache.read 0.075`) for the same model. Two independent reads of the same
numbers; neither is a guess from memory.

### What is *not* observable, and is therefore not claimed

- **Credit consumption.** No balance, quota or credit endpoint appears in the runtime's API surface
  (its groups are `agent`, `config`, `credential`, `integration`, `location`, `mcp`, `model`,
  `project`, `provider`, `session`, `shell`, …). Whether the account settles these list prices in cash
  or against a plan's credits cannot be read from this machine. What *can* be read is the cost the
  runtime attributes to each session, and that is what the cap below uses.
- **A price for any other model.** Only the pilot's model is quoted above; the runtime's catalogue has
  42 entries and the harness prints the row for whatever `--model` is chosen.
- **Historical spend of this machine** (from the runtime's own local accounting, 23 recorded sessions):
  median 1.1M conservative units and **$0.0698** per paid session, largest paid session **$1.74**
  (85.9M units: 3.71M input, 97k output, 174k reasoning, 81.9M cache read — a different provider and
  price list, so it is a shape reference only, not a pilot forecast). Free models report `cost: 0`.

---

## 2. Expected token volume for the 6 sessions

Fixed inputs, measured from the frozen task pack (`repeated-reads-catalogue`):

| Item | Bytes | ≈ tokens |
| --- | --- | --- |
| Instruction (prompt) | 348 | 87 |
| `data/catalog.json` | 8,359 | 2,090 |
| Source, tests, manifest, README | 897 | 224 |
| **Repository total** | **9,256** | **≈ 2,300** |

The dominant term is *not* the repository. It is the runtime's own request prefix (system instruction,
tool schemas, environment notes) plus accumulated history, re-sent on every request. That prefix is not
measurable before a session runs; the pilot's first session is what measures it. The estimate therefore
carries an explicit range, and the caps — not the estimate — are what bound the spend:

| Quantity | Central | Higher-but-plausible | Hard cap |
| --- | --- | --- | --- |
| Requests per session | 10–20 | 40 | wall-clock timeout 10 min |
| Conservative units per session (all reported fields added) | 0.25M | 2M | **1.5M** |
| Cost per session | $0.05–$0.12 | $0.30 | **$0.50** |
| Six sessions, units | 1.5M | 12M | **6M** |
| Six sessions, cost | $0.30–$0.72 | $1.80 | **$2.00** |

**Hard bound on money: $2.00 plus at most one session that trips the cap, i.e. ≤ $2.50**, and the run
stops before the next session starts. The per-session $0.50 cap is *also* enforced in session on the
service runtime: a governor polls the cost the runtime reports and calls its native `session.interrupt`
when the cap is crossed, so the overshoot is bounded by one poll window rather than the whole session
(see [LEVEL2_CANARY_PREP.md](LEVEL2_CANARY_PREP.md) §2); the ≤ $2.50 figure is the worst case in which
that in-session stop cannot act. A session that reports no cost at all stops the run rather than
continuing unmeasured (`cost-unreported`), and a reported `0` from a free model is treated as a value,
not as a gap.

---

## 3. Why the pilot could not start before (measured, and now fixed)

Stage 1U's pilot failed with `Error: Model unavailable: opencode/gpt-5.4-mini` in about two seconds per
session. That has now been measured rather than guessed, with no model call:

| Probe (all read-only, zero cost) | Private server (`--standalone`) | Background service |
| --- | --- | --- |
| `api model.list` catalogue size | **0 models** | **42 models** |
| `opencode/gpt-5.4-mini` listed | no | **yes** |
| same, with the developer's full runtime store copied into the isolated data home | **still 0 models** | — |
| same, with the isolated config home only (shared store) | **still 0 models** | — |
| `auth list --standalone`, isolated homes | no authenticated integration | credential present |

Conclusions, each from a command above:

1. The model identifier was never wrong. `opencode/gpt-5.4-mini` is offered, active and priced.
2. The environment variables *are* honoured on Windows (`debug paths` puts config, data, log and the
   database under the isolated homes), so the earlier "isolation is not honoured" reading was wrong.
3. The private server reports an **empty model catalogue regardless of the credential store**. The
   account-scoped catalogue is produced by the already-running background service. Copying the store —
   including the two stored credentials, which `auth list --standalone` does see — does not change that.
4. Therefore the arm driver's `run --standalone` could not resolve any Console model, and the failure
   looked like a bad model id while being a runtime-selection fact.

---

## 4. What the pilot will actually use

`--runtime service` — the arm session runs on the running background service, which is the only runtime
here that holds the account catalogue. The trade this makes, stated plainly:

- **Kept:** a fresh copy of the task repository per arm run, one session per arm run, the same plugin in
  both arms, the only experimental difference being the Safe Mode switch, independent grading against
  pristine tests, content-free evidence, and a reported cost per session.
- **Given up:** the arm is no longer hermetic against the developer's global runtime configuration and
  plugins. Both arms see exactly the same environment, so a paired comparison is still apples-to-apples,
  but the run describes *this installation*, not a pristine one.
- **Compensating control:** in service mode the arm's switch and its summary destination are written into
  the repository-local plugin file as explicit options (`safeMode`, `sink`), so nothing depends on the
  service inheriting the driver's environment. The artifact records `runtimeMode` and a note saying which
  isolation applied.

Guards now running before any session starts: `--approve-live`; `--model` named; the CLI present; plan
size within `--max-runs`; **a per-session bound and a total bound, in units or in reported dollars** (a
run with neither is refused, because nothing about it could be stopped); a pilot below the design's
minimum samples must be explicitly labelled; and the selected runtime must report a catalogue that
**lists the requested model** — the private server, by measurement, never will on this installation.
Each cap accepts the literal `none`, so removing a bound is deliberate: a typo is an error, not a silent
opt-out.

**Isolation is now proven, not assumed.** The probe asks the runtime for its own directories
(`debug paths`) twice — with the overrides and without them — requires that the isolated answer fall
inside the directories the harness created, requires that the unisolated control differ (otherwise the
check cannot distinguish anything), requires that the private server have written its own store inside
the isolated data home, and asks the private server which **configuration sources it actually loads**
(`config.get` over a server call) and requires every one of them to live inside the isolated directory.
Measured on this machine: with the overrides, `config` and `data` resolve to `…\iso\config\opencode`
and `…\iso\data\opencode`; without them, to `C:\Users\<user>\.config\opencode` and
`C:\Users\<user>\.local\share\opencode`; the private server's `opencode.db` is created inside the
isolated home; and it reports one configuration source, the isolated directory — while the background
service reports the developer's `opencode.jsonc`. The same assertions are part of the wire-regression
gate, where a deliberately wrong expectation was shown to fail the check on demand.

One trap is documented rather than repeated: `opencode debug config` takes no `--standalone`, so the
background service answers it and it reports the developer's own config file *even when the private
server is correctly isolated*. Reading that answer as evidence of a broken override is what made the
earlier "this platform ignores XDG" conclusion; the proof above asks the server instead.

Because this pilot selects `--runtime service`, the preflight reports isolation as **NOT APPLICABLE**
for it rather than claiming a private home it does not get.

---

## 5. The exact command to authorize

> **Run the canary first.** The two-session canary in
> [LEVEL2_CANARY_PREP.md](LEVEL2_CANARY_PREP.md) verifies the live path (a real session starts, the
> repository-local plugin is loaded, the paired comparison runs) for about a dollar before these six
> sessions are authorized.

```sh
npm run level2 -- --live --approve-live \
  --model opencode/gpt-5.4-mini \
  --runtime service \
  --task repeated-reads-catalogue --pairs 3 \
  --max-runs 6 --timeout-ms 600000 \
  --max-units-per-run 1500000 --max-units 6000000 \
  --max-cost-usd-per-run 0.50 --max-cost-usd 2.00
```

What it does, in order: (1) probes both runtimes read-only and prints the catalogue counts, the price
row and a verdict; (2) refuses to start if `service` does not list the model; (3) runs 6 sessions, each
in a fresh repository copy, alternating ABBA across the three pairs; (4) grades each session against
pristine tests; (5) stops before the next session if a cap is broken, or immediately if the runtime
refuses the model; (6) writes `benchmarks/reports/level2/level2-live-<timestamp>.md` and `.json` plus a
usage and spend summary.

Preview it first, at zero cost:

```sh
npm run level2 -- --preflight --task repeated-reads-catalogue --pairs 3 \
  --model opencode/gpt-5.4-mini --runtime service
```

Filtered out of the defaults: the defaults are a 10-session safety net (3M units / $1.00 per session,
30M units / $10.00 total); the command above deliberately applies the tighter pilot caps from §2.

---

## 6. Uncertainty that remains

1. **Settlement vs list price.** The caps bound *reported* cost at the runtime's own list prices.
   Whether the Console account settles in cash, credits or a plan quota is not observable here, so a
   dollar cap is the closest available proxy for the money that actually moves.
2. **Cost must be reported.** If a session reports no cost, the run stops (`cost-unreported`). If it
   reports no token field either, the unit cap cannot see it and the report says so explicitly rather
   than implying zero.
3. **The request prefix is unmeasured until the first session.** The estimate in §2 rests on an assumed
   prefix size; the per-session cap is what makes that safe.
4. **Service mode cannot be rehearsed offline.** The scripted rehearsal needs a loopback provider, which
   only the private server can be pointed at. So the pilot's *first* session is also the verification of
   the live path — with the mitigation that a model the runtime refuses costs nothing (that is exactly
   what Stage 1U measured).
5. **Byte-level wire evidence is not available live.** On a real provider the outbound body reaches the
   plugin as a stream, so no request length or marker count is claimed; the mechanism evidence is the
   apply counters in the observer's summary. Confirming the elision *on the wire* stays a loopback
   experiment (`--rehearse`).
6. **The pilot is below the design's minimum samples.** One task, three pairs, 6 sessions is a
   plumbing-and-direction check. It cannot support a conclusion about tokens or correctness overall, and
   the report is labelled incomplete for that reason.
7. **The catalogue probe has one transient failure mode.** An empty catalogue is reported as `BLOCKED`
   (fail closed). If the service is momentarily busy the probe can read empty; re-running `--preflight`
   settles it, and nothing is spent in either case.
8. **Retries are not automatic.** The harness has no retry loop, so nothing re-runs a failed session on
   its own; a retry is an operator decision, and it is a *fresh session* that the caps count like any
   other — the budget is per experiment, not per attempt. A test asserts that a second attempt of the
   same run accumulates against both the unit and the spending totals.
9. **A refusal is distinguishable from a bad identifier.** The preflight reports `no-catalogue` (this
   runtime holds no account state, so *no* model could resolve) separately from `model-not-listed` (the
   catalogue is present and the identifier or its provider is wrong). Stage 1U's pilot reported the
   second error text for the first cause.

---

## 7. What stays suppressed

No savings claim is made or implied by this pilot, whatever it reports: the elision counters describe
bytes removed from an assembled request, and the framework's rule (per-field values are never summed,
overlapping token fields are never added into a "total") is unchanged. The 36-session experiment is not
part of this authorization.
