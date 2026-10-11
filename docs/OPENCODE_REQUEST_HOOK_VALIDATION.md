# OpenCode request-hook validation (Stages 1P and 1R)

**Status (2026-10-11): the OpenCode V2 model-request hook is RUNTIME-VERIFIED end to end** —
registration, invocation, timing, and the live shape of an assembled request **including two
byte-identical tool-result parts**, which is the exact precondition the Stage 1O Safe Mode design
requires. The first phase used **zero model calls**; the final measurement used **one authorized
free-model session**.

**Runtime:** `opencode v2.0.24` — the Desktop app's own bundled CLI
(`%LOCALAPPDATA%\Programs\@opencodedesktop\resources\opencode-cli.exe`, byte-identical to
`%APPDATA%\ai.opencode.desktop\cli\2.0.24\opencode-cli.exe`, 206 128 008 bytes).
**Probes:** `integrations/opencode/src/request-probe.ts` (Stage 1P, observation only, not exported from
the package entry point) and `integrations/opencode/src/request-mutation-probe.ts` (Stage 1R, the gated
influence probe; also not exported). **Tests:** `integrations/opencode/tests/request-probe.test.ts`
(29 tests) and `integrations/opencode/tests/request-mutation-probe.test.ts` (34 tests).
**Related:** [docs/SAFE_MODE_DESIGN.md](SAFE_MODE_DESIGN.md) ·
[docs/SAFE_MODE_M1_OBSERVATION.md](SAFE_MODE_M1_OBSERVATION.md) (Stage 1Q: the M1 opportunity analyzer built on this hook) ·
[docs/adr/0003-safe-mode-strategy.md](adr/0003-safe-mode-strategy.md) ·
[docs/OPENCODE_DESKTOP_VALIDATION.md](OPENCODE_DESKTOP_VALIDATION.md) ·
[docs/OPENCODE_OBSERVER.md](OPENCODE_OBSERVER.md)

> **Headline.** `ctx.session.hook("context")` and `ctx.session.hook("http.request")` both **register
> without throwing** on the real 2.0.24 runtime, and the `context` callback **does execute during
> request assembly** — once per attempt, about **2 ms before** the outbound HTTP request, carrying the
> **complete assembled request** (4 system parts, the message list, the option map and **12 tool
> definitions**) plus the model call's `kind: "primary"`. In a real coding turn, the third request
> contained **two separate `tool-result` parts for the `read` tool with byte-identical content in the
> same request** — one duplicate group, one elidable later copy, **135 elidable characters**. No
> provider was contacted during the zero-cost phase (a built-in provider pointed at a dead loopback
> endpoint), and the single authorized model call was free-tariff and synthetic-content only.

> **Stage 1R follow-up (2026-10-11): the influence half is now RUNTIME-VERIFIED.** Stage 1P settled
> *delivery* — the callback fires during assembly. Stage 1R settles *influence*: a value written inside
> `ctx.session.hook("context")` is the value the runtime sends to the provider. A control/treatment
> pair captured the real outbound bodies at a private loopback endpoint, and the treatment body
> differed from the control **in exactly one place: the substituted string**. No provider was contacted,
> no credential was used and no model call was made. See **§11**.

---

## 1. Evidence vocabulary

The project's existing ladder, unchanged: **Runtime-verified** (executed against the installed
runtime) · **Contract-verified** (read from the published declaration of the *exact* version) ·
**Contract-confirmed** (vendor documentation or pinned runtime source) · **Unverified** ·
**Unsupported** · **Not implemented**.

## 2. What was verified, and what was not (summary)

| # | Question (from the stage brief) | Result |
| --- | --- | --- |
| 2.1 | Do `session.hook("context")` and `http.request` exist in the installed version? | **Runtime-verified**: both registered successfully; the shipped binary also contains the hook-name literals (`http.request` ×22, `http.response` ×17, `model.request` ×6, `experimental.ws.handshake` ×3) |
| 2.2 | Supported plugin registration mechanism | **Runtime-verified**: a project-local `.opencode/plugins/*.ts` file exporting a `Plugin`-shaped default is discovered (`plugin list`) and loaded (`loading plugin … role=server`) |
| 2.3 | Callback input and output types | **Contract-verified** (`ModelHooks<SessionHooks>`: callbacks return `Promise<void> \| void` — there is **no return-value channel**) and **runtime-verified** in the sense that the observed payload matched the declared shape |
| 2.4 | When callbacks execute relative to request assembly | **Runtime-verified**: during assembly, ~2 ms before the outbound request, once per attempt |
| 2.5 | Complete request or a partial representation? | **Runtime-verified**: the complete assembled request — `system` (4 parts), `messages`, `options`, `tools` (**12 definitions**) |
| 2.6 | Are tool responses separate identifiable parts? | ✅ **Runtime-verified** (§5): live requests carry distinct `tool-result` parts beside `tool-call` parts, each with the tool's `name` and its own result payload |
| 2.7 | Before or after compaction? | **Contract-verified**: `SessionRequestKind` is `primary \| compaction \| title \| generate` and a `compaction` content part type exists; the probe records the `kind` it sees. **Runtime: only `primary` observed**, and no `compaction` part has been seen |
| 2.8 | Can plugins observe without mutating? | **Runtime-verified + mechanically enforced**: the probe assigns nothing (deep-frozen graph test), and the host's own behaviour was identical with the probe present and absent |
| 2.9 | Can multiple plugin instances receive the same request? | **Runtime-verified: yes** — two project plugins received the same request with identical structure and timestamp |
| 2.10 | CLI vs Desktop assembly | **Unverified**: every run here used the Desktop's bundled CLI headlessly; the GUI's own session path was not driven |
| 2.11 | Do unsupported calls fail safely? | **Runtime-verified**: an unknown hook name neither blocks loading nor breaks registration in tests; a host that rejects a hook name is recorded as `unsupported` rather than thrown (see §6 for the runtime nuance) |
| 2.12 | Stable, experimental or internal-only? | **Contract-verified**: `session.hook("context")` sits in the documented `SessionDomain`; the `experimental.*` namespace is separate (`experimental.ws.*`). The line is a published API, not an internal one — but the runtime is a moving `2.0.x` line |

