# Dr. Token — Codex observer (Stage 1L)

**Package:** `@dr-token/codex-observer` (workspace `integrations/codex`)
**Status:** implemented and unit-tested; **observation only** — no optimization
**Target contract:** OpenAI Codex lifecycle hooks, verified against `codex-cli`
**0.162.0-alpha.17.2** (bundled by the Codex desktop app on the development machine)
**Runtime validation (Stage 1M, completed in Stage 1N):** hook **registration, trust, lifecycle and
now tool delivery are runtime-verified** — Codex enumerated all 12 hooks, the user trusted all 24
handlers through Codex's own review, and in the Stage 1N turn **16 hook deliveries** were observed:
`SessionStart`, `UserPromptSubmit`, **`PreToolUse` 6×**, **`PostToolUse` 6×**, `Stop`, `SessionEnd`,
with all six tool calls correlated by `tool_use_id` and one **exact repeated read identified live**
(the evidence validator returned PASS, 14/14). **Token measurement is still not implemented**, and the
**desktop app's** hook execution, the compaction/subagent/permission-request/interrupt paths and the
`tool-argument` read basis remain unverified. Full evidence, defects and reproduction:
[docs/CODEX_VALIDATION.md](CODEX_VALIDATION.md) (§1–§12 for Stage 1M, §13–§14 for Stage 1N).

> Dr. Token must prove it can observe agent activity correctly before attempting to
> optimize it. This stage does the proving for Codex; it does not optimize.

**Related:** [docs/CODEX_FEASIBILITY.md](CODEX_FEASIBILITY.md) (the Stage 1K research this builds on) ·
[docs/adr/0002-codex-integration.md](adr/0002-codex-integration.md) (the architecture decision) ·
[docs/OPENCODE_OBSERVER.md](OPENCODE_OBSERVER.md) (the sibling adapter for OpenCode)

---

## 1. What this is, and what it is not

The adapter is a small **Codex hook program** that records what an agent did:

- how many lifecycle events fired, of which kinds (`SessionStart`, prompts, tool calls, permission
  requests, compaction, subagents, `Stop`, `Interrupt`, `SessionEnd`)
- which tools ran, how often they started and completed, and how many completions correlated with a
  recorded start
- which file reads were requested, and which of those repeated an identical
  (file identity, offset, limit) key
- which session and working directory an observation belongs to — the directory only as a one-way hash

It is **not** an optimizer. It contains no Safe, Aggressive or Balanced mode, no read suppression, no
content cache, no context compression, no prompt rewriting and no modification of tool output.

**It cannot influence Codex, by construction.** Its entry point writes nothing to stdout — the channel
through which a Codex hook can inject context, rewrite tool arguments or deny a call — and it always
exits 0, so it can never block a tool or reject a prompt. A test spawns the real entry point and asserts
an empty stdout for every payload class, including malformed ones.

It also does not claim savings. Detecting a repeated read is *not* evidence that a token was saved; the
summary's own notes say so.

### Explicitly out of scope

Safe/Aggressive/Balanced algorithms · read suppression · source-content caching · context compression ·
prompt or tool-result transformation · token/cost measurement · a desktop dashboard · any change to the
user's Codex configuration.

---

## 2. Installation and configuration

Dr. Token never writes your Codex configuration. Installation is a manual, reviewable merge.

### 2.1 Prepare the hook program

```bash
npm run build --workspace @dr-token/codex-observer
# the hook program is now integrations/codex/dist/entry.js
```

### 2.2 Merge the hook configuration

`integrations/codex/codex-hooks.example.json` is a complete, reviewable configuration. Replace the
`<DR-TOKEN-PACKAGE>` placeholder with the absolute path of `integrations/codex`, then merge the file
into one of the documented hook locations:

| Location | Scope | Notes |
| --- | --- | --- |
| `%USERPROFILE%\.codex\hooks.json` | all your Codex sessions | source reported as `user` |
| `%USERPROFILE%\.codex\config.toml` (`[hooks]` tables) | same | equivalent inline form |
| `<repo>\.codex\hooks.json` | that repository | loads only when the project layer is trusted |
| a plugin's `hooks/hooks.json` | that plugin | plugin-bundled hooks need the same trust review |

