/**
 * The **pre-transmission model-guard probe**: enforcement measured at the endpoint.
 *
 * ## The question
 *
 * The free-only policy restricts the *provider*, and the benchmark's gates refuse a *measurement*
 * whose requests named anything outside the approved pair. Neither can stop a request: the provider
 * policy admits every model that provider offers, free and paid alike, and a gate that refuses a
 * measurement is a gate that refuses a measurement *after* the call. The one remaining question is
 * therefore narrow and empirical:
 *
 * > when a session asks for a model outside the approved pair, is the request refused **before** it
 * > is dispatched?
 *
 * The guard's own evidence says what it decided. That is not the answer. This probe answers it the
 * only way that counts: it starts a **real** pinned-runtime session — no credential, no model call,
 * nothing billed — pointed at a loopback scripted provider, and reads what the *endpoint* received.
 * A refused request must be missing from the endpoint's own capture, and the unguarded control must
 * be present in it. If both of those hold for the same model and the same session shape, the guard is
 * what stopped it.
 *
 * ## Why this does not go through the arm driver
 *
 * Every other offline session in this harness is driven by `level2-arm.mjs`, and the containment probe
 * is one of them. This probe deliberately is not, and the reason is the point of the whole stage: the
 * arm driver **refuses to start a session whose model is not the approved primary** (`--model` and the
 * configuration must agree, and the configuration must re-derive to the free-only envelope). That is a
 * property worth keeping — the driver can never be talked into running a paid model — but it is also
 * why a probe cannot use it to ask what happens when one is requested. So the probe builds its own
 * session, with the same isolation environment, the same repository configuration shape, the same
 * generated-plugin conventions and the same shipped plugin module, and with exactly one difference:
 * the model under test is chosen by the case rather than pinned by the policy.
 *
 * The consequence is stated rather than hidden: **a result from this probe is not an arm measurement.**
 * It says something about what the pinned runtime and the shipped guard do with a request; the
 * rehearsal and the arm driver's own artifact say what the live path does. Both are needed, and the
 * probe's findings are never merged into a benchmark pair.
 *
 * ## The case matrix
 *
 * | Case | What it answers |
 * | --- | --- |
 * | approved primary, guarded | the guard does not refuse legitimate work, and the session still runs |
 * | approved auxiliary used for a `title` request, guarded | the approved auxiliary is permitted *for an auxiliary kind* |
 * | an unapproved model of the **same provider**, guarded | refused before transmission, and the endpoint never sees it |
 * | the same model, **unguarded** | the control: the runtime would have sent it, so the refusal above is the guard |
 * | an identifier the runtime does not know | refused before any request is assembled, by *resolution*, not by the guard |
 * | the approved primary with an unapproved **title** model, guarded | a request assembled mid-session outside the envelope is refused |
 *
 * ## What it cannot show
 *
 * It observes the installed runtime revision this repository pins, on a loopback provider. It cannot
 * show that a host which never calls the hook would be bounded — that is why the driver refuses to
 * start when the guard cannot register, and why a run without guard evidence is refused as a
 * measurement. And it says nothing about a live provider: a canary is what would confirm this on the
 * wire the experiment will actually use.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FREE_ONLY_APPROVED_MODELS,
  FREE_ONLY_AUXILIARY_MODEL,
  FREE_ONLY_PRIMARY_MODEL,
  endpointModelIds,
  freeOnlyModelConfig,
  freeOnlyModelConfigDigest,
  modelGuardPolicy,
} from './free-model-policy.js';
import { digest } from './repos.js';
import { DEFAULT_CLI_PATH } from './runner.js';
import { startScriptedProvider } from './scripted-provider.js';

/**
 * The shipped plugin module, which is what the probe loads.
 *
 * The same resolution the arm driver uses for its default: the built output of
 * `integrations/opencode`. The relative path is identical from `src/` and from `dist/`, so the probe
 * behaves the same under `vitest` and from the compiled CLI.
 */
export const MODEL_GUARD_PROBE_PLUGIN = fileURLToPath(
  new URL('../../../integrations/opencode/dist/index.js', import.meta.url),
);

