import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ARM_DRIVER_PATH, FREE_ONLY_PRIMARY_MODEL } from '../src/level2/index.js';
import { createTempDir, removeDir } from './helpers.js';

/**
 * The free-only guard, measured at the driver's own boundary.
 *
 * The point of these tests is not that a function returns a string; it is that the **process that
 * would spawn a session** refuses, before it writes an artifact and before it starts anything, when
 * the run is outside the approved free-only envelope. So each case runs the real
 * `level2-arm.mjs` as a child process and asserts on what it did *not* leave behind.
 *
 * No session, no model and no network is involved: the refusals under test are the ones that
 * happen before the CLI is spawned, and the model list is reached only through a catalogue read the
 * driver cannot complete in this environment (it is refused for exactly that reason).
 */

const runDriver = promisify(execFile);

interface DriverRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function driver(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<DriverRun> {
  try {
    const result = await runDriver(process.execPath, [ARM_DRIVER_PATH, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/** A disposable arm run: a repository, a prompt, an output directory and a long-dead CLI path. */
async function armRun(model: string, mode: 'live' | 'rehearse' = 'live') {
  const root = await createTempDir('dr-token-free-only-');
  const repo = join(root, 'repo');
  const out = join(root, 'artifacts');
  const promptFile = join(root, 'prompt.txt');
  await mkdir(repo, { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(promptFile, 'Read data/note.txt and reply exactly DONE.\n', 'utf8');
  const args = [
    '--mode',
    mode,
    '--repo',
    repo,
    '--prompt-file',
    promptFile,
    '--arm',
    'control',
    '--out',
    out,
    '--model',
    model,
    '--task-id',
    'read-and-edit-total',
    '--run-id',
    'read-and-edit-total:p0:control',
    '--run-nonce',
    'nonce-free-only',
    '--pair-index',
    '0',
    '--attempt',
    '1',
    '--repository-revision',
    'rev-1',
    '--prompt-hash',
    'hash-1',
    // Deliberately a CLI that cannot be resolved to a runtime: every case here must be refused
    // before any CLI question is asked, so a run that needed this path would be visible as a
    // different failure rather than as a pass.
    '--cli',
    join(root, 'no-such-cli.exe'),
    ...(mode === 'rehearse' ? ['--base-url', 'http://127.0.0.1:1/v1'] : []),
  ];
  return { root, repo, out, args };
}

/**
 * True when the run never reached a session.
 *
 * Three facts, not one: no artifact was written (the driver writes it only after a session), no CLI
 * log exists (it is written after the CLI exits), and every append-only evidence file the driver
 * creates up front is still **empty** (a session would have appended lines to them). An empty file
 * is the driver's own pre-created evidence slot, not evidence.
 */
function nothingWasRun(out: string): boolean {
  const empty = (name: string): boolean => {
    const path = join(out, name);
    return !existsSync(path) || readFileSync(path, 'utf8').length === 0;
  };
  return (
    !existsSync(join(out, 'arm-observation.json')) &&
    !existsSync(join(out, 'arm-cli.log')) &&
    empty('session-summary.jsonl') &&
    empty('wire.jsonl') &&
    empty('wire-kinds.jsonl')
  );
}

describe('the arm driver refuses a run outside the free-only policy', () => {
  it('refuses a model that is not the approved primary, in both modes', async () => {
    // Two identifiers, so the check that catches them is visible: a paid model is outside the
    // policy, and the *backup* — which is approved for auxiliary calls — is still not the primary a
    // measured arm may run on. The command line and the configuration must agree either way.
    for (const model of ['opencode/gpt-5.4-mini', 'opencode/muse-spark-1.3-contributor-free']) {
      for (const mode of ['live', 'rehearse'] as const) {
        const run = await armRun(model, mode);
        try {
          const result = await driver(run.args);
          expect(result.code, `${model} in ${mode}`).toBe(2);
          expect(result.stderr).toMatch(/the free-only policy pins the primary to/);
          expect(result.stderr).toMatch(/Refusing to start/);
          expect(nothingWasRun(run.out)).toBe(true);
        } finally {
          await removeDir(run.root);
        }
      }
    }
  });

  it('refuses an approved model whose price the runtime cannot confirm, leaving no artifact', async () => {
    const run = await armRun(FREE_ONLY_PRIMARY_MODEL);
    try {
      const result = await driver(run.args);
      // The approved model passes the approval list, so the refusal comes from the evidence that
      // is missing: this environment reports no resolved configuration for the repository, and the
      // driver will not start a session whose free-only settings it cannot show took effect.
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/did not apply the free-only model configuration/);
      expect(nothingWasRun(run.out)).toBe(true);
      // The configuration file is the only thing written before the refusal, and it is the
      // approved one — never a partial or arm-specific document.
      expect(existsSync(join(run.repo, '.opencode', 'opencode.json'))).toBe(true);
    } finally {
      await removeDir(run.root);
    }
  });

  /**
   * The request-kind probe the driver generates into the arm's repository.
   *
   * It is read as the **generated** file, not as the driver's source: what a session loads is the
   * file, and the file is what decides whether an absent title request is an observation or a
   * silence. The distinction is the whole point — the pinned runtime accepts any hook name it is
   * given without validating it and then never calls one it does not dispatch, so a probe built on
   * a synthetic per-kind name registers cleanly, records nothing, and reads exactly like a session
   * that composed no auxiliary request.
   */
  it('generates the request-kind probe on the one hook the runtime dispatches every request to', async () => {
    const run = await armRun(FREE_ONLY_PRIMARY_MODEL);
    try {
      // The refusal that ends this run is unrelated (no resolved configuration in this
      // environment); the plugin files are written before it, which is what makes them readable
      // here with no session involved.
      const result = await driver(run.args);
      expect(result.code).toBe(2);
      const probePath = join(run.repo, '.opencode', 'plugin', 'zz-level2-wire.ts');
      expect(existsSync(probePath)).toBe(true);
      const probe = readFileSync(probePath, 'utf8');
      // The measured hook name, and the request's own kind read out of its payload.
      expect(probe).toMatch(/const requestHook = "model\.request";/);
      expect(probe).toMatch(/context\.session\.hook\(requestHook,/);
      expect(probe).toMatch(/detail\.kind === 'string'/);
      expect(probe).toContain('payloadKeys');
      // Never a synthetic per-kind name in a registration: those are accepted and never fire. The
      // comment above the probe names the trap, so the assertions are on the *call*, not on the
      // text of the file.
      expect(probe).not.toMatch(/hook\(\s*'model\.request:/);
      expect(probe).not.toMatch(/'model\.request:'\s*\+/);
      expect(probe).not.toMatch(/hook\(requestHook\s*\+/);
      // An unrecognized kind is recorded, not dropped, so a request nobody can name still ends up
      // in the counts the policy is checked against.
      expect(probe).toContain('unclassified');
    } finally {
      await removeDir(run.root);
    }
  });

  it('fails closed when the policy module does not export the request-kind vocabulary', async () => {
    const run = await armRun(FREE_ONLY_PRIMARY_MODEL);
    try {
      // A policy module complete enough to pass the earlier checks but carrying no hook name: the
      // driver must refuse rather than register a probe whose hook it cannot name, because the
      // counts it produced would then be unverifiable in exactly the way the title claim cannot
      // afford.
      const stub = join(run.root, 'stub-policy.mjs');
      await writeFile(
        stub,
        [
          'export function freeOnlyModelConfig() {',
          '  return { model: ' + JSON.stringify(FREE_ONLY_PRIMARY_MODEL) + ', small_model: null, enabled_providers: ["opencode"], autoupdate: false, share: "disabled", compaction: { auto: false } };',
          '}',
          'export function freeOnlyModelConfigDigest() {',
          '  return "stub-digest";',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const result = await driver(run.args, { DR_TOKEN_FREE_POLICY_MODULE: stub });
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/does not export the request-kind vocabulary/);
      expect(nothingWasRun(run.out)).toBe(true);
    } finally {
      await removeDir(run.root);
    }
  });

  it('fails closed when the policy module itself cannot be imported', async () => {
    const run = await armRun(FREE_ONLY_PRIMARY_MODEL);
    try {
      const result = await driver(run.args, {
        DR_TOKEN_FREE_POLICY_MODULE: join(run.root, 'no-such-policy-module.js'),
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/free-only model policy could not be imported/);
      expect(nothingWasRun(run.out)).toBe(true);
    } finally {
      await removeDir(run.root);
    }
  });

  /**
   * The price gate, measured at the driver's boundary.
   *
   * This is the gate that decides whether a session may spend at all, and until now it was
   * exercised only at the policy level: the *driver's* own pre-spawn refusal was asserted for a
   * substituted model (the approval list) but never for a price row. The gap mattered because the
   * price and the approval list are different questions — the approved model is exactly the one
   * whose row has to be zero, so a run that reached the session on an approved-but-priced model
   * would be a paying run that every other check would call free.
   *
   * There is no way to make the installed runtime report a paid row for the approved model in this
   * environment (its private server reports a catalogue only when it has an account, and the
   * approved model's row is zero on the account that does exist), so the runtime is **stubbed**
   * here — and stubbed in a way that cannot make an inference possible: the stand-in is a Node
   * module preloaded into the CLI process, it answers the two read-only `api` calls, and it exits
   * without a network client when it is asked to `run` a session. The last case is the control
   * that keeps the refusals meaningful: with a zero row the very same driver walks past the gate
   * and asks for the session, which is what shows the refusal in the other cases is the price and
   * not something else about the harness.
   */
  describe('the price gate and the model-guard wiring gate', () => {
    const MODEL = FREE_ONLY_PRIMARY_MODEL;
    const ZERO_ROW = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    const catalogue = (cost: unknown): string =>
      JSON.stringify({
        data: [{ providerID: 'opencode', modelID: 'mimo-v2.6-flash-free', ...(cost === undefined ? {} : { cost: [cost] }) }],
      });

    /**
     * A runtime stand-in the driver can actually start.
     *
     * `--cli` has to be an executable, so the stand-in is loaded into `node` itself through
     * `NODE_OPTIONS=--require`, which the driver passes to its CLI calls unchanged. The module
     * acts as the runtime only when its own argv looks like a runtime invocation, so the driver's
     * process (started with the same preload) keeps its own arguments, and every invocation it
     * does handle is appended to a log — which is how "the session was never requested" is read
     * rather than assumed.
     */
    async function stubRuntime(
      root: string,
      repo: string,
      catalogueJson: string,
    ): Promise<Record<string, string>> {
      const logPath = join(root, 'runtime-calls.jsonl');
      const stubPath = join(root, 'stub-runtime.cjs');
      await writeFile(logPath, '', 'utf8');
      await writeFile(
        stubPath,
        [
          "const fs = require('node:fs');",
          'const logPath = process.env.DR_TOKEN_FAKE_RUNTIME_LOG;',
          // The runtime is invoked as `node.exe <verb> ...`, and node resolves that first token
          // as a script path (measured: `process.argv[1]` is the absolute `...\<verb>`), so the
          // verb is read out of its basename. That is also what keeps the driver's own process —
          // started with this same preload — from being mistaken for the runtime.
          "const verb = String(process.argv[1] ?? '').split(/[\\\\/]/).pop();",
          'const argv = [verb, ...process.argv.slice(2)];',
          "const verbs = ['api', 'run', 'debug', 'serve', 'auth', 'models', 'session'];",
          'if (logPath === undefined || verbs.indexOf(verb) < 0) return;',
          "fs.appendFileSync(logPath, JSON.stringify(argv) + '\\n', 'utf8');",
          'const write = (value) => { process.stdout.write(JSON.stringify(value) + "\\n"); process.exit(0); };',
          "const model = { providerID: 'opencode', model: 'mimo-v2.6-flash-free' };",
          "const auxiliary = { providerID: 'opencode', model: 'muse-spark-1.3-contributor-free' };",
          "if (argv[0] === 'api' && argv[1] === 'config.get') {",
          '  write([{',
          '    path: process.env.DR_TOKEN_FAKE_CONFIG_PATH,',
          '    info: {',
          '      model,',
          '      agents: { title: { model: auxiliary } },',
          '      compaction: { auto: false },',
          "      update: 'disable',",
          "      share: 'disabled',",
          '      experimental: {',
          '        policies: [',
          "          { action: 'provider.use', effect: 'deny', resource: '*' },",
          "          { action: 'provider.use', effect: 'allow', resource: 'opencode' },",
          '        ],',
          '      },',
          '      permissions: [',
          "        'external_directory',\n        'shell',\n        'subagent',\n        'webfetch',",
          "      ].map((action) => ({ action, effect: 'deny', resource: '*' })),",
          '    },',
          '  }]);',
          '}',
          "if (argv[0] === 'api' && argv[1] === 'model.list') write(JSON.parse(process.env.DR_TOKEN_FAKE_CATALOGUE));",
          '// A session request: recorded above, and refused here with no network client at all.',
          'process.exit(3);',
          '',
        ].join('\n'),
        'utf8',
      );
      return {
        // `--require=` with the value attached: NODE_OPTIONS is split on spaces, and a path that
        // happens to contain one would otherwise be read as two options.
        NODE_OPTIONS: `--require=${stubPath}`,
        DR_TOKEN_FAKE_RUNTIME_LOG: logPath,
        DR_TOKEN_FAKE_CATALOGUE: catalogueJson,
        DR_TOKEN_FAKE_CONFIG_PATH: join(repo, '.opencode', 'opencode.json'),
      };
    }

    const runCalls = (logPath: string): string[][] =>
      readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);

    it('refuses a non-zero price row before it asks for a session', async () => {
      const run = await armRun(MODEL);
      try {
        const env = await stubRuntime(
          run.root,
          run.repo,
          catalogue({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }),
        );
        const result = await driver([...run.args, '--cli', process.execPath], env);
        expect(result.code).toBe(2);
        // The refusal names the tier that is not zero, so a paid row cannot be reported as
        // "no catalogue".
        expect(result.stderr).toMatch(/is not free: the standalone runtime prices/);
        expect(result.stderr).toMatch(/input=3/);
        expect(result.stderr).toMatch(/cacheWrite=3\.75/);
        expect(result.stderr).toMatch(/Nothing was spawned/);
        expect(nothingWasRun(run.out)).toBe(true);
        const calls = runCalls(env['DR_TOKEN_FAKE_RUNTIME_LOG'] ?? '');
        // It read the configuration and the catalogue, and then stopped: the read-only calls are
        // the only ones the runtime was ever asked for.
        expect(calls.map((argv) => argv.slice(0, 2).join(' '))).toEqual([
          'api config.get',
          'api model.list',
        ]);
        expect(calls.every((argv) => argv.indexOf('--standalone') >= 0)).toBe(true);
      } finally {
        await removeDir(run.root);
      }
    });

    it('refuses a listed model with no price row, and a catalogue with no model in it', async () => {
      const cases: readonly (readonly [string, string, RegExp])[] = [
        ['no row', catalogue(undefined), /reports no price row/],
        ['no catalogue', JSON.stringify({ data: [] }), /reported no model catalogue at all/],
        [
          'unlisted model',
          JSON.stringify({ data: [{ providerID: 'opencode', modelID: 'a-different-model', cost: [ZERO_ROW] }] }),
          /does not offer/,
        ],
      ];
      for (const [label, catalogueJson, expected] of cases) {
        const run = await armRun(MODEL);
        try {
          const env = await stubRuntime(run.root, run.repo, catalogueJson);
          const result = await driver([...run.args, '--cli', process.execPath], env);
          expect(result.code, label).toBe(2);
          expect(result.stderr, label).toMatch(expected);
          expect(nothingWasRun(run.out), label).toBe(true);
          expect(
            runCalls(env['DR_TOKEN_FAKE_RUNTIME_LOG'] ?? '').some((argv) => argv[0] === 'run'),
            `${label}: no session was requested`,
          ).toBe(false);
        } finally {
          await removeDir(run.root);
        }
      }
    });

    it('lets the very same run past the gate when every tier is zero', async () => {
      const run = await armRun(MODEL);
      try {
        const env = await stubRuntime(run.root, run.repo, catalogue(ZERO_ROW));
        const result = await driver([...run.args, '--cli', process.execPath], env);
        // The control: with a zero row the price gate does not fire and the driver asks the
        // runtime for the session. The stand-in refuses to run one, so the arm ends as a failed
        // session — which is the point: the *gate* is what differs between this case and the
        // refusals above, and nothing else about the invocation.
        const calls = runCalls(env['DR_TOKEN_FAKE_RUNTIME_LOG'] ?? '');
        expect(calls.some((argv) => argv[0] === 'run')).toBe(true);
        expect(result.stderr).not.toMatch(/is not free|reports no price row|no model catalogue at all/);
      } finally {
        await removeDir(run.root);
      }
    });

    /**
     * The **pre-transmission model guard**'s wiring gate, at the same boundary as the price gate.
     *
     * The price gate answers "may this run start on a model whose price is zero?". The guard gate
     * answers the question that survives even a perfect answer to that one: "would a request naming
     * a *different* model have been refused before it was sent?". The driver can only know that if
     * the plugin module it is about to load actually exports the guard — a build without it would
     * start a session whose requests nothing bounds, and the artifact's guard block would then report
     * nothing while looking complete.
     *
     * So each case here hands the driver a module that is a faithful build *except* for one export,
     * runs it against a stub runtime whose read-only answers are perfect, and requires the refusal to
     * happen before any session is asked for. That last part is the whole point: the failure being
     * guarded against is a session that runs.
     */
    it('refuses to start when the plugin module cannot supply the pre-transmission guard', async () => {
      const pluginModule = fileURLToPath(
        new URL('../../integrations/opencode/dist/index.js', import.meta.url),
      );
      const cases: readonly (readonly [string, string, RegExp])[] = [
        [
          'no guard factory',
          'createModelGuardPluginV2',
          /does not export `createModelGuardPluginV2`/,
        ],
        [
          'no evidence summarizer',
          'summarizeModelGuardEvidence',
          /does not export `summarizeModelGuardEvidence`/,
        ],
      ];
      for (const [label, omit, expected] of cases) {
        const run = await armRun(FREE_ONLY_PRIMARY_MODEL);
        try {
          const modulePath = join(run.root, 'partial-plugin-module.mjs');
          const kept = [
            'startCostGovernor',
            'decideCostGovernor',
            'latestSessionCostUsd',
            'planGovernorArming',
            'summarizeContainmentEvidence',
            'createContainmentGuardPluginV2',
            'createModelGuardPluginV2',
            'summarizeModelGuardEvidence',
            'CONTAINMENT_DENIED_TOOLS',
          ].filter((name) => name !== omit);
          await writeFile(
            modulePath,
            [
              `import * as real from ${JSON.stringify(pathToFileURL(pluginModule).href)};`,
              'export default real.default;',
              ...kept.map((name) => `export const ${name} = real.${name};`),
              '',
            ].join('\n'),
            'utf8',
          );
          const env = await stubRuntime(run.root, run.repo, catalogue(ZERO_ROW));
          const result = await driver([...run.args, '--cli', process.execPath, '--plugin-module', modulePath], env);
          expect(result.code, label).toBe(2);
          expect(result.stderr, label).toMatch(/the pre-transmission model guard cannot be shown to be in force/);
          expect(result.stderr, label).toMatch(expected);
          expect(result.stderr, label).toMatch(/Nothing was spawned/);
          expect(nothingWasRun(run.out), label).toBe(true);
          // No session was requested, from either the guard gate or the price gate: the stub's own log
          // is the evidence, and a `run` verb in it would mean a session had been asked for.
          const calls = runCalls(env['DR_TOKEN_FAKE_RUNTIME_LOG'] ?? '');
          expect(
            calls.some((argv) => argv[0] === 'run'),
            `${label}: no session was requested`,
          ).toBe(false);
        } finally {
          await removeDir(run.root);
        }
      }
    });

    it('generates the guard plugin from the policy envelope, with the configuration\u2019s own digest', async () => {
      const run = await armRun(FREE_ONLY_PRIMARY_MODEL);
      try {
        // The refusal this run ends with is unrelated (a stub is not supplied here); the generated
        // plugin and the guard's evidence slot are written before it, which is what makes them
        // readable with no session involved.
        const result = await driver(run.args);
        expect(result.code).toBe(2);
        const guardPath = join(run.repo, '.opencode', 'plugin', 'zz-level2-model-guard.ts');
        expect(existsSync(guardPath)).toBe(true);
        const generated = readFileSync(guardPath, 'utf8');
        // It loads the shipped factory — there is no second implementation of the guard.
        expect(generated).toMatch(/createModelGuardPluginV2/);
        expect(generated).toMatch(/integrations\/opencode\/dist\/index\.js/);
        // The envelope is the policy's, not the file's own idea of it: the approved pair, every kind
        // the runtime declares, and the digest of the configuration this repository received.
        expect(generated).toMatch(/opencode\/mimo-v2\.6-flash-free/);
        expect(generated).toMatch(/opencode\/muse-spark-1\.3-contributor-free/);
        expect(generated).toMatch(/"primary"/);
        expect(generated).toMatch(/"compaction"/);
        expect(generated).toMatch(/policyDigest/);
        // Its own evidence file, created empty up front: an empty file is the driver's evidence slot,
        // and a session that runs appends to it.
        const evidencePath = join(run.out, 'model-guard.jsonl');
        expect(existsSync(evidencePath)).toBe(true);
        expect(readFileSync(evidencePath, 'utf8')).toBe('');
        // No provider filter: a filtered registration would let a request from an unnamed provider
        // skip the guard entirely, which is the opposite of fail-closed.
        expect(generated).not.toMatch(/providerID/);
      } finally {
        await removeDir(run.root);
      }
    });
  });

  it('reports the free-only verdict through its preflight without starting a session', async () => {
    const run = await armRun(FREE_ONLY_PRIMARY_MODEL);
    try {
      const result = await driver([...run.args, '--mode', 'preflight']);
      // A preflight starts nothing and spends nothing, so it must exit 0 and still report the
      // policy: the verdict is what an operator reads before authorizing anything.
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? '{}') as Record<
        string,
        unknown
      >;
      expect(report['mode']).toBe('preflight');
      const freeOnly = report['freeOnly'] as Record<string, unknown>;
      expect(freeOnly['primaryModel']).toBe(FREE_ONLY_PRIMARY_MODEL);
      expect(freeOnly['approvedModels']).toHaveLength(2);
      expect(Array.isArray(freeOnly['refusals'])).toBe(true);
      // Never inferred from the name: the verdict is `refused` unless every tier came back zero.
      expect(['free', 'refused']).toContain(freeOnly['verdict']);
      expect(nothingWasRun(run.out)).toBe(true);
    } finally {
      await removeDir(run.root);
    }
  });
});