**No gap remains in the four questions this stage had to answer:** the hook exists, is registrable,
fires at the required timing, and carries complete model-visible tool results including a detectable
duplicate (§5).

**The one question this stage deliberately left open — whether a mutation made in that callback is
honoured — was answered afterwards, in §11 (Stage 1R): yes, it reaches the wire.**

## 3. Method (zero cost, zero provider contact)

Everything below ran in a disposable project (`%TEMP%\dr-token-stage1p\project`) with isolated
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`, containing only synthetic fixtures. The technique that makes the
timing measurement free:

```bash
CLI="$LOCALAPPDATA/Programs/@opencodedesktop/resources/opencode-cli.exe"
cd "$BASE/project"                       # synthetic fixtures only

# A project-local config points a BUILT-IN provider at a dead loopback endpoint,
# so request assembly is exercised but no provider can possibly be reached.
cat > .opencode/opencode.json <<'EOF'
{ "provider": { "opencode": { "options": { "baseURL": "http://127.0.0.1:9/v1" } } } }
EOF

XDG_CONFIG_HOME="<iso>/config" XDG_DATA_HOME="<iso>/data" \
DR_TOKEN_REQUEST_PROBE_EVIDENCE="<evidence>.jsonl" \
  "$CLI" run --standalone --auto --title "probe" --model opencode/big-pickle "Reply exactly: DONE." \
  < /dev/null
```

The harness plugin supplies both the environment and the sink, because the probe itself reads no
environment (which keeps `src/` to a single environment reader, as the repository's source guard
requires):

```ts
// <project>/.opencode/plugins/dr-token-request-probe.ts
import { appendFile } from 'node:fs/promises';
import { createRequestProbe } from '../vendor/dr-token-probe/dist/request-probe.js';

const evidenceFile = process.env['DR_TOKEN_REQUEST_PROBE_EVIDENCE'];
const { plugin } = createRequestProbe({
  env: process.env,                       // DR_TOKEN_REQUEST_PROBE=off disables the probe
  ...(evidenceFile === undefined
    ? {}
    : { sink: (record) => { void appendFile(evidenceFile, `${JSON.stringify(record)}\n`).catch(() => {}); } }),
});
export default plugin;
```

`stdin` must be **detached** (`< /dev/null`). Without it the CLI blocks on an inherited non-TTY stdin —
the same failure mode the Codex validation documented, and the cause of the only hang in this stage.

Two operational facts worth recording:

- **`debug config` reads `%USERPROFILE%\.config\opencode` even when `XDG_CONFIG_HOME` is set** (the
  runtime resolved `~/.config/opencode/opencode.jsonc`), so a Windows run is never fully config-isolated
  by XDG alone. It was only **read**, never modified.
- The dead-endpoint override was placed in the **project's** `.opencode/opencode.json`, so the user's
  global configuration was not touched.

## 4. Runtime-verified results

### 4.1 Discovery and loading

```text
$ opencode-cli.exe plugin list
ID                      VERSION  SOURCE
dr-token-request-probe  local    ...\project\.opencode\plugins\dr-token-request-probe.ts

# server log, once a session starts:
msg="loading plugin" id="...project\.opencode\plugins\dr-token-request-probe.ts" entrypoint=file:///... role=server
```

Discovery works identically with isolated and default config directories (both exit `0`).

### 4.2 Registration — both interfaces exist and accept registration

The probe's first record, written from inside `setup(ctx)`:

```json
{"kind":"probe-start","at":"2026-10-11T21:23:36.856Z","pluginId":"dr-token-request-probe",
 "capabilities":{"sessionHook":true,"sessionContextHook":true,"httpRequestHook":true,
                 "unknownHookAccepted":null}}