/**
 * A model of the **same provider** that is not in the approved pair.
 *
 * Read from this account's own catalogue on 2026-10-12 (`api model.list`): `opencode` offers 42
 * models, of which 12 are zero-priced. This one is deliberately *free* — `input`, `output`, `cache
 * read` and `cache write` all zero — because it is the strongest case for the guard rather than the
 * weakest: the price gate would not have caught it, and the only thing that can refuse it is the
 * approval list itself. It resolves on the isolated runtime, so the runtime is perfectly willing to
 * route a request to it; the unguarded control proves that in the same run.
 *
 * A constant, not a lookup: a probe that needed an account catalogue to know which model to refuse
 * could not run in the rehearsal environment at all, and the rehearsal is where this is exercised.
 */
export const PROBE_UNAPPROVED_MODEL = 'opencode/exo-free';

/** An identifier no runtime knows: resolution fails before any request is assembled. */
export const PROBE_UNKNOWN_MODEL = 'opencode/dr-token-no-such-model';

/** The title the guard probe supplies when it wants no title request composed. */
const SUPPRESSED_TITLE = 'dr-token-model-guard-probe';

/** The containment fragment every session here receives, as the arm driver writes it. */
const CONTAINMENT_FRAGMENT = {
  permission: {
    external_directory: 'deny',
    bash: 'deny',
    task: 'deny',
    webfetch: 'deny',
  },
  agent: { build: { steps: 20 }, general: { steps: 20 } },
} as const;

/** How one probe case ended, as the endpoint and the guard's record describe it. */
export type ModelGuardProbeOutcome =
  /** The session ran; every body the endpoint received named an approved model. */
  | 'transmitted-approved'
  /**
   * An unapproved model reached the endpoint.
   *
   * This is what the **unguarded control** is supposed to produce — it is the evidence that the
   * runtime would have sent the model, and therefore that the guarded case's silence is the guard and
   * not the runtime — and it is the failure this whole stage is about whenever the guard was loaded.
   */
  | 'transmitted-unauthorized'
  /** The guard refused the request the session tried to make; nothing was sent at all. */
  | 'refused-before-transmission'
  /**
   * The guard refused a request assembled mid-session and the session continued on approved models.
   *
   * The distinction from `refused-before-transmission` matters: it shows what a refusal costs a
   * session (one request, not the run) and that the layer acts on requests the pre-spawn
   * configuration and the command line cannot see.
   */
  | 'refused-with-session-continuing'
  /** The runtime could not resolve the model, so no request was ever assembled. */
  | 'runtime-refused-model'
  /** The session failed for another reason; the case proves nothing on its own. */
  | 'inconclusive';

/** One case in the probe's matrix. */
export interface ModelGuardProbeCase {
  readonly id: string;
  /** What the session is started with (`--model`). */
  readonly sessionModel: string;
  /** What the repository configuration names as its primary; defaults to the session model. */
  readonly configModel?: string;
  /**
   * The model configured for the runtime's `title` agent.
   *
   * Setting it is also what *un*suppresses the title: the probe passes `--title` only when no title
   * model is asked for, so a configured title model is what makes the runtime compose a real title
   * request — the mid-session request this layer exists for.
   */
  readonly titleModel?: string;
  /** False loads no guard plugin at all: the non-vacuity control. */
  readonly guard: boolean;
  /** What this case is here to show. */
  readonly expectation: ModelGuardProbeOutcome;
}