Every handler in the example uses `type: "command"` and the same read-only entry point, with
`commandWindows` provided for the Windows form. No handler sets `async`, because an observer that
returns nothing has nothing to gain from racing the turn.

**Timeouts are deliberately small.** Codex **clamps the `SessionEnd` and `Interrupt` hook timeouts to
3 seconds** and emits a session diagnostic for every handler that asks for more (runtime-verified in
Stage 1M — the noise appeared once per handler until this was fixed). The example therefore requests
3 seconds on those two events and 10 elsewhere; no other event was clamped at 10. Do not raise them.

### 2.3 Environment switches

| Variable | Effect |
| --- | --- |
| `DR_TOKEN_CODEX_OBSERVER` | `off` / `false` / `0` / `no` / `disabled` disables observation entirely. Unset means enabled. |
| `DR_TOKEN_OBSERVER_SUMMARY_FILE` | Opt-in JSON Lines summary file. **Unset means the adapter writes no summary anywhere.** The same variable the OpenCode adapter uses, so both feed one evidence stream. |
| `DR_TOKEN_CODEX_STATE_DIR` | Overrides where cross-process observation state lives. Default: `<temp>/dr-token-codex-observer`. |
| `DR_TOKEN_CODEX_DEBUG` | `1`/`on`/`true`/`yes` writes bounded, content-free diagnostics to **stderr** only. |

Nothing is written into your Codex home, your repositories or the network.

---

## 3. Required trust approval

Codex requires non-managed hooks to be **reviewed and trusted before they run**, and it records trust
against the hash of the exact hook definition. Dr. Token keeps that requirement intact:

- the Stage 1L registration check confirmed Codex reports Dr. Token's hooks as
  `trustStatus: "untrusted"` and `enabled: true` — discovered, reviewed, not yet trusted;
- in Stage 1M the user reviewed and trusted them through that flow, after which `hooks/list` reported
  **all 24 handlers `trusted` and `enabled`**, and delivery was confirmed live (see §10);
- trust is granted by you, through Codex's own flow (`/hooks` in the CLI, or your plugin installer);
- **Dr. Token never uses `--dangerously-bypass-hook-trust`**, and the adapter never asks for it. That
  flag exists in Codex and is deliberately not part of any Dr. Token procedure or product path;
- managed deployments can pin the hooks through `requirements.toml` (`managed_dir` /
  `windows_managed_dir`) as Codex documents — that is an administrator decision, not something this
  adapter performs.

The hash also means an upgrade that changes the hook definition invalidates the trust and Codex will
ask for review again. That is intended: the adapter's *hook configuration* changes only when this
document says so. (Observed in Stage 1M: correcting only the `SessionEnd`/`Interrupt` timeouts did
**not** invalidate trust in `0.162.0-alpha.17.2`. Treat that as luck rather than a rule — re-check
`hooks/list` after any edit, and never assume a trusted hook is still trusted because it looks the
same.)

---

## 4. Supported hooks and what is recorded

Exactly the twelve documented lifecycle events are registered. For each, the adapter records the
counters listed; **no payload content is ever stored**.

| Hook | Recorded | Never recorded |
| --- | --- | --- |
| `SessionStart` | count, `source` (`startup`/`resume`/`clear`/`compact`), one-way hash of `cwd` | the directory itself |
| `UserPromptSubmit` | count, presence of a prompt | the prompt text |
| `PreToolUse` | tool start count, tool name, tool-call id, and a read identity when one is derivable | `tool_input` content |
| `PermissionRequest` | count, tool name | `tool_input` content |
| `PostToolUse` | completion count, correlation with a recorded start, JSON *kind* of the response | `tool_response` content |
| `PreCompact` / `PostCompact` | counts, `trigger` (`manual`/`auto`) | — |
| `SubagentStart` / `SubagentStop` | counts, `agent_type` | subagent transcripts |
| `Stop` | count, `stop_hook_active` | `last_assistant_message` |
| `Interrupt` | count | — |
| `SessionEnd` | count, then the session summary is written (if a sink is configured) and the session's state is released | `reason` beyond the documented constant |
| any other event name | an `ignored` counter | the event name's text |

