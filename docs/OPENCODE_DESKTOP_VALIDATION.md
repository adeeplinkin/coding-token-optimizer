# OpenCode Desktop validation (Stage 1E → Stage 1J)

**Status (Stage 1J, 2026-10-10): ALL THREE V2 LIFECYCLE TRANSITIONS RUNTIME-VALIDATED; TEST HARNESS RETIRED.** The
V2 adapter was loaded by the real OpenCode Desktop 2.0.24 runtime; its tool hooks fired on real tool
executions, it **records the runtime's own token/cost snapshots**, **persists a summary during a
one-shot session**, it **maps `session.created` into a project-verified summary**, **refuses sessions
that declare another project**, and as of Stage 1J it **closes `session.deleted` correctly (final
summary, state release, concurrent sessions untouched)** and **applies a matched `session.moved` with
an updated directory hash**. The disposable harnesses are retired (see §18.6). §1–§14 are the Stage 1E record, kept as written
(they remain accurate for the V1 adapter that stage could not load); **§15 is the Stage 1G live
result**, **§16 is the Stage 1H live result**, **§17 is the Stage 1I live result**, and **§18 is the
Stage 1J live result** (API-driven `session.created`/`session.deleted`/`session.moved`, concurrent
sessions in one server, a persistence audit and the test-environment cleanup). Both document the
zero-cost methods used to obtain them.

**Date:** 2026-10-10 · **Platform:** Windows 11 · **Stage 1D base commit:** `3bb0943` · **Stage 1F commit:** `e7e0f89`

> **Stage 1E headline (historical):** the installed OpenCode Desktop ships **CLI v2.0.24**, which
> implements the **V2** plugin API (`@opencode/plugin`, `ctx.tool.hook(...)`, `ctx.event.subscribe()`),
> so the Stage 1D **V1** adapter could not be loaded. Stage 1F then built a V2 adapter, and Stage 1G
> validated it live — see §15.

> **Headline:** the installed OpenCode Desktop ships **CLI v2.0.24**, which implements the **V2** plugin
> API (`@opencode/plugin`, `ctx.tool.hook(...)`, `ctx.event.subscribe()`). The Stage 1D adapter
> implements the **V1** `Hooks` interface (`@opencode-ai/plugin@1.18.35`). OpenCode's own V2 migration
> guide states that **V1 plugin implementations do not run in V2**, and the entire V1 hook namespace is
> absent from the 2.0.24 runtime. The Stage 1D observer therefore could not be loaded, and §6's
> hook-level checks could not be executed on this installation.

**Nothing in this document is a savings claim or a compatibility claim beyond what the evidence shows.**

---

## 1. Evidence vocabulary

This document keeps five levels strictly apart, as Stage 1E requires.

| Level | Meaning |
| --- | --- |
| **Source-confirmed** | From the published package declarations, official docs, or the shipped binary's own code/strings |
| **Unit-tested** | Covered by the automated suite in this repository |
| **Desktop runtime-tested** | Actually executed against the installed Desktop's own runtime, with observed output |
| **Unverified** | Credible but not confirmed for this install |
| **Failed / blocked** | Directly contradicted or impossible on this install |

## 2. Environment