/** What one probe case measured. Content-free: counts, model identifiers, reasons and booleans. */
export interface ModelGuardProbeCaseResult {
  readonly id: string;
  readonly sessionModel: string;
  readonly titleModel: string | undefined;
  readonly guard: boolean;
  readonly expected: ModelGuardProbeOutcome;
  readonly outcome: ModelGuardProbeOutcome;
  /** The session process's exit code, or -1 when it never started. */
  readonly exitCode: number;
  readonly durationMs: number;
  /** Requests the **endpoint** received, from the provider's own capture. */
  readonly endpointRequests: number;
  /** The model each received body named, in order. */
  readonly endpointModels: readonly string[];
  /**
   * Endpoint-named models that are outside the approved pair.
   *
   * The measurement this whole stage is about: non-empty means an unapproved model reached a provider
   * endpoint. Empty is the requirement, and it is only meaningful alongside the control case, which
   * shows the same model arriving when the guard is absent.
   */
  readonly unauthorizedModelsAtEndpoint: readonly string[];
  readonly guardLoaded: boolean;
  readonly guardHookRegistered: boolean;
  readonly guardInvocations: number;
  readonly guardAllowed: number;
  readonly guardRefused: number;
  /** `reason@kind[model]` for each refusal, in order. Identifiers only, never request content. */
  readonly guardRefusals: readonly string[];
  readonly guardMisconfigured: boolean;
  readonly guardPolicyDigest: string;
  /** True when the runtime reported that it does not know the model at all. */
  readonly runtimeRefusedModel: boolean;
  /** The last few lines of the session's own output, with escapes stripped, for diagnosis. */
  readonly outputTail: readonly string[];
  readonly workRoot: string;
  /** True when the case ended the way it was designed to. */
  readonly asExpected: boolean;
}

/** The probe's whole matrix, and the properties it establishes. */
export interface ModelGuardProbeRun {
  readonly cases: readonly ModelGuardProbeCaseResult[];
  /**
   * The two facts that together establish pre-transmission enforcement:
   *
   * - an unapproved model is refused by the guard and **never appears at the endpoint**;
   * - the same model **does appear** at the endpoint in the unguarded control.
   *
   * Either one alone proves nothing: without the first the guard does not stop anything, and without
   * the second the endpoint's silence could simply mean the runtime never sends that model.
   */
  readonly unapprovedRefusedBeforeTransmission: boolean;
  readonly unapprovedControlReachedEndpoint: boolean;
  /** The approved primary still reaches the endpoint, so the guard refuses no legitimate work. */
  readonly approvedPrimaryReachedEndpoint: boolean;
  /** The approved auxiliary is permitted for an auxiliary request and reaches the endpoint. */
  readonly approvedAuxiliaryReachedEndpoint: boolean;
  /** A request assembled mid-session (the title agent) outside the envelope is refused. */
  readonly midSessionSubstitutionRefused: boolean;
  /** The runtime refuses an unknown identifier by resolution, before any guard decision. */
  readonly unknownModelRefusedByRuntime: boolean;
  /** No case ever let an unapproved model reach the endpoint while the guard was loaded. */
  readonly noUnauthorizedModelEverReachedEndpoint: boolean;
  readonly notes: readonly string[];
}

/** Options for {@link runModelGuardProbe}. */
export interface ModelGuardProbeOptions {
  /** Where each case's disposable repository and capture are created. */
  readonly workspaceRoot: string;
  readonly cliPath?: string;
  /** Override the plugin module under test (a broken build is a valid probe subject). */
  readonly pluginModule?: string;
  /** A matrix other than the default. */
  readonly cases?: readonly ModelGuardProbeCase[];
  readonly timeoutMs?: number;
  readonly onProgress?: (line: string) => void;
}

/**
 * The default matrix.
 *
 * `guard: false` appears exactly once, against the unapproved model, because that is the case whose
 * endpoint evidence has to be positive for the others to mean anything.
 */
export function modelGuardProbeCases(): readonly ModelGuardProbeCase[] {
  return [
    {
      id: 'approved-primary',
      sessionModel: FREE_ONLY_PRIMARY_MODEL,
      guard: true,
      expectation: 'transmitted-approved',
    },
    {
      id: 'approved-auxiliary-as-title',
      sessionModel: FREE_ONLY_PRIMARY_MODEL,
      titleModel: FREE_ONLY_AUXILIARY_MODEL,
      guard: true,
      expectation: 'transmitted-approved',
    },
    {
      id: 'unapproved-model-guarded',
      sessionModel: PROBE_UNAPPROVED_MODEL,
      guard: true,
      expectation: 'refused-before-transmission',
    },
    {
      id: 'unapproved-model-unguarded',
      sessionModel: PROBE_UNAPPROVED_MODEL,
      guard: false,
      // The control's expectation is the opposite of the guarded case's, deliberately: proof that
      // the runtime sends this model is what makes the guarded case's empty capture evidence.
      expectation: 'transmitted-unauthorized',
    },
    {
      id: 'unknown-model-guarded',
      sessionModel: PROBE_UNKNOWN_MODEL,
      guard: true,
      expectation: 'runtime-refused-model',
    },
    {
      id: 'unapproved-title-model-guarded',
      sessionModel: FREE_ONLY_PRIMARY_MODEL,
      titleModel: PROBE_UNAPPROVED_MODEL,
      guard: true,
      expectation: 'refused-with-session-continuing',
    },
  ];
}

