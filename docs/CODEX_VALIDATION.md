# Codex runtime validation report (Stage 1M)

**Scope:** prove whether the observation-only Codex adapter actually runs during a real Codex
session — not merely whether Codex recognises its hook configuration.
**Date:** 2026-10-11 · **Runtime:** `codex-cli 0.162.0-alpha.17.2` (Codex Desktop bundle) ·
**Adapter revision:** `@dr-token/codex-observer` `0.0.0`
**Related:** [docs/CODEX_OBSERVER.md](CODEX_OBSERVER.md) · [docs/CODEX_FEASIBILITY.md](CODEX_FEASIBILITY.md) ·
[docs/adr/0002-codex-integration.md](adr/0002-codex-integration.md)

> **Headline:** hook **delivery is now runtime-verified** — `SessionStart`, `UserPromptSubmit` and
> `SessionEnd` fired for real and were observed, with their true payload shapes captured. **Tool
> hooks (`PreToolUse`/`PostToolUse`) remain unverified**, because the one authorized turn failed at
> the account's usage limit before the model ran, so no tool executed. Two real defects were found and
> fixed along the way.
>
> **Stage 1N (§13)** re-confirmed everything that needs no model call — hook trust, authentication,
> the timeout contract, the pinned revision — found the account **still rate-limited until
> 01:32:37**, and prepared a self-verifying procedure for the tool-hook turn. That turn is still
> outstanding; this document does not claim it happened.

---

## 1. Evidence vocabulary

| Classification | Meaning |
| --- | --- |
| **Runtime-verified** | Observed by executing the installed Codex binary against a disposable `CODEX_HOME`, in this stage. |
| **Automated-tested** | Covered by Dr. Token's own tests, including tests that spawn the real hook entry point as a process. |
| **Contract-confirmed** | Stated by OpenAI's documentation or present in the published schema; not executed here. |
| **Blocked** | Not obtainable in this stage for an external reason, with the reason recorded. |
| **Unverified** | Not established by any of the above. Never a claim of support. |

---

## 2. Environment