Nothing the adapter records can be returned to Codex: the entry point's only output channel is stderr  diagnostics under `DR_TOKEN_CODEX_DEBUG`. The live run confirmed this on the host side: no hook
produced any message in the session event stream (see §7).

**Runtime-verified delivery (Stages 1M and 1N).** In real sessions, `SessionStart`, `UserPromptSubmit`,
`Stop`, `SessionEnd` **and** `PreToolUse`/`PostToolUse` (6× each in Stage 1N) reached the adapter. The
measured payloads are a **flat** JSON object with a **PascalCase** `hook_event_name` (Codex's
`hooks/list` reports event names in camelCase), a UUID `session_id`, a `turn_id` on turn-scoped events,
a populated `transcript_path`, `cwd`, `model`, `permission_mode`, the tool fields (`tool_name`,
`tool_use_id`, `tool_input`, `tool_response`) and the documented `source`/`reason` enums — all fields the
adapter already handled. `SessionEnd` also arrives when a turn **fails**, and several handlers on one
event all run. Two live shape findings: **tool input arrives as `{command}` for both `Bash` and
`apply_patch`**, and `permission_mode` is present on tool events (`bypassPermissions`) and `null`
elsewhere — a host-reported label Dr. Token neither sets nor changes ([CODEX_VALIDATION.md](CODEX_VALIDATION.md) §14.4, §14.6).

---

## 5. Session and project attribution

- **Session identity comes only from the host.** `session_id` is accepted when it is
  identifier-shaped (bounded length, no whitespace, no control characters, no path separators); every
  other value is treated as *not reported*. A hostile or oversized id cannot become a file name or a
  summary field.
- **Events with no usable session id are not guessed into a session.** They are recorded under an
  explicit `__unattributed__` key, and their summary is reported with `sessionId: "unknown"`,
  `sessionIdentity: "unknown"` and a note saying so.
- Two sessions sharing one state directory stay independent: separate journals, separate counters,
  separate summaries, and each `SessionEnd` releases only its own state.
- **Project attribution is deliberately weak.** Codex hook payloads declare a working directory and no
  project identity, and every hook is a separate process with no instance-level project to compare
  against — so `verification` is always `unverifiable`. The directory is recorded **only as a one-way
  hash** of its normalized form, which is enough to tell two directories apart and nothing more.

---

## 6. Read identification

Codex has no built-in `read` tool, so a read is recognized in exactly two ways:

1. **A read tool call** — an MCP or other function tool whose name is a read tool
   (`mcp__filesystem__read_file`, `read_file`, `read_text_file`, …) with a path-like argument
   (`path`, `filePath`, `file_path`, `filename`, `file`) → identity basis `tool-argument`.
2. **A shell read** — a `Bash`/`exec_command` command that is unambiguously a *single literal file
   read*: `cat`, `type`, `head`, `tail`, `more`, `less`, `Get-Content` with exactly one non-option
   operand → identity basis `shell-command`.

Everything else **refuses to be identified**, and the refusal is counted:

| Refusal reason | Meaning |
| --- | --- |
| `missing-path` | a read-like tool carried no usable path |
| `unusable-input` | the call carried range keys this adapter does not model |
| `ambiguous-shell-read` | pipes, redirects, globs, substitution, multiple operands, quoting problems, `~`, or a non-reader command |

**Identity scheme:** `sha256(normalized path)[0:16] + offset + limit`. Normalization unifies Windows and
POSIX separators and collapses duplicate separators; it deliberately does not resolve symlinks, `..` or
case, because that would need filesystem access and could merge genuinely different targets. An absent
range is recorded as offset `1`, limit `0`, where `0` means *the host reported no limit* — it is not a
claim that the read was whole-file. A request that names a limit therefore never shares an identity with
one that does not.