```

`sessionHook: true` means `ctx.session.hook` is a function; `sessionContextHook`/`httpRequestHook`
mean **both registrations were accepted without throwing**. No `unsupported` and no `internal-error`
record was ever emitted.

### 4.3 Invocation — the request hook fires during assembly, before the send

Eleven `context` invocations, each followed ~2 ms later by one `http-request` invocation:

```json
{"kind":"context","at":"2026-10-11T21:23:37.018Z","invocation":1,"sessionHash":"78ebe3fe5378fe6a",
 "systemParts":4,"messages":1,"roles":{"user":1},"partTypes":{"text":1},
 "toolResults":0,"toolResultNames":[],"distinctToolResultDigests":0,"duplicateGroups":0,
 "duplicateLaterParts":0,"elidableChars":0,"readToolDuplicateGroups":0,"hasCompactionPart":false,
 "toolDefinitions":12,"optionKeys":1,"scanned":{"messages":1,"parts":1,"digestedChars":0,"truncated":false}}
{"kind":"http-request","at":"2026-10-11T21:23:37.022Z","invocation":1,"requestKind":"primary",
 "urlIsString":true,"headerCount":10,"bodyPresent":true}
```

Reading it:

- **`systemParts: 4`, `messages: 1`, `toolDefinitions: 12`, `optionKeys: 1`** — the callback receives the
  **complete assembled request**, not a partial view: system instructions, the message list, the tool
  schema and the generation options. This is exactly the artifact Stage 1O needs.
- **1:1 pairing** between `context` and `http-request` invocations means the request the hook sees *is*
  the request that goes to the wire; there is no second, invisible assembly step.
- **`requestKind: "primary"`** is available on the model-call hook, giving the request-reason
  discrimination the `context` payload itself does not carry.
- **The request is the *final* one for the call**, but whether a mutated object would be honoured is a
  **different question and remains unverified** (§5). Observing is not influencing.

### 4.4 Repeated callbacks are retries, not duplication

The eleven invocations were spaced 2 s, 6 s, 4 s, 12 s, 9 s, 18 s, 8 s, 17 s, 10 s — the runtime's own
retry/backoff around `AI.Error: ConnectionRefused`. Each retry re-assembled the request and re-invoked
both hooks. So a counter that sees many `context` callbacks must expect **retries**, and a
"duplicate delivery" hypothesis is refuted for this runtime.

### 4.5 Multiple instances both receive the same request

Two project plugins (same probe, distinct ids and evidence files) recorded the **same request**:

| Instance | `at` (context) | `sessionHash` | structure |
| --- | --- | --- | --- |
| A | 21:25:40.434 | `2587a75f05b36b7e` | 4 system parts, 1 message, 12 tools |
| B | 21:25:40.434 | `2587a75f05b36b7e` | 4 system parts, 1 message, 12 tools |

The host does not arbitrate between plugins: every registered listener is invoked. Two optimizers on one
request would therefore both run — an ordering/safety question Stage 1O flagged as open, now with
evidence that it is real. (Note: instance B's own `probe-start` record names the probe's built-in plugin
id, not the harness's overridden one — a labelling detail of the harness, not of the host.)

### 4.6 The host behaves identically with and without the probe

| Run | Probe | Observed host behaviour |
| --- | --- | --- |
| A4 | full (registered, recording) | 11 assembly attempts, then transport failure against the dead endpoint |
| N2 | **file removed** (negative control) | same output (`> build · big-pickle`) and the same transport failure |
| N3 | `DR_TOKEN_REQUEST_PROBE=off` | identical failure; evidence contains exactly `{"kind":"bypassed"}` and **no** `context` record |

N1/N2/N3 were each bounded by a 30–45 s external timeout, so this is a same-window comparison of the
observable outcome and failure text — not a full behavioural equivalence proof. It does establish the
two things that matter: the bypass works at runtime, and the probe's presence does not change what the
host does.

## 5. The authorized live run — tool-result parts, observed

After explicit authorization, **one** session ran on a Free-tariff model with only synthetic content,
asking for the same file to be read twice. It completed normally (`exit 0`, the model replied `DONE.`),
made **3 model calls, all `kind: "primary"`, with no retry and no error**, and produced this sequence:

| Invocation | messages | `toolResults` | part types | duplicate evidence |
| --- | --- | --- | --- | --- |
| 1 | 1 | 0 | `text:1` | — |
| 2 | 3 | **1** (`read`) | `text:1, reasoning:1, tool-call:1, tool-result:1` | — |
| 3 | 5 | **2** (both `read`) | `text:2, reasoning:1, tool-call:2, tool-result:2` | **`duplicateGroups: 1`, `duplicateLaterParts: 1`, `elidableChars: 135`, `readToolDuplicateGroups: 1`** |

The third record in full:

```json
{"kind":"context","at":"2026-10-11T21:39:57.712Z","invocation":3,"sessionHash":"e6aa087d8cd52319",
 "systemParts":4,"messages":5,"roles":{"user":1,"assistant":2,"tool":2},
 "partTypes":{"text":2,"reasoning":1,"tool-call":2,"tool-result":2},
 "toolResults":2,"toolResultNames":["read"],"distinctToolResultDigests":1,
 "duplicateGroups":1,"duplicateLaterParts":1,"elidableChars":135,"readToolDuplicateGroups":1,
 "hasCompactionPart":false,"toolDefinitions":12,"optionKeys":1,
 "scanned":{"messages":5,"parts":7,"digestedChars":270,"truncated":false}}