| Item | Observed value | How it was observed |
| --- | --- | --- |
| OS | Windows 11 | This environment |
| Desktop application | **OpenCode 2.0.24** (publisher: OpenCode) | `HKCU\...\Uninstall` entry `DisplayName` |
| Desktop install path | `%LOCALAPPDATA%\Programs\@opencodedesktop\` | Registry `DisplayIcon`, directory listing |
| Desktop shell | **Electron** (`LICENSE.electron.txt`, `chrome_*.pak`, `ffmpeg.dll`, `locales/`) | Directory listing |
| Bundled CLI runtime | `%APPDATA%\ai.opencode.desktop\cli\2.0.24\opencode-cli.exe` (197 MB, single file) | Running-process path + `ls` |
| CLI version | **`opencode v2.0.24`** | `opencode-cli.exe --version` (exit 0) |
| Desktop app data | `%APPDATA%\ai.opencode.desktop\` | Running-process path |
| Updater | `%LOCALAPPDATA%\@opencodedesktop-updater\` | Directory listing |
| Config / data / log dirs | config `~\.config\opencode`, data `~\.local\share\opencode`, log `~\.local\share\opencode\log` | `opencode debug paths` |
| No CLI on `PATH` | confirmed | `command -v opencode` failed; the binary lives only inside the Desktop install |

**Correction to an earlier assumption:** a `bun.exe` process *is* running on this machine, but its path is
`%LOCALAPPDATA%\Programs\@codebufffreebuff-desktop\resources\bun\bun.exe` — that is **Freebuff's** bundled
Bun, **not** OpenCode's. It says nothing about OpenCode's plugin runtime, and it was not treated as
evidence here.

## 3. Which plugin API does this runtime implement?

### 3.1 The package lines are separate and both live

| Package | npm `latest` | Role |
| --- | --- | --- |
| `@opencode-ai/plugin` | **1.18.35** | the V1 `Hooks` line that Stage 1D targets |
| `@opencode/plugin` | **2.0.26** (and `2.0.24`, matching the installed CLI) | the V2 line |

### 3.2 What the shipped 2.0.24 binary contains

Literal-string probes against `opencode-cli.exe` (the artifact the Desktop actually runs):

| Probe | Count | Reading |
| --- | --- | --- |
| `tool.execute.before` | **0** | V1 tool hooks absent |
| `tool.execute.after` | **0** | V1 tool hooks absent |
| `tool.execute` (any suffix) | **0** | the whole V1 tool namespace is gone |
| `chat.message`, `chat.params`, `chat.headers` | **0** | V1 chat hooks absent |
| `experimental.chat.messages.transform`, `experimental.chat.system.transform` | **0** | V1 experimental hooks absent |
| `@opencode-ai/plugin` | **0** | the V1 package name is not referenced |
| `@opencode/plugin` | 2+ | V2 package name present |
| `ctx.tool`, `ctx.event` | 3, 2 | V2 hook registration surface |
| `execute.before`, `execute.after` | 4, 4 | V2 tool hook names |
| `event.subscribe` | 21 | V2 event subscription |
| `.hook(` | 67 | V2 `ctx.<domain>.hook(...)` registration |
| `cli.json` | 9 | V2 CLI-only config file (`https://opencode.ai/v2/cli.json`) |
| `PluginSourceDirectory.discover`, `["plugin","plugins"]`, `.opencode/plugins` | present | the runtime does scan project plugin directories |
| `"plugins"` config key validation | present | `Invalid plugins configuration` guard, reading both `plugin` and `plugins` keys |

### 3.3 Official statement

OpenCode's V2 migration guide: **"V1 plugin implementations do not run in V2. Moving a file or renaming
its config entry is not enough."** It maps `tool.execute.before` → `ctx.tool.hook("execute.before", …)`,
`event` → `ctx.event.subscribe()`, and a returned `dispose()` → the cleanup function returned by
`setup(ctx)`.

**Conclusion (source-confirmed, not runtime-confirmed):** the Stage 1D V1 adapter is incompatible with
the installed Desktop 2.0.24. This is the ADR's known "v1 → v2 migration" risk, now realised in the
user's actual environment.

## 4. Packaging validation (§4) — PASSED

The compiled observer was audited and then actually imported by Node from a vendored copy:

| Check | Result | Evidence |
| --- | --- | --- |
| Package type / entry point | PASS | `"type": "module"`, `main`/`exports` → `dist/index.js` |
| Runtime dependencies | PASS | `dependencies` absent — zero |
| ESM import compatibility | **PASS** | `import()` of the vendored `dist/index.js` succeeded in Node |
| Module exports resolve | **PASS** | 41 exports; `DrTokenOpenCodeObserver` is a `function` |
| OpenCode V1 hook compatibility | **PASS (V1 only)** | instantiating returned exactly `tool.execute.before, tool.execute.after, event, dispose` |
| Node.js compatibility | PASS | only `node:crypto` (static) and `node:fs/promises` (dynamic, sink-only) |
| Bun-only APIs | PASS | no `Bun.*` usage anywhere in `dist/` |
| Default export | **FAIL for V2** | no `export default` in any module; V2 requires a default-exported `Plugin.define({ id, setup })` |

**No packaging change was made, and none can help.** The bundle is a correct, dependency-free ESM
package; what blocks it is the *API shape* it registers hooks against. Making it work on 2.0.24 is a
V2 port (different package, different registration API), not a packaging fix — that is Stage 1F work
and was deliberately not started.

## 5. Temporary test project (§5)

Created outside the Dr. Token repository, in the OS temp directory, with synthetic content only:

```
%LOCALAPPDATA%\Temp\dr-token-opencode-e2e\
├── notes.txt                          synthetic text file
├── src\sample.ts                      small TypeScript source file
├── fixtures\repeated-content.json     fixture with deliberately repeated content
├── VALIDATION-README.md               what this is + removal instructions
└── .opencode\
    ├── plugins\dr-token-observer.ts   the Stage 1D-documented local install pattern
    └── vendor\dr-token-opencode-observer\   copied dist/ + package.json (no npm install needed)
```

Plugin entry (exactly the pattern Stage 1D documented):

```ts
// .opencode/plugins/dr-token-observer.ts
export { DrTokenOpenCodeObserver as DrTokenObserver } from '../vendor/dr-token-opencode-observer/dist/index.js';
```

No global OpenCode configuration was read, modified, or added. Nothing was installed with npm.

## 6. Runtime test procedures and observed results

Non-billable, read-only or private-server commands only. **No model session was started** — no prompt
was sent, no agent ran, no tool call was produced, and nothing was billed.

| # | Procedure (exact command, run in the test project) | Observed result | Verdict |
| --- | --- | --- | --- |
| 1 | `opencode-cli.exe --version` | `opencode v2.0.24`, exit 0 | **Desktop runtime-tested** |
| 2 | `opencode-cli.exe --help`, `plugin --help`, `debug --help`, `serve --help` | subcommands incl. `plugin`, `debug`, `serve`, `run`, `session`, `api` | **Desktop runtime-tested** |
| 3 | `opencode-cli.exe plugin list` | `No plugins found`, exit 0 | **Inconclusive** — this subcommand manages *global configuration* (`add`/`remove` say so), so it does not prove project-local discovery either way |
| 4 | `opencode-cli.exe debug agents --print-logs --log-level debug` | printed the resolved agent list (575 lines stdout, 0 stderr), **no plugin-related output at all** | **Inconclusive** — this command does not initialize the plugin subsystem |
| 5 | `opencode-cli.exe serve --hostname 127.0.0.1 --port 45913 --log-level debug` (own process, stopped after the check) | `server listening on http://127.0.0.1:45913`; TCP port confirmed open; **no plugin logs**; process stopped cleanly | **Desktop runtime-tested** (server boots in the project) |
| 6 | Same, with a diagnostic probe plugin whose module body writes a marker file on import (`.opencode/plugins/zz-probe.ts`) | **marker NOT written** — the project-local plugin file was not imported during a 22-second server boot | **Observed: plugin files are not imported at server boot.** Plugin loading is evidently lazy (session-scoped) or deferred; probe removed afterwards |
| 7 | `opencode debug paths` | global config/data/cache/state/log paths (no secrets printed) | **Desktop runtime-tested** |

### What could not be tested, and why

Stage 1E §6 requires ten hook-level checks (plugin discovered, initialises, `read` triggers hooks, a
second identical read is recorded as repeated, different ranges are distinguished, completions are
correlated, arguments/outputs unchanged, bypass works, removal restores ordinary behaviour).

**None of these could be executed on this installation.** They all require the plugin to be *loaded*
and a *tool call* to occur; the first is impossible on 2.0.24 for a V1 plugin, and the second needs an
agent session, which would require driving the Desktop GUI and making a model call — explicitly gated
behind user authorisation in §7. Combined evidence (absent V1 namespace + official migration statement)
means these checks would be expected to fail here, but that expectation is **not** a runtime result and
is not reported as one.

## 7. Token and usage availability

**Unavailable — nothing was measured.** No session ran, so no `message.updated` event was produced and
no token, cost, cache or reasoning field could be observed. No value in this document is estimated or
inferred.

The Stage 1D evidence discipline is unchanged and was not touched by this stage: measured values stay
`measured`, aggregates stay `calculated` **in the observation summary**, and the Stage 1B projection
still reports `calculated` observations as `unavailable` (`CALCULATED_NOT_REPRESENTABLE_NOTE`) rather
than promoting them to `measured`. That correction was preserved; the 15-test
[benchmark-integration suite](../integrations/opencode/tests/benchmark-integration.test.ts) still passes.

## 8. Runtime errors

No errors were produced by the commands above. The one meaningful negative result is §6 row 6 (probe
marker absent), which is an observed behaviour, not an error. The v2 server booted and shut down
cleanly; no OpenCode process was left running by this validation (the user's own Desktop session was
never touched).

## 9. Security checks

| Requirement | Result |
| --- | --- |
| No prompts logged | **PASS** — no session ever ran; no prompt was sent |
| No source content persisted | **PASS** — only synthetic temp-project files existed, and no observation output was written |
| No credentials collected | **PASS** — `~\.config\opencode\service.json` and all global config files were **never opened** |
| No private conversations inspected | **PASS** — no session data, log, database or export was read |
| Global settings unchanged | **PASS** — only read-only commands plus a private `serve` on explicit ports; no `plugin add/remove`, no `service start/stop/restart`, no `upgrade`, no `uninstall`, no config writes |
| Observer does not interfere with tool execution | **Not applicable here** (never loaded); still guaranteed by construction and by the 165 unit tests |
| Internal errors do not end sessions | **Unverified at runtime**; covered by unit tests (fail-open double guard) |
| Bypass works | **Unverified at runtime**; covered by unit tests (`enabled: false`, `DR_TOKEN_OPENCODE_OBSERVER=off`) |

**Disclosure:** starting the private test server printed a *transient, freshly generated* local server
password to this session's terminal output. It belonged to a server that was started for the test and
immediately stopped, was not stored, transmitted or committed, and is not a user credential. It is not
reproduced anywhere in this document. As with the Stage 1C note about `service.json`, treating local
values as disposable after accidental display is the safe default.

## 10. Manual steps still required from the user

These are optional and cost model tokens. **Do not run them if the account would be billed** — they are
confirmatory only, and the conclusion above already rests on source-confirmed evidence.

1. **Confirm the app version in the UI.** Open OpenCode Desktop → About/Help → expect **2.0.24**.
2. **(Optional) Confirm the V1 plugin is inert.** Open the disposable project
   `%LOCALAPPDATA%\Temp\dr-token-opencode-e2e` in Desktop, send one message that asks the agent to read
   `notes.txt` twice, then check whether any Dr. Token observation file appeared. Expected result: **no
   observation output**, because a V1 plugin does not run on 2.0.24.
3. **Report back** what you see. Without step 2 the load failure stays source-confirmed rather than
   runtime-confirmed, and this document will keep saying so.

## 11. Removing the test plugin

The plugin was never installed globally. To remove it completely, delete the disposable project —
that single deletion also removes its plugin entry and the vendored copy:

```powershell
# PowerShell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Temp\dr-token-opencode-e2e"
```

```sh
# Git Bash / WSL
rm -rf "$LOCALAPPDATA/Temp/dr-token-opencode-e2e"
```

The same instruction is written in the project's own `VALIDATION-README.md`.

No `.opencode` directory, `opencode.json(c)`, or plugin reference was ever created in the Dr. Token
repository, and nothing was added to `~\.config\opencode`. If you also set
`DR_TOKEN_OBSERVER_SUMMARY_FILE` while testing, unset it in that shell; Dr. Token writes nothing by
default.

## 12. Unverified capabilities and limitations

**Unverified on this install**

- Whether Desktop surfaces a *load failure* for a V1 plugin file (no log line was observed, at any
  level, in any of the probes — but the loader never fired).
- Whether project-local plugin files are imported when a session runs (the probe shows they are not
  imported at server boot).
- Whether Desktop passes the opened project directory to its bundled CLI as the working directory.
- The exact V2 hook semantics (`ctx.tool.hook("execute.before" | "execute.after")` argument shapes,
  `ctx.event.subscribe()` payloads, `setup(ctx)` capabilities such as `ctx.storage`).
- Whether the local-file plugin path works identically in the Desktop GUI as in the CLI.
- Every token/cost field, since no session ran.

**Verified limitations of Stage 1D in this environment**

- The V1 adapter cannot be used with OpenCode 2.0.24 Desktop. It remains valid only for a V1-line
  runtime (the `1.18.x` line the published `@opencode-ai/plugin` package still represents).
- Stage 1D's `docs/OPENCODE_OBSERVER.md` instructions for local installation therefore apply to a
  V1-line OpenCode only; this is now stated there.
- No packaging change can bridge the gap; the hook registration API itself differs.

## 13. Reproducing this validation

```sh
CLI="$APPDATA/ai.opencode.desktop/cli/2.0.24/opencode-cli.exe"
"$CLI" --version                      # expect: opencode v2.0.24
"$CLI" debug paths                    # config / data / log locations

# Which API line does the binary implement?
for p in "tool.execute.before" "tool.execute.after" "chat.message" "experimental.chat.messages.transform" \
         "@opencode-ai/plugin" "@opencode/plugin" "ctx.tool" "event.subscribe" "cli.json"; do
  printf '%-38s %s\n' "$p" "$(grep -a -o -E "$p" "$CLI" | wc -l)"
done

# Packaging: is the shipped bundle importable ESM with a V1 hook surface?
node --input-type=module -e "
  const m = await import('file:///C:/Users/adeep/AppData/Local/Temp/dr-token-opencode-e2e/.opencode/vendor/dr-token-opencode-observer/dist/index.js');
  console.log(Object.keys(await m.DrTokenOpenCodeObserver({})).join(', '));
"
```

## 14. Module / file map for this stage

| File | Change |
| --- | --- |
| `docs/OPENCODE_DESKTOP_VALIDATION.md` | this report (new) |
| `docs/OPENCODE_OBSERVER.md` | one factual note: the installed Desktop is on the V2 line |
| `docs/OPENCODE_FEASIBILITY.md` | one factual note recording the Stage 1E outcome |
| `integrations/opencode/**` | **unchanged** — no code change was justified |
| `%LOCALAPPDATA%\Temp\dr-token-opencode-e2e\` | disposable test project (outside the repository) |

---

## 15. Stage 1G — live V2 validation (runtime-tested)

Everything in this section was observed in the real OpenCode Desktop 2.0.24 bundled CLI
(`%APPDATA%\ai.opencode.desktop\cli\2.0.24\opencode-cli.exe`), not inferred from types.

### 15.1 Method

| Step | Command (run in the disposable project) | Cost |
| --- | --- | --- |
| Discovery | `opencode-cli.exe plugin list` | none |
| Negative control | same, with the plugin file moved out of `.opencode/plugins/` | none |
| Load without a session | `opencode-cli.exe reload` | none |
| Live session | `opencode-cli.exe run --standalone --auto --model opencode/big-pickle "<two-read prompt>"` | **free model** |
| Disabled comparison | same, with the plugin file moved away | **free model** |

The prompt used was a single synthetic instruction: read `notes.txt` with the `read` tool, read it
again with the same default range, then reply `DONE`. No other tool was requested and nothing was
modified. `opencode/big-pickle` is listed at **Free** pricing in OpenCode's Console model table, and
`opencode/ling-3.1-flash-free` was used for the earlier probe runs; no paid model was called.

A **validation harness** wraps the real adapter in the project's plugin entry: it configures the
opt-in summary sink, and records content-free evidence (lifecycle markers, hook-fire records, event
type names, and field/value *types* — never values, paths, prompts or content) into per-process files.
The adapter itself is the unmodified build from `integrations/opencode/dist`.

### 15.2 Runtime-confirmed results

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Plugin discovered | **PASS** | `plugin list` → `dr-token-observer  local  ...\.opencode\plugins\dr-token-observer.ts`, reproducibly |
| 2 | Discovery negative control | **PASS** | with the file moved away → `No plugins found` |
| 3 | Plugin loaded by the host | **PASS** | server log: `msg="loading plugin" id="...\dr-token-observer.ts" entrypoint=file:///...` `role=server` |
| 4 | `setup(ctx)` invoked | **PASS** | marker `setup:start tool.hook=function event.subscribe=function` in the server process |
| 5 | Both tool hooks registered | **PASS** | markers `registered:execute.before`, `registered:execute.after` — no throw |
| 6 | Event subscription opened | **PASS** | marker `subscribed:events`; runtime log shows the `/api/event` stream at `http.status=200` |
| 7 | **Hooks fire on real tool calls** | **PASS** | 4 marker records per two-read session: `FIRED:execute.before tool=read` ×2, `FIRED:execute.after tool=read status=completed` ×2 |
| 8 | Payload fields usable | **PASS** | `input` is an object, `id` a string, `sessionID` a string, `status` `completed` on completion |
| 9 | Start/completion correlation | **PASS** | `toolStartsObserved: 2, toolCompletionsObserved: 2, correlatedCompletions: 2, pendingCalls: 0` |
| 10 | Repeated-read detection | **PASS (after fix, §15.3)** | `requests: 2, identifiedRequests: 2, distinctTargets: 1, repeatedTargets: 1, repeatedRequests: 1` |
| 11 | Evidence classification preserved | **PASS** | `repeatedFileReads: {"evidence":"calculated","value":1}`; `totalTokens` stays `unavailable` |
| 12 | Adapter identity | **PASS** | summary reports `pluginApi.line: "v2"`, package `@opencode/plugin`, version `2.0.24` |
| 13 | Cleanup / disposal | **PASS** | markers `cleanup:start` → `cleanup:done` after `reload`; no registration or disposal error |
| 14 | Fail-open | **PASS** | `internalErrors: 0` across every live run; the harness's own `null`/empty payload probes never reached the host |
| 15 | No interference | **PASS** | plugin enabled vs disabled produced the **identical** reply (`DONE.`) with identical exit code `0` |
| 16 | No tool mutation | **PASS** | the agent's tool inputs and outputs were unaffected; the adapter writes to no event field (§3 of the adapter doc) |

### 15.2.1 The summary sink did not flush in one-shot runs

`observations.jsonl` was **never written** by any `run --standalone` session. When a one-shot session
ends, the server process is terminated, so the adapter never reaches its cleanup path — the marker
log shows `cleanup:start`/`cleanup:done` after a `reload`, but not after a `run`. Because the observer
flushes a session to its sink on dispose (by design: nothing is written while observation is in
progress), the summary is lost with the process.

Practical consequences: the runtime evidence in this section comes from the harness snapshot (written
on an interval) rather than the sink, and **`summaryFile` is not reliable for one-shot automation** —
it needs a long-lived server whose plugin instance is unloaded cleanly (an interactive session, or the
Desktop GUI shutting down). This is a design consequence, not a defect in the observation logic, and
no summary content was ever written outside this disposable project.

### 15.3 Defect found and fixed: the V2 read argument is `path`, not `filePath`

The first live run exposed a real bug that no unit test could have caught:

```
FIRED:execute.before tool=read inputKeys=path
reads: {"requests":2,"identifiedRequests":0,"unidentifiedRequests":2,...}
```

V1 names the read tool's path argument `filePath`; **V2 delivers `path`**. Every V2 read was therefore
counted as *unidentified*, so repeated-read detection never fired in V2 — silently.

Fix ([`src/read.ts`](../integrations/opencode/src/read.ts)): `pickPathArgument()` accepts `path` as
well as `filePath`, preferring the V1 name when both are present. Seven regression tests were added to
[`tests/read.test.ts`](../integrations/opencode/tests/read.test.ts), and the fix was **re-validated
live** — the run after the fix reports `identifiedRequests: 2`, `repeatedTargets: 1`,
`repeatedRequests: 1`, `repeatedFileReads: {"calculated", value: 1}`.

Still unverified: which range parameter names (if any) V2 uses. Both observed V2 reads carried only
`path`, so the documented defaults are applied rather than guessed.

### 15.4 Finding not fixed: V2 usage events use a different envelope

V2 **does** expose token and cost data — but not through the V1 shape the observer reads. Captured
field names and value types (values are never recorded):

```
session.usage.updated x3 →
{ id: string, created: number, type: string,
  data: { sessionID: string, cost: number,
          tokens: { input: number, output: number, reasoning: number,
                    cache: { read: number, write: number } } } }

session.tool.called x2 →
{ id, created, type, durable: {...}, location: { directory: string },
  data: { sessionID, assistantMessageID, id, input: { path: string }, executed: boolean } }
```

V1 delivered `{ type: "message.updated", properties: { info: AssistantMessage } }`. V2 has **no
`properties`** — payloads live under **`data`** — and the type names are entirely different
(`session.usage.updated`, not `message.updated`). The observer matches V1 names and reads
`properties`, so every V2 session currently reports `usage: all fields 0` and token measurements as
`unavailable`.

**This is deliberately not fixed in Stage 1G** (the stage's objective was validation, not new
functionality). The verified payload path is recorded so Stage 1H can map
`session.usage.updated.data.{cost, tokens.*}` onto the existing, unchanged evidence vocabulary — the
field names are identical to V1's, so no classification change is needed. Until then, V2 sessions
report **no token data**, and nothing is estimated to fill the gap.

### 15.5 V2 event inventory (observed)

29 distinct event types / 40 events in one two-read session:
`integration.updated, model.updated, provider.updated, agent.updated, command.updated, skill.updated,
websearch.updated, reference.updated, plugin.updated, session.inbox.enqueued, session.execution.started,
session.instructions.updated, session.inbox.delivered, session.step.started(2), session.reasoning.started,
session.reasoning.delta(3), session.tool.input.started(2), session.reasoning.ended, session.tool.input.ended(2),
session.tool.called(2), session.step.streamed(2), session.tool.success(2), session.step.ended(2),
session.usage.updated(3), session.renamed, session.text.started, session.text.delta, session.text.ended,
session.execution.succeeded`.

None of these names appears in V1. The observer treats all of them as unknown and ignores them
(`eventsIgnored`), which is the correct fail-safe: no V1 event name was ever delivered, and no
unrecognised event was mistaken for a token reading.

### 15.6 Not runtime-verified

- **Session separation across concurrent sessions.** Only one session per server process was
  observable: a shared server requires the password the `serve` command auto-generates (there is no
  password flag), and handling a service password is out of bounds for this stage. Per-session keying
  remains unit-tested only.
- **V2 range parameter names** for the read tool (§15.3).
- **Whether `id` is stable across steps** for very long tool sequences — correlation was exact in
  every observed run, but the sample is small.
- **Desktop GUI sessions.** The bundled CLI was driven headlessly. The GUI's own service process did
  load the plugin (observed, second pid in the evidence), but no GUI session was driven.
- **Token values**, because the adapter does not yet consume `session.usage.updated` (§15.4).

### 15.7 Security and cost

No credential, conversation, prompt or file content was read, and no service password was used.
Global OpenCode configuration was not modified. Two probe servers were started on explicit loopback
ports (45913–45916) and both were stopped — no listener remains on any of them. Model calls used only
models listed as **Free** in OpenCode's published Console pricing, in a disposable project containing
synthetic files. One transient auto-generated server password was printed to this session's log when a
private `serve` was started for diagnosis; that server is stopped, the value was never used, and it is
not reproduced here. **No token saving is claimed, and none was measured.**

---

## 16. Stage 1H — V2 usage events and reliable summary persistence (runtime-tested)

Stage 1H set out to close the two deficiencies Stage 1G left open: the adapter did not consume
`session.usage.updated`, and the opt-in summary sink could lose everything in a one-shot session.
Both are fixed, and both fixes are **runtime-validated** on OpenCode Desktop 2.0.24.

### 16.1 Root causes

1. **Every V2 event arrived empty.** `asRuntimeEvent` in
   [`src/plugin-v2.ts`](../integrations/opencode/src/plugin-v2.ts) forwarded `type` and
   `properties` and **dropped `data`** — and V2 delivers an event body under `data`. The observer's
   `session.usage.updated` handler was correct all along; it never received a payload. Stage 1G
   missed it because both its tests and its live harness handed events to the observer's *V1-shaped*
   hook and skipped the normaliser entirely.
2. **The tail of a one-shot session was lost.** The only durability path was a periodic checkpoint
   (default 1000 ms) plus unload, and a one-shot host is killed before unload runs. In Stage 1G's
   run the last write preceded the usage events, so the session's only numbers never reached disk.
3. **Found while fixing (runtime):** with `data` preserved, `session.created`/`session.deleted` are
   delivered but still do not map, because V2 does not use the V1 `properties.info.id` layout
   (§16.7). The payload now arrives; the mapping is the next step.

### 16.2 The change set

| File | Change |
| --- | --- |
| [`src/types-v2.ts`](../integrations/opencode/src/types-v2.ts) | `OpenCodeV2Event` declares `data`; the V1/V2 payload-carrier difference is documented on the type |
| [`src/plugin-v2.ts`](../integrations/opencode/src/plugin-v2.ts) | `asRuntimeEvent` preserves `data` **and** `properties` (precedence decided downstream, V1 first) |
| [`src/observer.ts`](../integrations/opencode/src/observer.ts) | A `session.usage.updated` snapshot is flushed immediately (queued, never awaited into the event path), on top of the existing periodic checkpoint |
| [`src/sink.ts`](../integrations/opencode/src/sink.ts) | The JSONL sink closes a torn final record before appending, so an interrupted write cannot corrupt the next one; the append-only contract is kept (no temp-file rename) |

No optimisation, rewriting, compression or telemetry was added. Nothing in the observation path can
change what OpenCode does: writes are `void`-scheduled behind the existing serialising write chain and
every failure is contained as a `sink-failed` diagnostic.

### 16.3 The live run

One synthetic session, in the disposable project, driven by the bundled CLI:

```
opencode-cli.exe run --standalone --print-logs --auto --title "Dr. Token Stage 1H validation" \
  -m opencode/longcat-2.5-preview-free \
  "Use the read tool to read the file fixtures/repeated-content.json twice with the default range.\n   Do not summarise the file. Then reply exactly: DONE."
```

Result: exit **0**, reply **`DONE.`**, host log `→ Read fixtures/repeated-content.json` **twice**.
The title was supplied explicitly so OpenCode's own title generation could not make a second call.

### 16.4 Observed results

| Check | Observed |
| --- | --- |
| Plugin instance per process | `setup:start` ×1, `registered:execute.before` ×1, `registered:execute.after` ×1, `subscribed:events` ×1 |
| Hooks fire on real tool calls | `FIRED:execute.before tool=read` ×2, `FIRED:execute.after tool=read status=completed` ×2 |
| Correlation | `toolStartsObserved 2, toolCompletionsObserved 2, correlatedCompletions 2, pendingCalls 0` |
| Repeated read | `requests 2, identifiedRequests 2, unidentifiedRequests 0, distinctTargets 1, repeatedTargets 1, repeatedRequests 1` |
| **V2 usage recorded** | `usage.sourceReported.events 2`, `usableEvents 2`, `latest {input 849, output 45, reasoning 94, cacheRead 8960, cacheWrite 0, cost 0}` |
| Evidence class | `inputTokens … evidence "unavailable"` with the source-reported note; `totalTokens` `unavailable`; **no aggregate derived** |
| `latest` vs the runtime's own record | the last snapshot **equals** the session export's totals exactly (all five fields) |
| Fail-open | `internalErrors 0`; the unobserved V2 vocabulary (`session.step.*`, `session.tool.*`, …) is ignored |
| One-shot persistence | **3 summary lines on disk** for that session, written while it ran, with `cleanup:start` never logged |

### 16.5 Aggregation semantics: what is now known

The event series is a **running session total**, not a per-request increment:

| Session | Last snapshot | Runtime's stored totals | Sum of final per-message records |
| --- | --- | --- | --- |
| Stage 1H (LongCat, 2 events) | 849 / 45 / 94 / 8960 | 849 / 45 / 94 / 8960 | 849 / 45 / 94 / 8960 |
| Stage 1G (3 events) | 897 / 84 / 176 / 9472 | 897 / 84 / 176 / 9472 | 857 / 78 / 102 / 8960 |

Under an increment reading the final event would be one step's delta, not the whole session. In both
sessions the last event equalled the totals the runtime itself stored; in the Stage 1G session those
totals also **exceed** the sum of the retained per-message records, so the running total counts more
than the final messages.

This is an observation of two sessions on one host version, **not a published contract**, so the
adapter still emits `aggregation: "unverified"`, still preserves only the source's own numbers under
`usage.sourceReported.latest`, and still derives **no** session aggregate from them. `monotonicNonDecreasing`
and `decreasesObserved` remain the in-band evidence a consumer can rely on.

### 16.6 One-shot persistence: the live proof

`observations.jsonl` after the run (one session, `ses_eda6b294…`):

| Line | Written by | `sourceReported.events` | `latest.input` |
| --- | --- | --- | --- |
| 1 | immediate flush on usage event 1 | 1 | 296 |
| 2 | immediate flush on usage event 2 | 2 | **849** |
| 3 | the periodic checkpoint, still running | 2 | 849 |

The host process was terminated **without ever running the plugin's cleanup** (`cleanup:start` is
absent from the marker file), which is exactly the case Stage 1G lost. The file ends with a newline
and every line parses as JSON. Line 2 is the whole point: durability no longer depends on unload, and
the last numbers reached disk within the session itself.