**Why this is strict rather than clever.** A wrong identity produces a *false* repeated-read
observation, which is worse than a missing one. Every refusal is visible in the summary as
`unidentifiedRequests` plus a note, so a reader can see how much the adapter declined to guess.

**Live status (Stage 1N): the classifier has now seen real reads.** One authorized turn produced
`requests=5`, `identified=2`, `unidentified=3`, `distinctTargets=1`, `repeatedRequests=1` — so an exact
repeated read was identified live, while three read attempts were refused and *counted* rather than
guessed ([validation report](CODEX_VALIDATION.md) §14.5). Still unverified: which read tools a given
session calls, whether any reports ranges, and the `tool-argument` basis — every live tool input was
`{command}`.

---

## 7. Privacy

The adapter's rules, each enforced by the persistence layer rather than by convention:

- **Never persisted:** prompts, tool arguments, tool responses, file contents, transcripts, absolute
  paths, API keys, credentials, account identifiers, Codex configuration values.
- **Persisted per event:** counters, small enums, opaque tool-call and tool names, one-way read and
  directory hashes, timestamps.
- **Reads are identified by hash.** The raw path is used in memory to compute the digest and then
  dropped; the digest is one-way (SHA-256 truncated to 16 hex characters, the same scheme the OpenCode
  adapter uses).
- **The session id is opaque and is stored** (in state and in summaries) because a summary with no
  session identity is useless for debugging; it is sanitized first, and it never becomes a file name —
  file names are digests.
- **Nothing is written unless you opt in** — the state directory holds observation state; a summary
  file is written only when `DR_TOKEN_OBSERVER_SUMMARY_FILE` is set.
- Tests assert the absence of secrets, prompts and absolute paths in every file the adapter writes,
  including the concurrent-write and cross-process cases.

---

## 8. Persistence architecture, and its limits

Codex runs each command hook as its **own short-lived process**, so in-memory session state cannot
survive between events. The adapter therefore keeps a small, bounded, content-free record set on disk
instead of pretending shared memory exists.

```
<state dir>/sessions/<session-digest>.jsonl        append-only journal, one record per event
<state dir>/sessions/<session-digest>.state.json   compacted counters (written atomically)
<state dir>/sessions/<session-digest>.lock         short-lived compaction lock
```

- **Append path (no lock).** Each event appends one line in a single `appendFile` call ending in `\n`.
  Concurrent hook processes cannot deadlock, and a reader that ignores a torn trailing line can never
  see half a record. A transient Windows contention error is retried once; a real failure is reported
  as `state-unavailable` and the tool call proceeds untouched.
- **Compaction (lock, rename-first).** Past a size threshold the journal is **renamed aside first** and
  then folded into the snapshot, so a record appended during the fold lands either in the fresh journal
  or in the sealed file — nothing is silently lost. Only one process can win the rename; a compaction
  that cannot take the lock is skipped and reported (`compaction-skipped`) instead of retried forever.
- **Bounds.** Journal bytes per session, records folded per invocation, distinct read targets, pending
  tool calls, distinct tools, and the swept age of state. When a bound is hit, the adapter **drops
  observations and says so** (`journal-capacity-reached`, plus `journal.atCapacity` and a note in the
  summary) rather than growing without limit.
- **Cleanup.** `SessionEnd` folds the session, writes its summary, and deletes its journal, snapshot
  and lock. A session that dies without ending (crash, kill) leaves state behind until the next
  `SessionStart` sweeps entries older than 24 hours — one bounded pass, at most 256 entries.
- **Windows notes.** Writes use append and same-directory rename (never a cross-volume move); torn
  lines are tolerated on read; a stale lock (older than five seconds) is treated as abandoned by a dead
  process and reclaimed.

**Known limits.** A hook process killed exactly between appending and compacting leaves a slightly
larger journal — harmless, and swept later. `SessionEnd` may run up to 30 minutes after idle, so
state can outlive the turn that produced it; that delay is Codex's, not the adapter's. Diagnostics are
in-memory only (stderr under debug) and are not persisted.

---

## 9. Usage data

