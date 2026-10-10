# OpenCode Desktop validation (Stage 1E → Stage 1G)

**Status (Stage 1G, 2026-10-10): LIVE HOOK VALIDATION COMPLETED.** The V2 adapter added in Stage 1F
(the V2 line) was loaded by the real OpenCode Desktop 2.0.24 runtime and its tool hooks **fired on real
tool executions**. Two genuine V2-vs-V1 differences were found; one is fixed and re-validated live, the
other is documented but not implemented. §1–§14 below are the Stage 1E record, kept as written (they
remain accurate for the V1 adapter that stage could not load); **§15 is the Stage 1G live result.**

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