`checkpointIntervalMs: 0` disables the periodic timer only — an arriving usage snapshot is still
written. That is deliberate and pinned by a test.

### 16.7 V2 event vocabulary and remaining mapping gaps

A zero-cost window against the same host (a plugin instance loaded by the Desktop background service)
recorded event **names** and **payload key names only** — never a value:

| Event | `data` keys | Adapter |
| --- | --- | --- |
| `session.usage.updated` | `cost, sessionID, tokens` | **consumed** (validated) |
| `session.step.ended` | `assistantMessageID, cost, finish, rawFinish, sessionID, tokens` | ignored (per-step usage; would double count if pooled) |
| `session.tool.called`, `session.tool.success` | `assistantMessageID, executed, id, input, sessionID, …` | ignored — the V2-native tool signal, not used |
| `session.execution.started` | `sessionID` | ignored |
| `session.created`, `session.deleted` | *(not captured — see below)* | **received but unmapped** |
| `model/provider/agent/command/skill/reference/plugin/websearch/integration.updated` | `{}` | ignored (correct: nothing to read) |

`session.created` was delivered with its payload under `data` and produced a `hook-input-unusable`
diagnostic: it does not carry the V1 `info.id` layout the handler reads, so no session was registered
from it. `session.deleted` was counted as ignored for the same reason. Both are genuinely received now
(the Stage 1H fix) — only the field mapping is open, and it is left unmapped rather than guessed.