**Codex hook payloads carry no token or cost values.** No documented hook field reports input, output,
cache or cost figures, Stage 1L's registration check did not change that, and the payloads measured in
Stage 1M and Stage 1N (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
`SessionEnd`) contained no usage field of any kind. The adapter therefore
reports every usage measurement as `unavailable`, with a note naming the verified sources a future
measurement path could use:

- the app-server `thread/tokenUsage/updated` notification (per-turn `last` + cumulative `total`, with
  cached, cache-write, reasoning and context-window fields),
- rollout `token_count` records under the Codex session store,
- `codex exec --json` `turn.completed.usage`,
- the OpenTelemetry `codex.turn.token_usage` histogram.

**Nothing is derived from text length.** Tool-response text length, prompt length or tool counts are
never presented as tokens. `totalTokens` is always `unavailable`, because Codex's separate fields
overlap and summing them would double count.

Implementing any of those sources is deliberately **not** part of this stage (see §11 and the Stage 1K
adapter boundary). **Stage 1N observed one of them live**: the host's own `codex exec --json` stream
reported `turn.completed.usage` for the authorized turn (`input 60,884 · cached 57,216 · output 362`).
The source is therefore real and measurable — and still **not ingested**, so every token metric stays
`unavailable`. Its classification, attribution and privacy trade-offs are worked out in
[docs/SAFE_MODE_DESIGN.md](SAFE_MODE_DESIGN.md) §7.

---

## 10. Verification status: what was demonstrated

The verification ladder, with each rung's evidence kept separate:

| Rung | Status | Evidence |
| --- | --- | --- |
| **Contract** | ✅ Contract- and runtime-confirmed | Documented hook events/fields quoted in `src/types.ts`; Stage 1K enumerated 174 protocol methods and generated the version-exact schema |
| **Binary/module loading** | ✅ Runtime-verified | `node dist/entry.js` runs under the installed Node; the entry point imports without side effects |
| **Hook registration/discovery** | ✅ **Runtime-verified (Stage 1L)** | In an isolated `CODEX_HOME`, the installed `codex-cli 0.162.0-alpha.17.2` returned all **12 hooks** from `hooks/list`: `handlerType: command`, `enabled: true`, `isManaged: false`, `source: user`, `trustStatus: untrusted`, each command resolving to `dist/entry.js` |
| **Hook trust review** | ✅ **Runtime-verified (Stage 1M)** | The user trusted all 24 handlers via Codex's `/hooks`; `hooks/list` then reported `trustStatus: trusted` for every one, and stayed `trusted` after the timeout correction |
| **Hook execution — lifecycle** | ✅ **Runtime-verified (Stage 1M, extended in 1N)** | `SessionStart`, `UserPromptSubmit`, `Stop` and `SessionEnd` fired in real `codex exec` sessions; payload shapes captured; the Stage 1N session reported `hookEventsObserved: 16` = `journal.records: 16` |
| **Hook execution — tool events** | ✅ **Runtime-verified (Stage 1N)** | `PreToolUse` and `PostToolUse` fired **6× each** in a real turn and correlated **6/6** by `tool_use_id`; `Stop` fired once ([validation report](CODEX_VALIDATION.md) §14) |
| **Tool observation on the live path** | ✅ **Runtime-verified (Stage 1N)** | Live `tool_input` shapes measured (`{command}` for both `Bash` and `apply_patch`); `pendingCalls: 0`, `unusablePayloads: 0` |
| **Live repeated-read identification** | ✅ **Runtime-verified (Stage 1N)** | `requests=5, identified=2, unidentified=3, distinctTargets=1, repeatedRequests=1` — one exact repeat counted live, three refusals counted honestly |
| **Session cleanup and release** | ✅ **Runtime-verified (Stage 1M and 1N)** | After each live session's `SessionEnd`, the isolated state directory contained no session files — the summary had been written and the state released |
| **Privacy of everything written** | ✅ **Runtime-verified (Stage 1M and 1N)** | Every file the live runs wrote was swept: no prompt, file content, tool response, absolute path or credential — path-like fields are digests, and the planted canary appears in none of them |
| **Fail-open containment during a failed turn** | ✅ **Runtime-verified (Stage 1M)** | The turn failed (account usage limit) and every hook still exited 0, wrote nothing to stdout, and left a valid summary |
| **Token measurement** | ❌ Not implemented | No hook carries usage (§9); the host's `exec --json` stream did report per-turn usage in Stage 1N, and it is deliberately not ingested |