```

What this establishes, precisely:

1. **Tool results are separate, identifiable, complete parts at the hook** — `tool-result` parts sit
   beside `tool-call` parts, carry the tool name (`read`) and a full result payload, and are counted
   independently. The `id`/`name`/`result` shape is exactly the contract Stage 1O was written against.
2. **Stage 1O's equivalence precondition is satisfiable on live traffic.** Two parts were
   **byte-identical** (`distinctToolResultDigests: 1` for two parts) and the earlier copy was **present
   in the same request** — E3 and E4 in the design, which is what makes the elision
   information-preserving.
3. **The duplicate was from the allowlisted tool** (`read`), the only tool in v1's allowlist, so the
   design's narrow scope is not an obstacle to the measurement it was designed for.
4. **The magnitude is real but modest** — 135 characters, against 4 system parts and 12 tool
   definitions. This is one synthetic case and says nothing about rates in real work; M1 must measure
   that.5. **`digestedChars: 270` = 135 × 2**, so the digest budget and the duplicate accounting are
internally consistent.

**The three preservation properties are not collapsed by this evidence.** What was observed is the
first of them — the later copy's **unique textual information** is still present in the same request.
**Original request structure** (retained parts byte-identical, order and tool-call/result pairing
intact) and **model behaviour / task correctness** are separate properties, and this observation
proves neither. The design keeps them as separate gates — Level 1's deterministic structural checker
and Level 2's paired control/treatment coding-task runs (design §6.2–§6.3) — both required before any
transformation may ship. No transformation is implemented in this stage, so no behaviour-preservation
claim is made.

**Privacy of the evidence file (raw sweep, not inspection by eye):** the file contains **no** fixture
content (`ALPHA`), **no** canary, **no** file name or path (`repeated-content`, `fixtures`,
`C:\Users`), **no** prompt text, **no** assistant output (`DONE`) and **no** raw session id (`ses_`) —
every one of those searches returned `false` against the raw bytes.

**Cost and disclosure:** one session, one free-tariff model, synthetic content only; the dead-endpoint
override was removed for this run and restored afterwards. Because config/data isolation is not
complete on this platform (§3), the session record was written to the normal OpenCode store — the
expected consequence of using the CLI, and the only thing this stage wrote outside `%TEMP%`.

### 5.1 Not verified by this stage (Stage 1P)

- **Compaction timing** (`kind: "compaction"`, `hasCompactionPart`) — contract-verified only; every
  live request was `primary`.
- **Desktop GUI sessions** — the GUI's own runtime was not driven; only the bundled CLI was.
- **Whether a mutated context would be honoured** — this stage proves *observation*; influence was a
  separate risk with its own milestone. **It was answered later, by Stage 1R: see §11.**
- **Whether the runtime's *own* read result is identical for a re-read in every case** — one file, one
  range, one session. A differing copy must (and does, by construction) disable elision.
- **`tool-argument` read identification on V2** remains as recorded in Stage 1N.

## 6. Unsupported-call behaviour

The probe records, never guesses:

- No `ctx.session.hook` at all → `unsupported: ["session.hook"]`, loading continues.
- A host that throws on a hook name → `unsupported: ["session.hook(context)"]`, and the other
  registration still succeeds.
- A payload that is not request-shaped (not an object, a non-object `context` member, or an object with
  neither `messages` nor `system`) → `unsupported: ["context-payload"]`. **It is never analysed into an
  all-zero "reading"**, because a fabricated empty request would be worse evidence than no evidence.
- An unknown hook name (`dr-token.unknown.hook`) is only probed when explicitly enabled; the real host
  accepted it without error, and the result is recorded as `unknownHookAccepted: true`.

## 7. Privacy, security and cost

| Property | Result |
| --- | --- |
| Provider contacted | **Never during the zero-cost phase** — the only provider was a dead loopback endpoint (`127.0.0.1:9`), and those runs failed with `ConnectionRefused` / transport error. The single authorized run did contact the Free-tariff model, with synthetic content only |
| Credentials used | None in the zero-cost phase. The authorized run used whatever credentials the CLI already had configured, as any normal session does; Dr. Token never read them |
| Prompt / tool-result content recorded | **None.** Records carry counts, key *names*, booleans and one-way digests only |
| URLs, header values, request bodies | **Never read.** `http-request` records `urlIsString`, a header *count* and body *presence*; a test asserts a body accessor is never invoked for content and that a secret header value cannot appear in any record |
| File paths | Not recorded (`sessionID` is stored only as a 16-hex digest) |
| Global configuration | Read (`debug config` resolves `~/.config/opencode`), **not modified** |
| User sessions | Never touched; every session was created in the disposable project |
| Writes | All inside `%TEMP%\dr-token-stage1p` |
| Token cost | **Zero** — no request reached a provider |

The planted canary (`REQUEST-PROBE-CANARY` in the synthetic fixture, and the prompt's own text) does not
appear in any record; the fixture content was never read because no tool ran.

## 8. Tests

`integrations/opencode/tests/request-probe.test.ts` — **29 tests**, all passing, covering the boundary
the probe actually uses (a fake host that records registrations):

registration (both hooks, promise-shaped registrations, missing hook domain, hook-name rejection,
unknown-hook fail-safety) · structural analysis (roles, part types, tools, options, duplicates,
differing copies, `content`-array results, error results, malformed payloads, bare vs nested payloads,
the model-call hook without reading the body) · neutrality (deep-frozen graph unchanged, callbacks return
nothing, hostile accessor contained, circular structure survived) · privacy (no prompt, result, path or
credential in any record; session ids hashed) · bounds, bypass (option, environment and host option),
disposal (including registrations that arrive after cleanup), instance isolation, duplicate delivery,
invocation counting, sink failure containment.

**Project isolation** sits at a different layer and is stated rather than tested in this suite: the
probe holds no mutable module-level state and records no project identity, because the host itself
scopes project-local plugin loading — the adapter's dedicated project-isolation and lifecycle suites
(`tests/project-scope.test.ts`, `tests/v2-lifecycle.test.ts`, runtime-anchored in Stage 1I) are
preserved untouched and still passing. **Independent sessions** are covered directly: no state is
shared between sessions, and every `sessionID` is stored only as a digest.

Two real defects were found by these tests while the probe was being written, and both were fixed:

1. **A registration that arrived after cleanup was leaked** — a promise-shaped registration resolved
   after the host unloaded the plugin and was never disposed. Now any registration that lands after
   cleanup is disposed immediately.
2. **A malformed payload was analysed into an all-zero request** instead of being reported as an
   unsupported measurement — a fabricated reading, which the project's rules forbid. Now a payload that
   is not request-shaped is reported as `context-payload`.

**Full-repository gate, run with these files in place:** `npm run typecheck` → **0** · `npm run build`
→ **0** · `npm test` → **0**, **488 passed / 0 failed** (core 19, benchmarks 70, codex 83, opencode 316
— the 459 pre-existing tests plus these 29) · `npm run verify` → **0** · `npm run benchmark` → **0**
(8 fixtures, 16 correctness checks passed / 0 failed, all verdicts `unavailable`; **no token savings
claimed**). The benchmark framework's configuration-comparison guard is unchanged — a differing
`configurationId` is still `invalid`; the declared single-axis variant it will need is specified for a
later stage in [docs/SAFE_MODE_DESIGN.md](SAFE_MODE_DESIGN.md) §6.4.

## 9. Reproducing this validation

```bash
CLI="$LOCALAPPDATA/Programs/@opencodedesktop/resources/opencode-cli.exe"