Also observed: **`session.execution.succeeded` was not delivered** in the one-shot run (only
`session.execution.started`), so the flush trigger registered for it did not fire. Durability in that
run came from the usage-snapshot flush and the interval checkpoint — which is why the tail survived a
host that never unloaded.

### 16.8 The reported duplicate plugin entry

Investigated because duplicate registration would double-count everything. **No duplicate is
reproducible:**

- `opencode plugin list` and `plugin list --builtin` each show **exactly one** `dr-token-observer`
  row; running the same command from the repository root reports `No plugins found`.
- Per process, the marker file shows **one** `setup:start`, **one** registration per hook name and
  **one** `subscribed:events`. Two `setup` sequences exist only across *different pids* — a private
  one-shot server and the Desktop background service, each loading its own project plugin.
- Counts were checked against the host's own record: `toolStartsObserved 2` for the host's two read
  calls, and the 2 usage events on disk for the 2 captured. The observer's `eventsObserved` (55 at the
dump instant) counts subscription events **and** tool-hook calls — 52 + 4 minus one event still in
  flight — so the two counters reconcile exactly with no double delivery.
- The only place two plugin *files* exist in the disposable project is `.opencode/plugins-disabled/`
  (Stage 1G's negative control), which is not a discovery path.

Residual possibility, stated rather than dismissed: the Desktop **GUI's** plugin view may list one row
per loaded instance (one per process), which would look like the same file twice. The CLI's list does
not, and nothing is double-counted. Unrelated but adjacent: `opencode auth list` prints
"OpenCode Console Personal" twice in this environment; that is a credential-store entry, untouched here.

### 16.9 Blocked, and stopped deliberately

A zero-cost attempt to drive lifecycle events through the already-running Desktop background service
was **abandoned after the isolation check failed**. `api session.create` resolved the new session to
`C:\Users\adeep`, not the disposable project, even though the command ran with the project as its
working directory; the condition was therefore not met under which the work was authorized. Exactly
that one session was deleted (`session.get` then returned `SessionNotFoundError`), and the disposable
project's own session list was unchanged at 14 entries. The zero-cost evidence in §16.7 came from the
service instance's own passive observation, not from that attempt.

### 16.10 Still not runtime-verified

- **V2 session lifecycle mapping** (§16.7) — **superseded by §17**: the `data` key names were read from
  the shipped `@opencode/schema@2.0.24` declarations, and `session.created` was then mapped and
  observed live in an isolated run. (`session.deleted`/`session.moved` remain harness-tested only.)
- **Session separation across concurrent sessions.** Isolation semantics are **superseded by §17** (the
  scope gate and concurrent-session separation are covered by the V2 host harness, and refusal of a
  differently-attributed session was observed live); *two simultaneous sessions in one shared live
  server* remain untested — still blocked on the service password, which stays out of scope.
- **GUI-driven sessions**, V2 read *range* parameter names, `id` stability across very long
  sequences, and the mapping of `session.step.ended` usage (deliberately not pooled).
- **Bypass** (`enabled:false` / `DR_TOKEN_OPENCODE_OBSERVER=off`) remains unit-tested only; no live
disabled comparison was repeated in Stage 1H; **superseded by §17**, where a disabled observer was
validated live in an isolated run — the `session.created` event was delivered and nothing was processed
or written.

### 16.11 Security and cost

One model call, on `opencode/longcat-2.5-preview-free`, verified **still listed Free**
(input/output/cached-read = Free) from the published Console pricing immediately before the run, with
its zero-retention / no-training note. No paid model was used; no credential, prompt, conversation or
file content was read; global configuration was not modified; the Desktop service was not restarted or
reconfigured. The two diagnostic servers started on loopback ports 4571/4572 (with a password supplied
by this session's own environment, not the host's generated one) were stopped, and the log containing a
transient auto-generated password was deleted. **No token saving is claimed, and none was measured.**

---

## 17. Stage 1I — live lifecycle, project isolation and harness validation (runtime-tested)

### 17.1 Method

Three runs in a **fresh disposable project** (`%TEMP%\dr-token-stage1i-run2\project`), each with its own
isolated XDG config/data/cache/state directories (`…\dr-token-stage1i-run2\iso`), using the Desktop's
own bundled CLI **2.0.24** in `run --standalone` mode. Each run names an **unresolvable model**
(`--model nonexistent/nonexistent-model`), so the session fails at model resolution and **no provider
is ever contacted**; this is the zero-cost way to exercise session creation, plugin loading and event
delivery. The staged plugin (`…\.opencode\plugins\dr-token-observer.ts`) is a harness that forwards the
host's real `ctx.location`, tool and event domains to the unmodified built adapter
(`…\.opencode\vendor\dr-token-opencode-observer\dist`) and records **event type names, payload key
names, primitive carrier types and the observer's own snapshot/summaries only** — never an event value,
path, prompt or tool output. Full runs and artifacts: `A.err`/`B.err`/`C.err`, `dr-token-stage1i.marker`,
`dr-token-stage1i-evidence-<pid>.json`, `observations.jsonl` in that directory.

The user's Desktop background service was **not** used to create any session. (It did hot-reload the
Stage 1I harness staged into the Stage 1H disposable project at `%TEMP%\dr-token-opencode-e2e`; see
§17.6.)