Reproduce the registration check (no model call, isolated home, nothing written outside it):

```bash
npm run build --workspace @dr-token/codex-observer

# an isolated home + scratch project; replace <DR-TOKEN-PACKAGE> in the example
mkdir -p "$TEMP/dr-token-codex-check/home" "$TEMP/dr-token-codex-check/proj"
node -e "const fs=require('fs');fs.writeFileSync(process.argv[3],fs.readFileSync(process.argv[2],'utf8').split('<DR-TOKEN-PACKAGE>').join(process.argv[1]))" \
  "$(pwd)/integrations/codex" integrations/codex/codex-hooks.example.json "$TEMP/dr-token-codex-check/home/hooks.json"

CODEX_BIN="<path to codex.exe>" \
CODEX_HOME="$TEMP/dr-token-codex-check/home" \
PROJECT_DIR="$TEMP/dr-token-codex-check/proj" \
node integrations/codex/scripts/codex-registration-check.mjs
```

The script performs the documented `initialize`/`initialized` handshake and calls `hooks/list`; **it
sends no `turn/start`**, so it makes no model request and spends nothing. A `discoveredHookCount` of 12
with `trustStatus: untrusted` means Codex found the hooks and is waiting for your trust review; all
`trusted` means delivery can be tested. The report also carries each handler's effective `timeoutSec`,
so a clamped configuration is visible without starting a session.

Two further no-model-call tools were added in Stage 1M (both are validation aids, not part of the
product install):

```bash
# Generate a disposable CODEX_HOME config with the observer plus a shape-only evidence tap
node integrations/codex/scripts/codex-prepare-isolated-home.mjs \
  --package "$(cygpath -w "$(pwd)/integrations/codex")" \
  --home "$(cygpath -w "$TEMP/dr-token-codex-check/home")" \
  --evidence "$(cygpath -w "$TEMP/dr-token-codex-check/evidence")"

# Replay a documented session through the REAL entry point, one process per event
node integrations/codex/scripts/codex-simulate-hook-session.mjs \
  --package "$(cygpath -w "$(pwd)/integrations/codex")" \
  --state "$(cygpath -w "$TEMP/dr-token-codex-check/state")" \
  --summary "$(cygpath -w "$TEMP/dr-token-codex-check/summary.jsonl")" \
  --project "$(cygpath -w "$TEMP/dr-token-codex-check/proj")"
```

The tap (`codex-evidence-tap.mjs`) records only payload *shapes* — keys, JSON types, lengths and
one-way digests for path-like fields — never prompts, file contents or tool responses. It is an extra
`command` handler that can simply be omitted from a real installation.

---

## 11. Live validation procedure (authorized turn)

**Stages 1M and 1N together completed steps 1, 2 and 3**: the hooks were trusted, and two authorized
turns ran — the first (1M) failed at the account's usage limit before the model ran, the second (1N)
completed and delivered the full tool-hook sequence, with step 3's assertions passing (6 starts, 6
correlated completions, `repeatedRequests: 1`). **Step 4 (fail-open assertions) and step 5 (desktop-app
delivery) are still outstanding**, as is step 6. The exact command sequence — including the
archive-not-delete step that preserves earlier evidence, the planted privacy canary and the mechanical
evidence check — is [CODEX_VALIDATION.md](CODEX_VALIDATION.md) §13.4, and its results are §14. Everything
below uses your Codex account and issues a real model request, so it is scoped so it cannot touch your
Desktop configuration:

1. **Preconditions.** A disposable `CODEX_HOME` (§10), a scratch project, the example hooks merged
   there, and the hooks trusted through Codex's own review (`/hooks` in that home's TUI). No
   `--dangerously-bypass-hook-trust`.