/** Strip ANSI escapes so a session's own output can be recorded as plain text. */
function plain(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Run one case.
 *
 * Everything the case needs is created under its own root and can be inspected afterwards, because
 * the findings point at it: the repository, the generated plugin, the guard's evidence file and the
 * provider's capture.
 */
export async function runModelGuardProbeCase(
  testCase: ModelGuardProbeCase,
  options: ModelGuardProbeOptions,
): Promise<ModelGuardProbeCaseResult> {
  const cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
  const pluginModule = options.pluginModule ?? MODEL_GUARD_PROBE_PLUGIN;
  const root = join(options.workspaceRoot, `model-guard-probe-${testCase.id}-${randomUUID().slice(0, 8)}`);
  const repo = join(root, 'repo');
  const pluginsDir = join(repo, '.opencode', 'plugin');
  const isolatedConfig = join(root, 'iso', 'config');
  const isolatedData = join(root, 'iso', 'data');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(isolatedConfig, { recursive: true });
  mkdirSync(isolatedData, { recursive: true });

  const dataPath = join(repo, 'data.txt');
  writeFileSync(dataPath, `${'x'.repeat(600)}\n`, 'utf8');
  const promptPath = join(root, 'prompt.txt');
  const prompt = 'Read data.txt and reply exactly DONE.\n';
  writeFileSync(promptPath, prompt, 'utf8');

  // The repository configuration: the *same* free-only fragment an arm receives, with the model
  // under test substituted. The substitution is the case — the driver refuses it, which is why the
  // probe starts the session itself. The digest is recorded so a reader can see which envelope the
  // guard was given, not which one the configuration carries.
  const configModel = testCase.configModel ?? testCase.sessionModel;
  const modelFragment = freeOnlyModelConfig(configModel, FREE_ONLY_AUXILIARY_MODEL);
  const config = {
    ...modelFragment,
    ...CONTAINMENT_FRAGMENT,
    ...(testCase.titleModel === undefined
      ? {}
      : {
          agents: {
            title: { model: { providerID: 'opencode', model: testCase.titleModel.split('/')[1] ?? '' } },
          },
        }),
  };
  writeFileSync(join(repo, '.opencode', 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const evidencePath = join(root, 'model-guard.jsonl');
  writeFileSync(evidencePath, '', 'utf8');
  const policy = modelGuardPolicy();
  if (testCase.guard) {
    // The generated plugin does its own file I/O, exactly as the arm driver's generated guard does:
    // the shipped package keeps its rule that only its opt-in summary sink writes anything.
    writeFileSync(
      join(pluginsDir, 'zz-model-guard.ts'),
      `import { appendFileSync } from 'node:fs';\nimport { createModelGuardPluginV2 } from ${JSON.stringify(pathToFileURL(pluginModule).href)};\n\nconst evidencePath = ${JSON.stringify(evidencePath)};\nconst policy = ${JSON.stringify(policy)};\n\nexport default createModelGuardPluginV2({\n  policy,\n  onEvidence: (line) => {\n    appendFileSync(evidencePath, JSON.stringify(line) + String.fromCharCode(10), 'utf8');\n  },\n});\n`,
      'utf8',
    );
  }

  const capturePath = join(root, 'provider-capture.jsonl');
  options.onProgress?.(`model guard probe (${testCase.id}): one scripted session on ${testCase.sessionModel}`);
  const provider = await startScriptedProvider({ capturePath, readPath: dataPath, toolCalls: 1 });
  const started = Date.now();
  let exitCode = -1;
  let output = '';
  try {
    const result = spawnSync(
      cliPath,
      [
        'run',
        '--standalone',
        '--auto',
        '--model',
        testCase.sessionModel,
        // Supplying the title is what stops the runtime composing one; a case that *wants* a title
        // request therefore omits it and configures a title model instead.
        ...(testCase.titleModel === undefined ? ['--title', SUPPRESSED_TITLE] : []),
        prompt,
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          // The runtime resolves the project it belongs to — and therefore which project plugins it
          // loads — from its environment, and the private homes keep the session isolated from the
          // developer's own installation. Same three variables the arm driver sets.
          PWD: repo,
          XDG_CONFIG_HOME: isolatedConfig,
          XDG_DATA_HOME: isolatedData,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: { opencode: { options: { baseURL: provider.baseUrl } } },
          }),
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: options.timeoutMs ?? 180_000,
      },
    );
    exitCode = typeof result.status === 'number' ? result.status : -1;
    output = plain(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  } finally {
    provider.stop();
  }
  const durationMs = Date.now() - started;

  const endpointModels = readFileSync(capturePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        const body =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)['body']
            : undefined;
        const parsedBody = typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
        const named =
          typeof parsedBody === 'object' && parsedBody !== null
            ? (parsedBody as Record<string, unknown>)['model']
            : undefined;
        return typeof named === 'string' ? [named] : [];
      } catch {
        return [];
      }
    });
  const approvedEndpointIds = endpointModelIds(FREE_ONLY_APPROVED_MODELS);
  const unauthorizedModelsAtEndpoint = [
    ...new Set(endpointModels.filter((id) => !approvedEndpointIds.includes(id))),
  ];
  const guardEvidence = readFileSync(evidencePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
  const guardRefusals = guardEvidence
    .filter((line) => line['kind'] === 'refused')
    .map((line) => {
      const reason = typeof line['reason'] === 'string' ? line['reason'] : 'unrecorded';
      const kind = typeof line['requestKind'] === 'string' ? `@${line['requestKind']}` : '';
      const model = typeof line['model'] === 'string' ? `[${line['model']}]` : '';
      return `${reason}${kind}${model}`;
    });
  const guardRefused = guardRefusals.length;
  const guardAllowed = guardEvidence.filter((line) => line['kind'] === 'allowed').length;
  const runtimeRefusedModel = /Model unavailable/.test(output);

  // The outcome is decided from the endpoint and the guard's own record, never from the exit code: a
  // guard refusal and a resolution failure both end a session non-zero, and they are different facts.
  const outcome: ModelGuardProbeOutcome =
    endpointModels.length === 0
      ? guardRefused > 0
        ? 'refused-before-transmission'
        : runtimeRefusedModel
          ? 'runtime-refused-model'
          : 'inconclusive'
      : unauthorizedModelsAtEndpoint.length > 0
        ? 'transmitted-unauthorized'
        : guardRefused > 0
          ? 'refused-with-session-continuing'
          : 'transmitted-approved';

  return {
    id: testCase.id,
    sessionModel: testCase.sessionModel,
    titleModel: testCase.titleModel,
    guard: testCase.guard,
    expected: testCase.expectation,
    outcome,
    exitCode,
    durationMs,
    endpointRequests: endpointModels.length,
    endpointModels,
    unauthorizedModelsAtEndpoint,
    guardLoaded: guardEvidence.some((line) => line['kind'] === 'loaded'),
    guardHookRegistered: guardEvidence.some((line) => line['kind'] === 'hook-registered'),
    guardInvocations: guardAllowed + guardRefused,
    guardAllowed,
    guardRefused,
    guardRefusals,
    guardMisconfigured: guardEvidence.some((line) => line['kind'] === 'misconfigured'),
    guardPolicyDigest: guardEvidence.flatMap((line) =>
      typeof line['policyDigest'] === 'string' ? [line['policyDigest']] : [],
    )[0] ?? '',
    runtimeRefusedModel,
    outputTail: output.trim().split(/\r?\n/).slice(-6),
    workRoot: root,
    asExpected: outcome === testCase.expectation,
  };
}