### 17.2 Contract facts confirmed live

- `session.created` arrives with its body under `data` and the key names
  `location, model, projectID, sessionID, slug, subpath, version`; `data.location` carries `directory`.
  This matches the declarations read from `@opencode/schema@2.0.24` (observer doc §18.7).
- `ctx.location` is present in the real 2.0.24 host with the members
  `directory, project, workspaceID` and `project: { canonical, directory, id }` — key names only were
  recorded.
- The run's V2 event vocabulary observed live included `session.renamed`, `session.inbox.enqueued`,
  `session.inbox.delivered`, `session.execution.started`, `session.execution.failed`,
  `session.instructions.updated` alongside the registry events; all are safely ignored, none is
  mistaken for a token reading.

### 17.3 Scenario A — lifecycle mapping, attribution and arrival-time persistence (PASS)

A live session (`ses_ed983a174…`) was created in the isolated project. The observer's own snapshot
(`dr-token-stage1i-evidence-15572.json`) and the sink file show:

- `sessionCount: 1`, `sessionsCreated: 1`, `eventsObserved: 16`, `internalErrors: 0`;
- the session summary has `lifecycle.createdEvents: 1` — the V2 lifecycle mapping that Stage 1H could
  not perform;
- `project: { basis: "runtime-declared", verification: "matched", projectId: "bb787…", directoryHash: "4577…" }`
  — compared by project id against the instance's own `ctx.location`, with only a one-way hash of the
  directory persisted (the absolute path appears nowhere in the file);
