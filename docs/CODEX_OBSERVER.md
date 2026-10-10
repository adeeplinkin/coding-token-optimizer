# Dr. Token — Codex observer (Stage 1L)

**Package:** `@dr-token/codex-observer` (workspace `integrations/codex`)
**Status:** implemented and unit-tested; **observation only** — no optimization
**Target contract:** OpenAI Codex lifecycle hooks, verified against `codex-cli`
**0.162.0-alpha.17.2** (bundled by the Codex desktop app on the development machine)
**Runtime validation:** hook **registration/discovery is runtime-verified** (the installed Codex
enumerates all 12 hooks from Dr. Token's generated configuration — see §10); hook **execution, tool
observation and token measurement are not verified**, because that needs a real Codex turn (see §11).

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
- trust is granted by you, through Codex's own flow (`/hooks` in the CLI, or your plugin installer);
- **Dr. Token never uses `--dangerously-bypass-hook-trust`**, and the adapter never asks for it. That
  flag exists in Codex and is deliberately not part of any Dr. Token procedure or product path;
- managed deployments can pin the hooks through `requirements.toml` (`managed_dir` /
  `windows_managed_dir`) as Codex documents — that is an administrator decision, not something this
  adapter performs.

The hash also means an upgrade that changes the hook definition invalidates the trust and Codex will
ask for review again. That is intended: the adapter's *hook configuration* changes only when this
document says so.

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

Nothing the adapter records can be returned to Codex: the entry point's only output channel is stderr
diagnostics under `DR_TOKEN_CODEX_DEBUG`.

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
`unidentifiedRequests` plus a note, so a reader can see how much the adapter declined to guess. Which
read tools a given session actually calls, and whether any reports ranges, is **not runtime-verified**
until a real turn is observed (§10–§11).

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
cache or cost figures, and Stage 1L's registration check did not change that. The adapter therefore
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
adapter boundary).

---

## 10. Verification status: what was demonstrated

The verification ladder, with each rung's evidence kept separate:

| Rung | Status | Evidence |
| --- | --- | --- |
| **Contract** | ✅ Contract- and runtime-confirmed | Documented hook events/fields quoted in `src/types.ts`; Stage 1K enumerated 174 protocol methods and generated the version-exact schema |
| **Binary/module loading** | ✅ Runtime-verified | `node dist/entry.js` runs under the installed Node; the entry point imports without side effects |
| **Hook registration/discovery** | ✅ **Runtime-verified (Stage 1L)** | In an isolated `CODEX_HOME`, the installed `codex-cli 0.162.0-alpha.17.2` returned all **12 hooks** from `hooks/list`: `handlerType: command`, `enabled: true`, `isManaged: false`, `source: user`, `trustStatus: untrusted`, each command resolving to `dist/entry.js` |
| **Hook execution** | ❌ Not verified | Requires a real turn (`turn/start` or the desktop app); no model call was authorized |
| **Tool observation** | ❌ Not verified | Follows from hook execution; the parser/accumulator behaviour is unit-tested against documented payloads |
| **Token measurement** | ❌ Not implemented | No hook carries usage (§9) |

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
with `trustStatus: untrusted` means Codex found the hooks and is waiting for your trust review.

---

## 11. Live validation procedure (authorized turn)

Everything below is **pending explicit authorization**, because it uses your Codex account and issues a
real model request. It is scoped so it cannot touch your Desktop configuration:

1. **Preconditions.** A disposable `CODEX_HOME` (§10), a scratch project, the example hooks merged
   there, and the hooks trusted through Codex's own review (`/hooks` in that home's TUI). No
   `--dangerously-bypass-hook-trust`.
2. **One small turn.** Start the CLI against the scratch project with `CODEX_HOME` pointed at the
   disposable home, and ask for one trivial action that triggers a shell read (for example, "read
   README.md"). Record: which hooks fired, their input fields, whether `transcript_path` was
   populated, and how long each hook took.
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

---

## 13. Limitations and open questions

1. **Hook execution is unverified.** Registration is proven; firing during a turn is not. Until §11 is
   run, every delivery-dependent claim stays open.
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
| Hook trust requirement | **Runtime-verified** | Reported `trustStatus: untrusted` until reviewed |
| Hook stdin payload fields | Contract-confirmed | Documented fields quoted and vendored in `tests/fixtures` |
| Hook output influence channels | Contract-confirmed, **deliberately unused** | The adapter writes no stdout and no `decision`/`updatedInput`/`additionalContext` |
| Tool start/completion observation | Contract-confirmed; **unit-tested** against documented payloads; delivery unverified | — |
| Repeated-read detection | Unit-tested | Conservative identity; refusals counted |
| Cross-process persistence | **Unit-tested**, including 12-way concurrent hook processes | Journal + snapshot + sweep |
| Token/cost observation | **Unsupported** | No hook carries usage; nothing is derived |
| Desktop-app hook execution | **Unverified** | Open question 2 |
| Whole-context or provider-request interception | Unsupported (documented limitation) | Not attempted |

Every claim above is either demonstrated or labelled unverified — no capability is claimed from
inference.