/**
 * Run the whole matrix and reduce it to the properties the stage needs.
 *
 * A trial whose *control* failed to reach the endpoint is reported as a note rather than being read
 * as a success: "the guard refused it" and "the runtime never had it" look identical from the
 * endpoint's silence, and only the unguarded control tells them apart.
 */
export async function runModelGuardProbe(
  options: ModelGuardProbeOptions,
): Promise<ModelGuardProbeRun> {
  const cases = options.cases ?? modelGuardProbeCases();
  const results: ModelGuardProbeCaseResult[] = [];
  for (const testCase of cases) {
    results.push(await runModelGuardProbeCase(testCase, options));
  }

  const notes: string[] = [];
  const byId = (id: string): ModelGuardProbeCaseResult | undefined => results.find((r) => r.id === id);
  const guarded = byId('unapproved-model-guarded');
  const control = byId('unapproved-model-unguarded');
  const primary = byId('approved-primary');
  const auxiliary = byId('approved-auxiliary-as-title');
  const unknown = byId('unknown-model-guarded');
  const substitution = byId('unapproved-title-model-guarded');

  if (control !== undefined && control.endpointRequests === 0) {
    notes.push(
      'the unguarded control never reached the endpoint, so its silence cannot be compared with the guarded case in this environment; the refusal evidence stands on the guard\'s own record and the endpoint count alone cannot be read as enforcement here',
    );
  }
  for (const result of results) {
    if (!result.asExpected) {
      notes.push(
        `case ${result.id} ended as ${result.outcome} rather than ${result.expected} (exit ${String(result.exitCode)}, ${String(result.endpointRequests)} endpoint request(s)): ${result.outputTail.join(' | ')}`,
      );
    }
  }
  const misconfigured = results.find((result) => result.guardMisconfigured);
  if (misconfigured !== undefined) {
    notes.push(`the guard reported a missing envelope in case ${misconfigured.id}, so it refused everything`);
  }

  return {
    cases: results,
    unapprovedRefusedBeforeTransmission:
      guarded !== undefined &&
      guarded.guardHookRegistered &&
      guarded.guardRefused > 0 &&
      guarded.unauthorizedModelsAtEndpoint.length === 0,
    unapprovedControlReachedEndpoint:
      control !== undefined && control.unauthorizedModelsAtEndpoint.length > 0,
    approvedPrimaryReachedEndpoint:
      primary !== undefined &&
      primary.endpointRequests > 0 &&
      primary.unauthorizedModelsAtEndpoint.length === 0,
    approvedAuxiliaryReachedEndpoint:
      auxiliary !== undefined &&
      auxiliary.endpointModels.some((id) => id === FREE_ONLY_AUXILIARY_MODEL.split('/')[1]),
    midSessionSubstitutionRefused:
      substitution !== undefined &&
      substitution.outcome === 'refused-with-session-continuing' &&
      substitution.unauthorizedModelsAtEndpoint.length === 0 &&
      // The primary work still ran: the refusal stopped one request, not the session.
      substitution.endpointModels.some((id) => endpointModelIds().includes(id)),
    unknownModelRefusedByRuntime: unknown !== undefined && unknown.runtimeRefusedModel,
    noUnauthorizedModelEverReachedEndpoint: results.every(
      (result) => !result.guard || result.unauthorizedModelsAtEndpoint.length === 0,
    ),
    notes,
  };
}

/** Remove one case's disposable repository, once its findings have been read. */
export function removeModelGuardProbeCase(result: ModelGuardProbeCaseResult): void {
  rmSync(result.workRoot, { recursive: true, force: true });
}

/** The digest the probe's sessions are configured with, so a caller can compare the guard's record. */
export function probePolicyDigest(sessionModel: string = FREE_ONLY_PRIMARY_MODEL): string {
  return freeOnlyModelConfigDigest(freeOnlyModelConfig(sessionModel, FREE_ONLY_AUXILIARY_MODEL));
}

/** True when the CLI and the built plugin module both exist, so the probe can run at all. */
export function modelGuardProbeAvailable(pluginModule?: string): boolean {
  return existsSync(DEFAULT_CLI_PATH) && existsSync(pluginModule ?? MODEL_GUARD_PROBE_PLUGIN);
}

/** Re-exported so a caller does not have to import the policy module for these two names. */
export { FREE_ONLY_PRIMARY_MODEL, digest as probeDigest };