- `observations.jsonl` was written at **15:44:08.190Z — 11 ms after the `session.created` event
  (15:44:08.179Z)** with `checkpointIntervalMs: 60_000` and **no cleanup ever running** (the host was
  killed by the unresolved-model error at 15:44:08.356Z). This live-proves the Stage 1I arrival-path
  flush: neither dispose nor a periodic checkpoint could have produced that write.

### 17.4 Scenario B — a session declaring another project is refused (PASS)

With the harness declaring a synthetic instance project different from the live session's project:

- `sessionsCreated: 1`, `sessionCount: 0`, `sessionsOutOfScope: 1`, `lateEventsIgnored: 0`,
  `internalErrors: 0`; diagnostic `project-mismatch` (with the usual `event-ignored`);
- `summaries: 0` and **no sink file was created**: nothing was written for the refused session.

### 17.5 Scenario C — a disabled observer processes nothing (PASS)

With `DR_TOKEN_STAGE1I_DISABLED=1`:

- the harness confirmed the delivered `session.created` (`eventTypes["session.created"] = 1`), yet the
  observer's snapshot shows `enabled: false`, `eventsObserved: 0`, `sessionsCreated: 0`, and no sink
  file exists;
- this is the first live validation of the bypass path (Stage 1H recorded it as unit-tested only).