2. **One small turn.** Start the CLI against the scratch project with `CODEX_HOME` pointed at the
   disposable home, and ask for one trivial action that triggers a shell read **twice** (for example
   "read notes.md twice with `cat notes.md`"; `type`, `head`, `tail` and `Get-Content` are recognized
   too). Record: which hooks fired, their input fields, whether `transcript_path` was populated, and how
   long each hook took.
3. **Observation assertions.** The summary must show `sessionStarts: 1`, at least one
   `toolStartsObserved`/`toolCompletionsObserved`, a `correlatedCompletions` count matching, and (for
   two reads of the same file) `repeatedRequests: 1`. A read the adapter refuses appears as
   `unidentifiedRequests`, which is a pass for honesty, not a failure.
4. **Fail-open assertions.** Kill the hook process mid-turn; return malformed JSON; return nothing past
   the timeout. The turn must continue unaffected.
5. **Desktop-app delivery.** Repeat step 2 under the desktop app (the largest open question from Stage
   1K: whether the app executes user-level hooks in the runtime it owns).
6. **Usage provenance (separate stage).** Only after the above, compare `thread/tokenUsage/updated`,
   rollout `token_count` and `exec --json` for the same turn.

**Where this needs you:** steps 2–5 need your Codex account and configuration. That is why they were
left undone rather than approximated — see §13.

---

## 12. Clean removal

Observation can be stopped three ways, in increasing thoroughness:

1. **Pause:** set `DR_TOKEN_CODEX_OBSERVER=off` in the environment Codex runs with. The adapter records
   nothing; hooks still fire and exit immediately.
2. **Disable:** remove Dr. Token's entries from the hook configuration you merged in §2.2 (or disable
   the plugin that bundles them). Codex then does not invoke the adapter at all. If the hooks were
   trusted, removing them also removes the trust record.
3. **Remove:** delete those entries and the built package. To clear any state the adapter left behind
   (for example if a session never ended), delete the state directory — `<temp>/dr-token-codex-observer`
   by default, or whatever `DR_TOKEN_CODEX_STATE_DIR` pointed at — and, if you configured it, the
   summary file.

Dr. Token never modified your `%USERPROFILE%\.codex` — not `config.toml`, not `hooks.json`, not the
`notify` program, not your plugins — so removal is limited to what you added by hand.

**Logging out of a disposable environment.** If you installed the hooks into a throwaway
`CODEX_HOME` (the way the validation does), that home holds its own `auth.json`, its own trust records
in `config.toml`, and its own observation state. To retire it: log out of *that* home only
(`CODEX_HOME="<home>" codex logout`), then delete the home and the state directory (and the summary
file, if you configured one). Your real Codex home and login are never involved. Full step list:
[docs/CODEX_VALIDATION.md](CODEX_VALIDATION.md) §14.

**Judging a real run's evidence.**
[`integrations/codex/scripts/codex-validate-turn-evidence.mjs`](../integrations/codex/scripts/codex-validate-turn-evidence.mjs)
turns one turn's evidence into assertions: tool-hook delivery, tool identity correlation, the
repeated-read arithmetic invariant (`repeatedRequests === identifiedRequests - distinctTargets`, so a
fabricated repeat fails), state release, content privacy, absence of hook configuration diagnostics and
absence of any hook output reaching Codex. It exits `0` when everything holds, `2` on a real defect,
and **`3` when tool hooks did not fire — inconclusive, never a pass.**

---

## 13. Limitations and open questions

1. **Tool hooks are verified; the desktop app is not.** Stage 1N delivered `PreToolUse`/`PostToolUse`
   6× each, correlated every completion, and counted a live repeated read
   ([validation report](CODEX_VALIDATION.md) §14). Still open: the **desktop app's** execution of
   user-level hooks, the `PermissionRequest`/compaction/subagent/interrupt paths, and the
   `tool-argument` read basis (every live tool input was `{command}`). The classifier's conservatism is
   now *measured* rather than expected: 3 of 5 live read attempts were refused and counted as
   `unidentifiedRequests`.