# 1. build + stage the probe into a disposable project
npm run build --workspace @dr-token/opencode-observer
BASE="$LOCALAPPDATA/Temp/dr-token-stage1p"
mkdir -p "$BASE/project/.opencode/plugins" "$BASE/project/.opencode/vendor/dr-token-probe" \
         "$BASE/project/fixtures" "$BASE/iso/config" "$BASE/iso/data"
cp -r integrations/opencode/dist "$BASE/project/.opencode/vendor/dr-token-probe/dist"
#    ...and write the harness plugin from §3 (it forwards process.env to the probe)
#    plus one synthetic fixture file.

# 2. discovery and load (no model call)
cd "$BASE/project"
XDG_CONFIG_HOME="$BASE/iso/config" XDG_DATA_HOME="$BASE/iso/data" "$CLI" plugin list

# 3. assembly without a provider (zero cost) — see §3 for the project config
XDG_CONFIG_HOME="$BASE/iso/config" XDG_DATA_HOME="$BASE/iso/data" \
DR_TOKEN_REQUEST_PROBE_EVIDENCE="$BASE/evidence.jsonl" \
  "$CLI" run --standalone --auto --title "probe" --model opencode/big-pickle "Reply exactly: DONE." \
  < /dev/null
```

Expected: `plugin list` shows `dr-token-request-probe`; the run fails against the dead endpoint; the
evidence file contains one `probe-start` with all three capabilities `true`, then one `context` +
`http-request` pair per attempt, and no content of any kind.

## 10. Limitations of this report

1. **One live tool-result duplicate was observed** (§5), on one synthetic file in one session. That
   satisfies the precondition; it says nothing about how often it happens in real work, which M1 must
   measure.
2. **Neutrality is a same-window comparison** (§4.6), not a full behavioural equivalence proof, and it
   rests on the probe's construction (no assignment anywhere, no return value) plus tests that would
   catch a mutation.
3. **Only the bundled CLI was driven.** The Desktop GUI's own runtime remains unverified, as it has been
   since Stage 1E.
4. **Compaction, title and generate request kinds were not observed** — only `primary`.
5. **Timing claims are about ordering, not latency**: "before the send" is established by invocation
   pairing and ~2 ms separation, not by a synchronized instrument.
6. **`Context` members beyond what is needed were not probed** — the probe deliberately ignores
   provider/HTTP details it does not need.

---

## 11. Stage 1R — influence validation (runtime-verified)

**Status (2026-10-11): RUNTIME-VERIFIED at zero cost.** A value written into an assembled request inside
`ctx.session.hook("context")` is the value the runtime sends to the provider. Stage 1P settled *delivery*
(the callback fires, with the complete request, before the send); this stage settles *influence* (the host
honours the edit).

**Verdict: influence PROVEN — not inferred, and not disproven.** The outbound body was captured at a
private loopback endpoint that a built-in provider was pointed at. No provider was contacted, no
credential was used, no model call was made and no cost was incurred.

### 11.1 What was asked, and what was measured

| Question | Result |
| --- | --- |
| Does a mutation made in the `context` callback reach the outbound request? | **Runtime-verified: yes.** In both treatment runs the provider body contained the substituted string and not the original one |
| Does the mutation reach the request when it is *disabled*? | **Runtime-verified: no.** The disabled run and the observe-mode control sent the unmodified content |
| Does anything unrelated change? | **Runtime-verified: no.** A full structural diff of the whole captured body against the control found **exactly one** difference, at the substitution site |
| Do malformed payloads fail safely? | **Unit-tested + runtime-verified in shape.** Every refusal path is recorded, never guessed, and never throws into the host (§11.6) |
| Can the experiment activate itself in production? | **No.** The probe is not exported from the package entry point, and a source guard fails if any shipped module imports it |
| Can the `context` callback distinguish request kinds? | **No — reconfirmed. The payload has no `kind`.** Its keys are `sessionID, model, system, messages, options, agent, tools`; the kind exists only on `model.request`/`http.request` |

### 11.2 Method (zero cost, zero provider contact)

A disposable project (`%TEMP%\dr-token-stage1r\project`, isolated `XDG_CONFIG_HOME`/`XDG_DATA_HOME`,
synthetic fixtures only) with three pieces and nothing else:

1. **A capture server**, not a model — `integrations/opencode/scripts/stage1r-capture-server.mjs`. It
   listens on loopback, records every request it receives, and answers as a provider would: one `read`
   tool call first, then a final text answer. It is a validation aid, not product code.
2. **A project config** pointing the *built-in* provider at it:
   `{ "provider": { "opencode": { "options": { "baseURL": "http://127.0.0.1:<port>/v1" } } } }`.
3. **A harness plugin** (`<project>/.opencode/plugins/dr-token-m2-probe.ts`, eleven lines) that loads the
   probe from a staged copy of `dist/` and forwards the process environment and sink to it.

The protocol was learned in a capture-only recon run rather than assumed: the runtime posts
`POST /v1/chat/completions` with `application/json`, `stream: true`,
`stream_options.include_usage: true`, `max_completion_tokens`, **12 tool definitions** and roles
`system,user` for the first call and `system,user,assistant,tool` for the second. The capture server
answers in exactly that shape, which is why a session completes normally (`exit 0`, model replies
`DONE.`) and a **second real request** is assembled with the tool result inside it.

**The permitted edit** (the only assignment in the whole probe): one `tool-result` part whose
`result.type` is `text`, whose value is a string, and whose value contains the configured marker
**exactly once in the entire request** — `result.value` is rewritten with that single occurrence
replaced. The fixture is `fixtures/m2-content.json` =
`{"lines":["ALPHA","BETA","GAMMA"],"note":"DRTOKEN-M2-ORIGINAL-7f3a"}`; the substitution swaps the
marker word only (`ORIGINAL` → `MODIFIED`), so **the replacement is the same length as the original**.

**Five sessions**, each with a fresh capture server, a fresh session id and the same prompt:

| Run | Switch | Marker pair |
| --- | --- | --- |
| `control` | `observe` (a marker configuration is supplied, but mutation is not enabled) | present → modified |
| `treatment1` | `mutate` | present → modified |
| `treatment2` | `mutate` (repeat, for determinism) | present → modified |
| `disabled` | `off` (the probe registers nothing) | present → modified |
| `notarget` | `mutate`, but the configured marker does not exist in the request | absent → replaced |

### 11.3 Exact mutation and control results

All five sessions: `exit 0`, one `read` of the synthetic fixture, model reply `DONE.`, **two** outbound
requests, both `kind: "primary"`, no retry.

| Run | Request 1 (21,244 bytes, `system,user`) | Request 2 (`system,user,assistant,tool`) | Byte-identical to control request 2? | Probe record for invocation 2 |
| --- | --- | --- | --- | --- |
| `control` | no marker | **contains the original** | yes (baseline) | target found (1 part, 1 occurrence), nothing written |
| `treatment1` | no marker | **contains the substituted value; the original is absent** | **no — exactly 1 difference** | `applied: true`, 117 → 117 characters |
| `treatment2` | no marker | **contains the substituted value; the original is absent** | **no — exactly 1 difference** | `applied: true`, 117 → 117 characters |
| `disabled` | no marker | **contains the original** | yes | `bypassed` — nothing was registered |
| `notarget` | no marker | **contains the original** | yes | `attempted: true`, `applied: false`, refusal `target-absent` |

The structural diff of the whole captured body (control request 2 vs treatment request 2), recursive,
over every key and array element:

```json
{"path":"$.messages[3].content","bytes":[117,117],"commonPrefix":102,"left":"ORIGINAL","right":"MODIFIED"}
```

That is the **only** difference. The model id, all 4 system parts, every other message and part, all 12
tool definitions, the option map and the generation parameters are byte-identical, and both bodies are
21,632 bytes. Because the substitution is deliberately **the same length**, the byte count cannot mask a
content change — the presence/absence of each marker string is decisive on its own:
`{ORIG: true, MOD: false}` for the control and `{ORIG: false, MOD: true}` for each treatment.

Two further details worth recording:

- In the treatment runs the **first** invocation (before any tool result existed) reported
  `attempted: true, applied: false, refusal: target-absent` — the gate refuses rather than guessing, even
  in `mutate` mode.
- The `disabled` run produced exactly one probe record (`bypassed`) and an unmodified body, so the switch
  is a real gate and not a label.

### 11.4 Why it works (mechanism, `source-confirmed` in the shipped build)

The pinned `2.0.24` binary is a single-file executable whose embedded application bundle is readable.
The two functions that decide this question are the hook trigger and the request builder:

```js
// @opencode/PluginHooks — the payload object goes to each callback, and the SAME object is returned
s = b(function* (l, c, f) {
  for (let h of e.get(r(l, c)) ?? []) {
    if (h.options?.providerID !== undefined && h.options.providerID !== of(f)) continue;
    yield* h.callback(f);            // ← the callback receives the payload itself
  }
  return f;                          // ← and the trigger returns that same object
})