### 17.6 The Desktop background service instance (disclosure)

Staging validation harnesses into the Stage 1H disposable project
(`%TEMP%\dr-token-opencode-e2e`) caused the **user's already-running Desktop background service**
(`opencode-cli serve --service`, pid 19628) to hot-reload the harness, because the service's session is
attached to that directory. Its passive observation was recorded (`dr-token-stage1i.marker`,
`dr-token-stage1i-evidence-19628.json`): the adapter initialised in that real service process with
`ctx.location` present in the verified shape, observed 11 registry events, ignored all of them safely,
and reported `sessionsCreated: 0`, `internalErrors: 0`. **No session was created through the service**,
and no model call occurred there. The harness is observation-only and confined to the disposable
directory; the user may remove `…\dr-token-opencode-e2e\.opencode\plugins\` and `…\vendor\` to stop the
service from loading it.

### 17.7 Still not runtime-verified after Stage 1I

- **Live `session.deleted` / `session.moved`**: no isolated run produced either event (the one-shot host
  is killed before deletion). Both are exercised deterministically through the real V2 plugin by
  `tests/v2-lifecycle.test.ts` (deletion flushes then releases state; a move re-runs the scope gate),
  but they are **not** live-observed.
- **Two simultaneous live sessions in one server**: isolation semantics and interleaving are covered by
  the harness; a shared live server still requires the service password, which remains out of scope.
- **GUI-driven sessions** and `session.step.ended` usage mapping (deliberately not pooled) remain
  unverified as before.

### 17.8 Security and cost

**Zero model calls**: every run names an unresolvable model, and each run's log shows
`ModelUnavailableError: Model unavailable: nonexistent/nonexistent-model`. No credential was read or
created; no user conversation, prompt or file content was recorded (the harness stores event *names*,
payload *key names* and the observer's own snapshot only); the user's global configuration and the
Desktop service's own settings were not modified; all writes stayed inside `%TEMP%`. **No token saving
is claimed, and none was measured.**

---

## 18. Stage 1J — live lifecycle transitions, isolation and cleanup (runtime-tested)

### 18.1 Method

A **private, isolated server** instead of a one-shot run, so lifecycle operations can be driven
directly through the real API:

```sh
CLI="$APPDATA/ai.opencode.desktop/cli/2.0.24/opencode-cli.exe"
BASE="$TMPDIR/dr-token-stage1i-run2"          # fresh project + isolated XDG dirs
cd "$BASE/project"
XDG_CONFIG_HOME="$BASE/iso/config" XDG_DATA_HOME="$BASE/iso/data" \
  "$CLI" serve --hostname 127.0.0.1 --port 8899 --print-logs