| Item | Value |
| --- | --- |
| Runtime | `codex-cli 0.162.0-alpha.17.2`, `C:\Users\adeep\AppData\Local\OpenAI\Codex\bin\2e5e00daee91c61d\codex.exe` |
| `hooks` feature flag | `stable`, enabled by default (`codex features list`) — no config change needed to enable hooks |
| Disposable Codex home | `%LOCALAPPDATA%\dr-token-stage1m\home` (its own `hooks.json`; the user's `%USERPROFILE%\.codex` was never written) |
| Synthetic project | `%LOCALAPPDATA%\dr-token-stage1m\proj` — `README.md`, `notes.md`, `src/math.ts`, `src/index.ts`, `package.json` |
| Observer state | `%LOCALAPPDATA%\dr-token-stage1m\state\live` (via `DR_TOKEN_CODEX_STATE_DIR`) |
| Summary sink | `%LOCALAPPDATA%\dr-token-stage1m\evidence\live-summary.jsonl` (via `DR_TOKEN_OBSERVER_SUMMARY_FILE`) |
| Evidence tap | `%LOCALAPPDATA%\dr-token-stage1m\evidence\shapes.jsonl` |
| Node | `C:\Program Files\nodejs\node.exe` (on `PATH`, so a bare `node` hook command resolves) |

**Isolation is proven, not assumed.** Four independent checks:

1. Codex's own diagnostics named the disposable configuration
   (`…\dr-token-stage1m\home\hooks.json`), and `hooks/list` reported `source: "user"` for every
   discovered handler — so the hooks that fired came from the disposable home.
2. Both sessions' rollouts were written to `…\dr-token-stage1m\home\sessions\2026\10\11\`, not to the
   user's session store.
3. Hook trust landed in the disposable home's own `config.toml` as
   `[hooks.state.'<hooks.json path>:<event>:<group>:<handler>'] trusted_hash = "sha256:…"` — the trust
   record format also confirms the documented `source:event:group_index:handler_index` key shape.
4. The user's `%USERPROFILE%\.codex` was sampled before and after `codex features list`, an app-server
   `hooks/list` run, and a full `codex exec` rejection path: **its file mtimes never moved**, while the
   same invocations wrote their own `logs_2.sqlite` and `models_cache.json` **inside the disposable
   home**. (Two files in the user's home did change during the window — its log database and model
   cache — and those belong to the running Codex Desktop app, which owns that home; idle sampling and
   the attributable tests above rule out Dr. Token's runs as the cause.)

The user's existing plugins, MCP servers and `notify` program were not read or modified, and no
project of the user's was opened.

---

## 3. Trust: the official review flow, performed by the user

1. Devices sign-in for the disposable home (`codex login --device-auth`) — no credential file was
   copied from the user's home into the test environment.
2. The user reviewed the hooks themselves through Codex's documented `/hooks` browser. Dr. Token
   supplied an inventory first (12 events, **exactly 2 distinct commands**, no `async`, no
   unrecognised command, plus SHA-256 of `hooks.json`, `dist/entry.js` and the tap) so the review had
   something auditable to check against.
3. `--dangerously-bypass-hook-trust` was **never** used, at any point, by anyone.

`hooks/list` after the review: **24/24 handlers `trusted`, 24/24 `enabled`, 24 distinct definition
hashes.** No handler was left untrusted.

**Trust survived a configuration change.** Fixing the timeout defect (§6) altered the `SessionEnd`
and `Interrupt` definitions, and `hooks/list` still reported all 24 as `trusted` — consistent with
trust being recorded against the normalised handler command rather than every field. Recorded as a
useful verified detail, not as a guarantee: re-check trust after any change to a hook's command.

---

## 4. Hook delivery: what actually fired

One authorized turn was started:

```bash
CODEX_HOME=<disposable home> \
DR_TOKEN_CODEX_STATE_DIR=<isolated state> \
DR_TOKEN_OBSERVER_SUMMARY_FILE=<isolated summary> \
codex.exe exec --skip-git-repo-check -C <synthetic project> -s workspace-write --json \
  "Read notes.md twice … then add a multiply(a, b) helper to src/math.ts."
```

| Hook | Fired? | Evidence |
| --- | --- | --- |
| `SessionStart` | ✅ **Yes** | tap record + `counts.sessionStarts: 1` |
| `UserPromptSubmit` | ✅ **Yes** | tap record + `counts.promptsSubmitted: 1` |
| `SessionEnd` | ✅ **Yes** | tap record, summary written, state released, `counts.sessionEnds: 1` |
| `PreToolUse` | ❌ **Not exercised** | no tool executed (see §8) |
| `PostToolUse` | ❌ **Not exercised** | no tool executed (see §8) |
| `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt` | ❌ **Not exercised** | not triggered by a turn that failed before the model ran |

Additional delivery facts observed:

- Both handlers (observer **and** evidence tap) fired for every event, i.e. multiple handlers on one
  event both run.
- `SessionEnd` **still fired after the turn failed** — a failed turn still ends the session.
- The observer's summary accounts for exactly what the tap saw:
  `hookEventsObserved: 3` = `journal.records: 3`, `sessionId: 01a1272d-aa31-7ed0-83fd-5af4f05c47ee`
  (the host's own thread id), `sessionIdentity: "reported"`.
- **No hook-produced output reached the session event stream.** In the first attempt the only
  Dr. Token–related messages were Codex's *own* configuration diagnostics (§6); after the fix, none at
  all. Nothing from `entry.js` was surfaced, consistent with the entry point writing nothing to stdout
  on any path.
- **Delivery is reproducible.** A second attempt (see §8) produced the same three hooks with the same
  payload keys and the same stdin sizes (403 B / 625 B / 339 B), the same `directoryHash`, and the same
  `hookEventsObserved` = `journal.records` invariant.

---

## 5. Real payload shapes (measured)

Recorded by the shape-only tap; content fields appear as type/length, path-like fields as a
SHA-256[0:16] digest. **No prompt text, file content or tool response was written anywhere.**

| Field | `SessionStart` | `UserPromptSubmit` | `SessionEnd` | Notes |
| --- | --- | --- | --- | --- |
| envelope | `flat` | `flat` | `flat` | the documented single flat object on stdin |
| `hook_event_name` | `SessionStart` | `UserPromptSubmit` | `SessionEnd` | **PascalCase in the payload**, even though `hooks/list` reports camelCase event names |
| `session_id` | UUID | UUID | UUID | 36 characters, identifier-shaped → retained |
| `turn_id` | — | UUID | — | present only on turn-scoped events |
| `cwd` | string | string | string | Windows path with backslashes → hashed, never stored |
| `transcript_path` | string (len 141) | same | same | **populated in the CLI runtime** |
| `model` | `gpt-6.1-sol` | `gpt-6.1-sol` | — | an identifier-shaped name → retained in memory only |
| `permission_mode` | `bypassPermissions` | `bypassPermissions` | — | not persisted by the adapter |
| `source` | `startup` | — | — | matches the documented enum |
| `prompt` | — | string (len 176) | — | presence only; text never recorded |
| `reason` | — | — | `other` | matches the documented constant |
| stdin size | 403 B | 625 B | 339 B | all far below the adapter's 1 MiB bound |

**Cross-check that the live path uses the same identity code as the tests:** the live `cwd` produced
`project.directoryHash = 88fdd9781cdfa34e`, which is byte-identical to the digest the
no-model-call replay of the same project directory produced — so the live payload genuinely flowed
through `normalizePath` + `sha256[0:16]`, not through a different code path.

---

## 6. Defects found, fixed and verified

### 6.1 `hookEventsObserved` was always reported as 0 (fixed)

The per-session counter was declared, persisted, folded from snapshots and reported in every summary,
but **nothing ever incremented it**: a session with 11 folded records reported
`hookEventsObserved: 0` while `journal.records: 11`. For an adapter whose entire value is honest
accounting, that is a correctness defect, not a cosmetic one.

- Fix: increment once per folded record in `applyRecord`, and document the invariant in
  `CodexSessionCounts` (`hookEventsObserved` always equals `journal.records`).
- Regression tests: one through the handler and one through the **real entry point as a process**,
  both asserting the counter equals the journal it was folded from and that ignored/unusable events are
  counted too. The live run then reported `hookEventsObserved: 3` with `journal.records: 3`.

### 6.2 Shipped timeouts made Codex emit a diagnostic on every session (fixed)

Codex's own event stream for the run contained, once per affected handler:

```text
# before the fix (one message per affected handler)
clamping SessionEnd hook timeout to 3s in …\dr-token-stage1m\home\hooks.json
clamping Interrupt hook timeout to 3s in …\dr-token-stage1m\home\hooks.json

# after the fix: no such message; the event stream is otherwise identical
```

So **Codex clamps the `SessionEnd` and `Interrupt` hook timeouts to 3 seconds** and reports a
diagnostic for every handler that asks for more. The shipped example configuration asked for 10 and 5,
which meant the plugin politely complained about Dr. Token in every single session — a real
perturbation of host behaviour caused by our own configuration (and, if such items were ever fed back
to the model, a form of context injection Dr. Token must never cause).

- Fix: the example configuration (and the validation prep script) now request **3 seconds** on
  `SessionEnd` and `Interrupt`; every other event keeps 10, which was **not** clamped.
- Regression test: a contract test reads the shipped example configuration and asserts the per-event
  timeout ceiling, so this cannot regress silently.
- Verified twice over: `hooks/list` reports `timeoutSec: 3` for those two events (and 10 for the rest)
  with all 24 handlers still `trusted`; and the **live** event stream of the post-fix attempt contains
  **zero** clamping diagnostics, where the pre-fix attempt contained four `item.completed` errors —
  one per affected handler:

---

## 7. Persistence, concurrency and cleanup

| Behaviour | Result |
| --- | --- |
| Cross-process accumulation | **Automated-tested** (one process per event; a full session is folded at `SessionEnd`) and **runtime-observed** for the 3 delivered events |
| Independent sessions in one state directory | Automated-tested (two sessions, separate journals and summaries) |
| Concurrent writes | Automated-tested: 12 hook processes fired at once into one state directory, no record lost, no corrupt journal |
| Bounded state and compaction | Automated-tested, including a forced compaction and a capacity drop that is *reported* rather than grown |
| `SessionEnd` cleanup | **Runtime-observed**: after the live session's `SessionEnd`, `state/live/sessions` was **empty** — the summary was written and the session's state released |
| State left by a session that never ends | Bounded, swept on a later `SessionStart`, and the sweep is itself bounded (256 entries, one pass) |

---

## 8. The blocker: no tool hooks could be exercised

`codex exec` reached `turn.started` and then failed:

```text
You've hit your usage limit. … try again at 1:32 AM.
```

Type `turn.failed` — **the model never ran**, so no tool was called, so `PreToolUse` and `PostToolUse`
never fired and **no live tool payload, no live read classification and no live repeated-read
observation exists**. This is an account-level usage limit, not a Dr. Token defect, and it is reported
here rather than papered over with the unit-tested payloads.

**Two attempts, same outcome.** The turn was run a second time after the timeout fix: `turn.started`
→ the identical usage-limit error → `turn.failed`, with the same three hooks delivered. The second
attempt therefore cost nothing (no model call happened) and served as the regression check for §6.2.
The account reports quota again at 1:32 AM; the retry needs no code or configuration change.

Consequences, stated precisely:

- **Repeated-read attribution against real Codex reads: BLOCKED.** (What *is* established: the real
  `cwd`/`session_id` shapes flow through the live pipeline correctly, and the classifier + accumulator
  are covered by tests that drive the real entry point with documented payloads.)
- **Tool-hook delivery: UNVERIFIED.** The documentation says these events exist and carry
  `tool_name`/`tool_use_id`/`tool_input`/`tool_response`; that is contract-confirmed and unit-tested,
  but not demonstrated live.
- A retry after the limit resets repeats the identical procedure (§9) with no code change; the
  hooks are already trusted and the configuration is already fixed.

---

## 9. Reproducing this validation

All of it is reproducible; only the single turn in step 4 needs an authorized, unexhausted account.

```bash
BASE="$LOCALAPPDATA/dr-token-stage1m"
PKG="$(pwd)/integrations/codex"          # repository path

# 1) Disposable home + synthetic project (see §2 for the fixture files), then:
node integrations/codex/scripts/codex-prepare-isolated-home.mjs \
  --package "$(cygpath -w "$PKG")" \
  --home "$(cygpath -w "$BASE/home")" \
  --evidence "$(cygpath -w "$BASE/evidence")"

# 2) Registration + trust status (no model call, no account):
CODEX_BIN="$LOCALAPPDATA/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe" \
CODEX_HOME="$(cygpath -w "$BASE/home")" \
PROJECT_DIR="$(cygpath -w "$BASE/proj")" \
node integrations/codex/scripts/codex-registration-check.mjs

# 3) No-model-call end-to-end session through the real entry point:
node integrations/codex/scripts/codex-simulate-hook-session.mjs \
  --package "$(cygpath -w "$PKG")" \
  --state "$(cygpath -w "$BASE/state/simulated")" \
  --summary "$(cygpath -w "$BASE/evidence/simulated-summary.jsonl")" \
  --project "$(cygpath -w "$BASE/proj")"

# 4) The one authorized turn (needs the trusted hooks and an account with quota):
cd "$BASE/proj"
CODEX_HOME="$(cygpath -w "$BASE/home")" \
DR_TOKEN_CODEX_STATE_DIR="$(cygpath -w "$BASE/state/live")" \
DR_TOKEN_OBSERVER_SUMMARY_FILE="$(cygpath -w "$BASE/evidence/live-summary.jsonl")" \
"$LOCALAPPDATA/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe" exec \
  --skip-git-repo-check -C "$(cygpath -w "$BASE/proj")" -s workspace-write --json \
  -o "$(cygpath -w "$BASE/evidence/last-message.txt")" \
  "Read notes.md twice … then add a multiply(a, b) helper to src/math.ts."
```

`stdin` must be **detached** (`< /dev/null`): `codex exec` treats a non-TTY stdin as additional prompt
input and waits for EOF, which looks exactly like a hang.

The shape-only tap is a validation aid, not part of the product install; remove its handler from a
real installation if you do not want payload shapes measured.

---

## 10. Centralization of every claim

| Capability | Classification |
| --- | --- |
| Hook registration / discovery of the shipped configuration (12 events, 24 handlers) | **Runtime-verified** |
| Hook trust review and `trustStatus: "trusted"` for all handlers | **Runtime-verified** |
| `SessionStart`, `UserPromptSubmit`, `SessionEnd` delivery | **Runtime-verified** |
| Flat stdin envelope; PascalCase `hook_event_name`; UUID `session_id`; `turn_id` on turn-scoped events; `transcript_path` populated; `source`/`reason` enums | **Runtime-verified** |
| `SessionEnd` and `Interrupt` hook timeout clamped to 3 s, reported as a session diagnostic — and *satisfied* by the corrected configuration (no diagnostic) | **Runtime-verified** |
| `SessionEnd` releases session state; summary written to the configured sink | **Runtime-verified** |
| Multiple handlers on one event all run | **Runtime-verified** |
| Lifecycle handling, read classification, repeated-read arithmetic, bounds, compaction, concurrency, privacy, fail-open, disable switch | **Automated-tested** (real entry point spawned as a process) |
| `PreToolUse` / `PostToolUse` delivery, live tool payloads, live read identification | **Blocked** (account usage limit hit before the model ran) |
| `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`/`Stop`, `Stop`, `Interrupt` delivery | **Unverified** (not triggered) |
| Token/cost observation | **Unsupported** — no hook payload carries usage; nothing is derived from text length |
| Codex Desktop app hook execution | **Unverified** — left out of scope by explicit decision; the Desktop app's configuration was not modified |
| Any optimization, tool-result replacement, context injection | **Not implemented** — the entry point writes no stdout and always exits 0 |

---

## 11. Privacy audit (live run)

Every file the live run wrote was swept for content:

| Checked | Result |
| --- | --- |
| Summary file, journal, tap records | no prompt text, no file contents, no tool response text, no absolute paths, no credentials |
| Path-like fields | digests + lengths only (`cwd`, `transcript_path`) |
| Session identity | the host's thread id (opaque, sanitized), plus `cwd` as a hash |
| Writes outside the disposable environment | none; the repository stayed clean and the user's Codex home untouched |
| Usage numbers | none reported — every usage measurement is `unavailable` with the verified future sources named |

---

## 12. Limitations of this report

1. **Tool hooks are unverified** (§8) and remain the single most important gap.
2. **One turn only.** No disabled-vs-enabled behavioural comparison was run, so output neutrality rests
   on construction (no stdout on any path, always exit 0, asserted in tests) plus the observation that
   no hook output reached the session stream — not on a controlled A/B run.
3. **Desktop app untested** by choice.
4. **`permission_mode: bypassPermissions`** was reported by `exec` mode; whether other modes report a
   different value is unverified, and the adapter does not persist it either way.
5. **Version scope:** all of this is `0.162.0-alpha.17.2`; the `alpha` line warns that schemas move.
6. **Two attempts were made, both ended at the account usage limit**, so the record of "a turn ran"
   means "Codex started a turn, ran the lifecycle hooks and then refused the model call" — never "a
   model answered".

---

## 13. Stage 1N — status, pinned revision and the operator procedure

Stage 1N was asked to finish live tool-hook validation. It **could not**: the account's usage
allowance is exhausted, and the user chose to trigger the turn themselves later. This section records
what was re-verified without a model call, the exact revision being validated, and the procedure that
produces conclusive evidence when the turn does run.

### 13.1 Re-verified without a model call

| Check | Result |
| --- | --- |
| Runtime version | `codex-cli 0.162.0-alpha.17.2` (unchanged) |
| Hook discovery | 24 handlers, 12 events, **2 distinct commands**, 24 distinct hashes |
| Trust | **24/24 `trusted`**, 24/24 `enabled`, 0 managed — re-read, not modified; `config.toml` holds 24 `trusted_hash` entries |
| Effective timeouts | `sessionEnd: 3`, `interrupt: 3`, everything else `10` — the §6.2 fix is still in place |
| Authentication | **still valid** (`Logged in using ChatGPT`) — no device login was repeated, no credential was copied |
| Repository | `main`; **Stage 1M uncommitted** by the user's decision, so the revision is pinned by hash instead (§13.2) |
| Test suite | 459 tests pass, typecheck/build/verify/benchmark all exit 0 (see the Stage 1M §J numbers in the completion report) |

### 13.2 Pinned revision (what the turn will exercise)

```text
disposable hooks.json     19eb2e876a5d41582b8386bcb009661f3cb44437e54f6abd2c02c3d41042bf99
built entry point         ed4303d95eabc5f347532a82f4c2b908f8e8f3bd7e77aaa4e1bc16f22b02d3a3
evidence tap              d860d0478e9893bacd408c8007ca2b819ee502756eab5b27f26e93e329e82f43
example config (repo)     e0b0eec2678af1a4803568f53394a270ddbdee6f092c1a04f4c8301a0d826f7c
```

### 13.3 Quota evidence (no model call, no spend)

Read over the documented app-server method `account/rateLimits/read` via
[`codex-usage-check.mjs`](../integrations/codex/scripts/codex-usage-check.mjs), which redacts account
identifiers before printing anything:

```text
ordinaryUsageAllowed : false
plan                 : plus      rateLimitReachedType: rate_limit_reached
primary   (5 h)      : 100% used   resets 2026-10-11 01:32:37 local
secondary (7 d)      : 62% used    resets 2026-10-16 22:56:56 local
credits              : hasCredits=false  balance=0   resetCredits=0
```

This is how the quota was checked *without* resubmitting a rejected turn — the behaviour the brief
requires. A **new model call needs its own authorization**; Stage 1M's permission does not carry over.

### 13.4 The procedure that produces the missing evidence

Run after quota returns, with `stdin` detached (`< /dev/null` — `codex exec` treats a non-TTY stdin as
additional prompt input and waits for EOF, which looks exactly like a hang):

```bash
BASE="$LOCALAPPDATA/dr-token-stage1m"
CODEX="$LOCALAPPDATA/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe"
rm -f "$BASE/evidence/shapes.jsonl" "$BASE/evidence/1n-summary.jsonl"; rm -rf "$BASE/state/1n"
cd "$BASE/proj"

CODEX_HOME="$(cygpath -w "$BASE/home")" \
DR_TOKEN_CODEX_STATE_DIR="$(cygpath -w "$BASE/state/1n")" \
DR_TOKEN_OBSERVER_SUMMARY_FILE="$(cygpath -w "$BASE/evidence/1n-summary.jsonl")" \
"$CODEX" exec --skip-git-repo-check -C "$(cygpath -w "$BASE/proj")" -s workspace-write --json \
  -o "$(cygpath -w "$BASE/evidence/1n-last-message.txt")" \
  "Read notes.md twice: run the file-reading command twice, even if you already know the contents. Then add a multiply(a, b) helper to src/math.ts. Finish with a one-line summary." \
  > "$BASE/evidence/1n-events.jsonl" 2> "$BASE/evidence/1n-stderr.txt" < /dev/null
```

Then judge the evidence mechanically rather than by impression:

```bash
node integrations/codex/scripts/codex-validate-turn-evidence.mjs \
  --evidence "$(cygpath -w "$BASE/evidence")" \
  --events  "$(cygpath -w "$BASE/evidence/1n-events.jsonl")" \
  --state   "$(cygpath -w "$BASE/state/1n")" \
  --summary "$(cygpath -w "$BASE/evidence/1n-summary.jsonl")" \
  --project "$(cygpath -w "$BASE/proj")"
```

`exit 0` = every assertion passed · `exit 2` = a real defect · **`exit 3` = inconclusive (no tool
hooks fired)**. The validator refuses to invent a repeat read: if Codex reads the file once, that
check reports `INCONCLUSIVE`, not a pass.

The validator was itself validated — against the real Stage 1M records *and* against constructed
evidence, so the instrument cannot silently pass nothing:

| Case | Expected | Observed |
| --- | --- | --- |
| Healthy evidence (correlated Pre/Post, consistent summary, state released, clean stream) | `0` PASS | ✅ **0**, 14 checks PASS |
| Fabricated repeat read (summary claims 2 repeats where the fold allows 1) | `2` FAIL | ✅ **2**, invariant check fails |
| Coherent lifecycle-only evidence (no tool hooks) | `3` BLOCKED | ✅ **3**, no failures, three checks `INCONCLUSIVE` |
| Incoherent evidence (tap shows no tools, summary claims one) | `2` FAIL | ✅ **2**, counts-mismatch check fails |
| Session state left behind after `SessionEnd` | `2` FAIL | ✅ **2**, names the leftover file |
| Real Stage 1M **pre-fix** host stream | `2` FAIL | ✅ **2** (caught the timeout-clamp diagnostic) |
| Real Stage 1M **post-fix** host stream | `3` BLOCKED | ✅ **3**, diagnostics check passes |

So `exit 3` genuinely means "this run did not exercise tool hooks", and `exit 2` genuinely means the
evidence contradicts itself or the adapter misbehaved.

### 13.5 What that run will still have to earn

Still **BLOCKED** (not "verified"): `PreToolUse`/`PostToolUse` delivery, real tool identities and
correlation, real `tool_input` argument structure for reads, live read classification, live
repeated-read identification, and any live token/cost figure. Nothing in this document claims them.

---

## 14. Safe logout and disposable-environment cleanup

None of this has been executed — evidence and credentials are left in place until the user approves
cleanup.

1. **Log out of the disposable home only:** `CODEX_HOME="<disposable home>" codex logout`. This removes
   the disposable home's own `auth.json`; the user's real `%USERPROFILE%\.codex` login is untouched.
2. **Remove the disposable environment:** delete `%LOCALAPPDATA%\dr-token-stage1m` (it contains the
   synthetic project, the disposable Codex home with its credentials and trust records, the isolated
   observation state, and all evidence).
3. **The real Codex home was never modified.** Dr. Token added nothing to
   `%USERPROFILE%\.codex` — not `config.toml`, not `hooks.json`, not `notify`, not plugins — so no
   rollback is needed there. The Codex Desktop app kept running against its own home throughout.
4. **Evidence retention:** keep `%LOCALAPPDATA%\dr-token-stage1m\evidence` until the report has been
   reviewed; it is the only copy of the measured payload shapes.
5. **Never printed, never stored by the harness:** authentication tokens, account identifiers and
   credential values. The usage report redacts identifier-shaped fields by construction.