// @opencode/SessionModelRequest.prepare — the provider request is built from the trigger's RETURN value
R  = yield* f({ sessionID, model, system, messages, options }, toolsByName);
...  system: R.system, messages: I9(g9(R.messages, M.capabilities)), options: ..., tools: ...
```

So the object a plugin edits **is** the object the request is assembled from, and the runtime's own
post-processing (`g9`/`I9`, which only rewrites media/file parts a model cannot accept) leaves a `text`
tool result untouched. This is `source-confirmed` — read from the exact pinned build — and the captures
above are the runtime verification of it. It is also why the probe needed no return value: the V2
contract has no return channel, and none is required.

### 11.5 Safety and isolation

- **Explicitly gated, disabled by default.** Mutation requires *both* a `mutation` configuration *and*
  the switch value `mutate`. The switch values `off`/`false`/`0`/`no`/`disabled` register nothing at all,
  and any other value (including unset) can only observe.
- **One assignment, one scope.** The only write anywhere in the module is one substitution inside one
  `text` tool result's value. `system`, `options` (model settings), `tools`, `agent`, permissions and
  tool-call inputs are never assigned, deleted or redefined — asserted by a unit test that freezes all of
  them, and confirmed at run level by the whole-body diff above.
- **Refusals are recorded, never guessed:** `invalid-config`, `target-absent`, `target-ambiguous`,
  `target-occurrences-not-unique`, `assignment-failed` (a frozen payload). An assignment failure is
  contained and reported; it never becomes an exception in the host.
- **Content-free by construction.** Probe records carry counts, key *names*, booleans, lengths and
  one-way digests — never prompt text, file paths, tool-result content or header values. A sweep of all
  five probe record files found **none** of the fixture text, the markers, the file name, the prompt
  text, the substituted marker or any credential-shaped string. The capture server records header
  **names** only (a value lookup returns `false`); the raw bodies exist solely as disposable `%TEMP%`
  evidence and are not committed, quoted or summarised beyond booleans and lengths here.
- **No production path.** The probe is not exported from the package entry point, no shipped module
imports it, it reads no environment of its own (the single-environment-reader source guard still holds)
and it writes no file (the single-writer guard still holds). Both are enforced by the source guard and
by tests.
- **Containment unchanged.** The observer's own defaults, its bypass switch, its failure posture and the
  adapters' registrations are untouched; the experiment ran in a disposable project that was removed
  afterwards (plugin file, vendored copy and project config deleted; every capture server stopped —
  confirmed by probing all five experiment ports, all closed).

### 11.6 Tests

The probe ships with **34 unit tests** (`tests/request-mutation-probe.test.ts`) and **4 source guards**
(`tests/source-guard.test.ts`), covering: registration and capability reporting; every disable value;
the mode-resolution table; observe mode leaving a deep-frozen payload untouched; the payload key names
and the absent `kind`; the nested-`context` payload variant; the http-request record; the marker booleans
appearing only when the caller named the markers; the successful single substitution and its exact text;
the control-versus-treatment switch comparison on identical payloads; frozen `system`/`options`/`tools`/
tool-call inputs; each refusal (`target-absent`, `target-ambiguous`, `target-occurrences-not-unique`,
`invalid-config`, `assignment-failed`); non-`text` results (`content`, `json`, non-string value); the
marker in `system`, in a tool-call input, or outside the per-payload bound; the retry path; a throwing
accessor; a throwing sink; the record cap; malformed payload shapes; the default limits; and that the
module is unreachable from the package entry point.

### 11.7 Reproducing this validation

```bash
CLI="$LOCALAPPDATA/Programs/@opencodedesktop/resources/opencode-cli.exe"
BASE="$LOCALAPPDATA/Temp/dr-token-stage1r"
mkdir -p "$BASE/project/.opencode/plugins" "$BASE/project/.opencode/vendor/dr-token-probe/dist" \
         "$BASE/project/fixtures" "$BASE/iso/config" "$BASE/iso/data" "$BASE/evidence"