```

The server prints its **own ephemeral password** (stdout); requests use it as HTTP basic auth with user
`opencode`. That password belongs to the disposable server this stage started — the user's service
password was never read, reused or recorded. A session is created with `POST /api/session` (optionally
with an explicit `location.directory`), its model pinned with `POST /api/session/{id}/model` to
`nonexistent/nonexistent-model`, and one synthetic prompt is sent so the real prompt pipeline loads the
project plugin. The prompt fails at model resolution (`ModelUnavailableError`) **before any provider is
contacted** — zero-cost, as in §17. Deletion and move use `DELETE /api/session/{id}` and
`POST /api/session/{id}/move`.

The staged plugin is the Stage 1J harness (per-instance tag, per-instance evidence files, event *names*
and payload *key names* only). Every session created, moved and deleted was synthetic and belonged to
this disposable server; no user session or credential was touched. `session.created`,
`session.deleted` and `session.moved` were produced by the real runtime in response.

### 18.2 Live transitions observed

- **`session.created`** — an API-created session was mapped (`lifecycle.createdEvents: 1`) with
  `project.verification: "matched"` against the instance's own `ctx.location`, and its sink record was
  appended immediately.
- **Two concurrent sessions in one server** — both tracked independently (`sessionCount: 2`); deleting
  one closed only that one (`sessionsClosed: 1`, `sessionCount: 1`) and left the other's summary
  unchanged; the deleted session's final summary was appended before its state was released.
- **`session.deleted` of an untracked session** (created before the plugin had loaded) was ignored
  (`eventsIgnored` +1) with no state created and nothing written — a deletion cannot synthesise a
  session.
- **`session.moved`** — (a) delivery confirmed: three live instances each received the event with the
  verified `data` keys `location, projectID, sessionID, subpath`; (b) a **matched move was processed**: a
  session in a git-repo tree was moved from `gitproj` to `gitproj/sub` (both resolve to project id
  `global`) — it stayed tracked, `verification: "matched"`, the directory hash changed
  (`4cee5416…` → `b74dc7c8…`), and the new state was appended to the sink; (c) a session belonging to a
  different project is refused when created, and its later move event is ignored.

### 18.3 Project-identity behaviour observed live

- With no project marker, each directory receives its own opaque project id (`a`, `b` and `subdir` all
  differed), while the `.opencode`-rooted project root has its own id.
- Directories inside a git repository all resolved to the project id **`global`** — the same id for
  `gitproj` and `gitproj/sub`, which is what made a live matched move possible.
- A move across directories can therefore change a session's project id; because the scope gate compares
  ids exactly whenever both sides declare one, such a move is refused rather than attributed, while a
  move inside one project is applied.

### 18.4 Hot-reload behaviour (host-level finding)

Changing the plugin file — and, in some cases, moving a session — re-bootstraps the plugin runtime.
Observed live: the host calls the previous instance's cleanup (`cleanup:start`/`cleanup:done`, which
runs the adapter's `dispose()`; after that the observer ignores events and its counters freeze) and
creates new instance(s); one reload left an older instance undisposed alongside a newer one for a
while. Each instance keeps the project it captured at its own `setup` and gates independently — two
instances with different expected projects each tracked only their own project's sessions and refused
the other's. No duplicate summary for a single session state was observed: byte-identical repeated
records occurred only at legitimate flush points (a dispose flush of an unchanged session, or a move
flush followed by the `session.execution.succeeded` flush trigger, which this API-driven runtime *did*
deliver).

### 18.5 Persistence and privacy audit

The 13-record sink produced by the live runs was audited programmatically: every line was valid JSON;
no line contained an absolute path (`C:\`, `C:/`, `AppData`, `Temp` or the user name — all absent);
every record was `basis: "runtime-declared"`, `verification: "matched"` with a 16-hex directory hash;
no derived totals (`totalTokens` stayed `unavailable`); adapter line `v2`. Tool and usage fields stayed
zero because the prompts never executed — nothing was measured and nothing was invented.

### 18.6 Cleanup state

- The Stage 1J server was stopped (port 8899 closed).
- The run2 harness plugin is retired (`.opencode/plugins/dr-token-observer.ts.stage1j-retired`); its
  evidence files, sink and audit scripts are kept under `%TEMP%\dr-token-stage1i-run2\`.
- With the user's explicit permission, the staged plugin and vendored bundle were removed from the
  Stage 1H disposable project (`%TEMP%\dr-token-opencode-e2e\.opencode\`). The user's Desktop
  background service hot-reloaded and **unloaded the observer**: its marker recorded
  `cleanup:start`/`cleanup:done`, and its evidence snapshot now shows `disposed: true` with frozen
  counters (41 events observed over its life, 0 sessions, 0 internal errors). The service was not
  stopped or restarted and remains alive. A dormant harness interval inside that process still rewrites
  the old evidence file with the frozen, disposed snapshot — it observes nothing; a normal Desktop
  restart clears it.
- The inactive `plugins-disabled/` archive in that disposable project is not loaded by OpenCode and was
  left in place as evidence.

### 18.7 Still not runtime-verified after Stage 1J

- A move between two directories sharing a project id was validated only for the `global` (git-repo)
  case; for other ids the observed behaviour is refusal, which is the safe direction.
- Live **tool/read/usage** interleaving across two concurrent sessions would need real prompts (model
  calls), which this stage deliberately did not make; that isolation remains integration-tested through
  `tests/v2-host.ts` + `tests/v2-lifecycle.test.ts`.
- GUI-driven sessions and `session.step.ended` usage mapping remain as in §17.