2. **The desktop app is unproven.** Recent Codex documentation supports plugin-bundled hooks for
   manually installed desktop plugins; whether the app executes *user-level* hooks in the runtime it
   owns is unverified. Dr. Token's desktop story rests on this.
3. **Hosted tools are invisible.** Codex documents that hosted tools such as `WebSearch` do not use the
   local function-tool hook path, so they are never observed. The adapter does not pretend otherwise.
4. **Coverage is a guardrail, not an enforcement boundary.** Codex documents that some specialized tool
   paths can opt out of the hook path.
5. **Read identification is conservative.** Shell reads are recognized only in a strict single-file
   form; anything else is counted as unidentified. Expect `unidentifiedRequests > 0` on real sessions,
   especially for `sed`, `rg`, `grep`, pipes and globs.
6. **`SessionEnd` timing is Codex's.** It may arrive up to 30 minutes after idle, so state and summaries
   can lag a session.
7. **A torn or oversized journal degrades to fewer observations**, reported as `journal.atCapacity`
   with a note — never silently.
8. **No usage numbers at all.** `unavailable` is the honest value until a measurement source is
   implemented and its provenance is auditable.
9. **Version drift.** The runtime is an `alpha` build; the documented contract warns that generated
   schemas differ per version. Capability detection is dynamic (`hooks/list`), and the adapter's own
   contract test fails loudly if the vendored contract fixture drifts.
10. **Not yet wired to the shared core.** The adapter records and stops; nothing consumes its summaries
    in the optimizer. That is deliberate for an observation-only stage.

---

## 14. Compatibility matrix

| Surface | Classification | Note |
| --- | --- | --- |
| Lifecycle hook discovery (12 events) | **Runtime-verified** | `hooks/list` in an isolated home, installed `0.162.0-alpha.17.2` |
| Hook command handlers (`command`, `commandWindows`) | Runtime-verified (discovery) / Contract-confirmed (execution) | Separator- and form-level details confirmed by the discovered definition |
| Hook trust requirement | **Runtime-verified** | `untrusted` until the user reviewed the hooks; `trusted` for all 24 handlers afterwards |
| Lifecycle hook delivery (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) | **Runtime-verified (Stage 1M; `Stop` in 1N)** | Fired in real sessions; payload shapes and enums captured |
| `PreToolUse` / `PostToolUse` delivery and correlation | **Runtime-verified (Stage 1N)** | 6 starts and 6 completions, correlated 6/6 by `tool_use_id`; `permission_mode` observed on tool events |
| `SessionEnd`/`Interrupt` timeout ceiling (3 s, reported as a diagnostic) | **Runtime-verified (Stage 1M)** | The diagnostic appeared once per handler before the fix and disappeared afterwards, in otherwise identical sessions |
| Hook stdin payload fields | **Runtime-verified for the three delivered events**; contract-confirmed for the rest | Flat envelope, PascalCase event name, UUID session id, populated `transcript_path` |
| Hook output influence channels | Contract-confirmed, **deliberately unused** | The adapter writes no stdout and no `decision`/`updatedInput`/`additionalContext`; no hook output appeared in the session stream |
| Tool start/completion observation | **Runtime-verified (Stage 1N)** | Live delivery plus the contract-confirmed fields; `tool_input` measured as `{command}` for both the shell and the patch tool |
| Live repeated-read identification | **Runtime-verified (Stage 1N)** | `repeatedRequests: 1`, `distinctTargets: 1`, `unidentifiedRequests: 3` — refusals counted, not guessed |
| Repeated-read detection | Unit-tested | Conservative identity; refusals counted |
| Cross-process persistence | **Unit-tested**, including 12-way concurrent hook processes | Journal + snapshot + sweep |
| Token/cost observation | **Unsupported** | No hook carries usage; nothing is derived |
| Desktop-app hook execution | **Unverified** | Open question 2 |
| Whole-context or provider-request interception | Unsupported (documented limitation) | Not attempted |

Every claim above is either demonstrated or labelled unverified — no capability is claimed from
inference.