cp -r integrations/opencode/dist/. "$BASE/project/.opencode/vendor/dr-token-probe/dist/"
# fixture: {"lines":["ALPHA","BETA","GAMMA"],"note":"DRTOKEN-M2-ORIGINAL-7f3a"}
# harness plugin: loads createMutationProbe from ../vendor/.../request-mutation-probe.js,
#                forwards process.env and a JSONL sink (see §11.2).

node integrations/opencode/scripts/stage1r-capture-server.mjs \
  --capture "$BASE/evidence/<run>-capture.jsonl" --port 8792 --mode scripted \
  --read-path "fixtures/m2-content.json" --tool-turns 1 &

# config: { "provider": { "opencode": { "options": { "baseURL": "http://127.0.0.1:8792/v1" } } } }
cd "$BASE/project"
# DR_TOKEN_M2_PROBE: `observe` (control) | `mutate` (treatment) | `off` (disabled run)
XDG_CONFIG_HOME="$BASE/iso/config" XDG_DATA_HOME="$BASE/iso/data" \
DR_TOKEN_M2_PROBE=observe \
DR_TOKEN_M2_PROBE_EVIDENCE="$BASE/evidence/<run>-probe.jsonl" \
DR_TOKEN_M2_ORIGINAL=DRTOKEN-M2-ORIGINAL-7f3a \
DR_TOKEN_M2_REPLACEMENT=DRTOKEN-M2-MODIFIED-7f3a \
  "$CLI" run --standalone --auto --title "stage1r" --model opencode/big-pickle \
  "Read fixtures/m2-content.json and report the note field." < /dev/null
```

Expected: the session completes (`exit 0`, `DONE.`); the capture file holds two requests; the second
contains the marker pair's original (control/disabled/notarget) or the substituted value
(treatment) — and nothing else differs between them.

### 11.8 What this stage does **not** claim

1. **A same-length substitution proves the content path, not any size change.** It says nothing about
   whether a *shorter* body is framed, parsed or billed as expected; M2's apply-mode wire check (design
   §6.3) is still required before any elision is shipped, and it still needs its own length-only
   measurement.
2. **No token or cost claim.** Nothing here measured tokens, and the experiment's own server reports none.
   A smaller request is not a saving until M4/M5's benchmark schema and controls say so.
3. **One synthetic file, one tool (`read`), one result, `kind: "primary"` only.** Compaction, title and
   generate requests were not produced, and — reconfirmed here — the `context` payload cannot even
   distinguish them, so apply mode must enforce its primary-only gate where the kind *is* observable.
4. **Only the bundled CLI was driven.** The Desktop GUI's own runtime remains unverified, as in every
   previous stage.
5. **The probe could not read the body in-process.** At `http.request` the body is a `ReadableStream`
   (`bodyType: "ReadableStream"`, no length), so the wire evidence comes from the capture server rather
   than from the probe. This is recorded as a finding, not worked around: extending the probe to consume a
   clone would change its cost and its obligations for evidence the capture already provides.
6. **This is not an implementation.** No elision, no apply mode, no Safe Mode code, no product change:
   the probe exists only to answer the influence question, and stays out of the shipped package.

### 11.9 Files changed in Stage 1R

| File | Change |
| --- | --- |
| `integrations/opencode/src/request-mutation-probe.ts` | **New.** The gated influence probe (not exported) |
| `integrations/opencode/tests/request-mutation-probe.test.ts` | **New.** 34 tests |
| `integrations/opencode/scripts/stage1r-capture-server.mjs` | **New.** The loopback capture server used as a stand-in provider |
| `integrations/opencode/tests/source-guard.test.ts` | Four guards: unreachable from the entry point, imported by no shipped module, no environment read, no file write, one documented assignment |
| `docs/OPENCODE_REQUEST_HOOK_VALIDATION.md` | This section, and the header/§2/§5.1 updates |
| `docs/SAFE_MODE_DESIGN.md`, `docs/SAFE_MODE_M1_OBSERVATION.md`, `docs/adr/0003-safe-mode-strategy.md`, `README.md` | The influence question is recorded as answered, with its limits |

**Verification (all five commands, exit 0):** `npm run typecheck`, `npm run build`, `npm test`
(**582 passed, 0 failed** — 19 core, 70 benchmark, 83 Codex, 410 OpenCode), `npm run verify` (582 passed,
0 failed) and `npm run benchmark` (16 correctness checks passed, 8 fixtures `unavailable`, no savings
claim). All 544 tests that existed before this stage still pass.
