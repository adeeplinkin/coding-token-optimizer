/**
 * Stage 1T experiment setup — writes the disposable project used by the request-kind reconnaissance
 * and the end-to-end elision wire test.
 *
 * It exists so the two questions this stage must answer can be answered against a **real** OpenCode
 * runtime and a **real** outbound request without contacting a provider, spending anything or using a
 * credential: the provider under test is pointed at the loopback capture server
 * (`stage1r-capture-server.mjs`), and no model is ever called.
 *
 * Usage:
 *   node stage1t-setup.mjs [--base <dir>]
 *
 * It creates `<base>/project` (fixtures + the harness plugin), `<base>/iso/config`,
 * `<base>/iso/data` and `<base>/evidence`, and prints the paths a caller needs. Nothing outside
 * `--base` is touched, and every file it writes is synthetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = { base: join(process.env.LOCALAPPDATA ?? '.', 'Temp', 'dr-token-stage1t') };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--base') {
      args.base = argv[index + 1];
      index += 1;
    }
  }
  if (typeof args.base !== 'string' || args.base.length === 0) {
    throw new Error('--base requires a directory');
  }
  return args;
}

const { base } = parseArgs(process.argv);
const project = join(base, 'project');
// `.opencode/plugin` (singular) is the directory the 2.0.24 runtime discovers; verified with
// `plugin list` in this stage.
const plugins = join(project, '.opencode', 'plugin');
const fixtures = join(project, 'fixtures');

for (const directory of [
  plugins,
  fixtures,
  join(base, 'iso', 'config'),
  join(base, 'iso', 'data'),
  join(base, 'evidence'),
]) {
  mkdirSync(directory, { recursive: true });
}

/** Well over the 400-character eligibility threshold, and obviously synthetic. */
const bigContent = {
  lines: Array.from(
    { length: 24 },
    (_unused, index) =>
      `STAGE1T-SYNTHETIC-LINE-${String(index).padStart(2, '0')} 0123456789 abcdefghijklmnopqrstuvwxyz`,
  ),
  note: 'synthetic stage1t fixture for duplicate tool-result elision',
};

/** Deliberately below the 400-character eligibility threshold. */
const smallContent = { lines: ['STAGE1T-SMALL-LINE-A', 'STAGE1T-SMALL-LINE-B'] };

writeFileSync(join(fixtures, 'big-content.json'), `${JSON.stringify(bigContent, null, 2)}\n`, 'utf8');
writeFileSync(join(fixtures, 'small-content.json'), `${JSON.stringify(smallContent, null, 2)}\n`, 'utf8');
writeFileSync(join(project, 'README.md'), '# stage1t disposable project\nsynthetic fixtures only\n', 'utf8');

/**
 * The harness plugin body. It is loaded by the real runtime from the disposable project, registers the
 * session hooks this stage wants to observe, records a content-free line per invocation, and (only in
 * `apply` mode) calls the **shipped** elision module from `dist/`.
 *
 * The V2 plugin shape in 2.0.24 is `{ id, setup(context) }`; a bare default function is discovered by
 * nothing (`plugin list` shows an empty table), which is why this is an object.
 */
const harnessBody = `
import { appendFileSync } from 'node:fs';

const evidencePath = process.env.DR_TOKEN_1T_EVIDENCE;
const hooksToRegister = process.env.DR_TOKEN_1T_HOOKS ?? 'all';
const elisionMode = process.env.DR_TOKEN_1T_ELISION ?? 'off';
const moduleUrl = process.env.DR_TOKEN_1T_MODULE;
const requestKind = process.env.DR_TOKEN_1T_KIND ?? 'primary';

function record(entry) {
  try {
    if (evidencePath) appendFileSync(evidencePath, JSON.stringify(entry) + '\\n');
  } catch {
    // Recording must never become the failure.
  }
}

// Diagnostics that do not depend on the environment being forwarded to the plugin host, so a
// missing DR_TOKEN_1T_* variable can never look like a plugin that observed nothing.
function boot(entry) {
  try {
    appendFileSync(process.cwd() + '/.opencode/1t-harness-boot.log', JSON.stringify(entry) + '\\n');
  } catch {
    // Ignore.
  }
}

function safeKeys(value) {
  try {
    return value !== null && typeof value === 'object' ? Object.keys(value) : [];
  } catch {
    return ['threw'];
  }
}

export default {
  id: 'dr-token-stage1t-harness',
  async setup(context) {
    boot({
      setup: true,
      hasEvidence: typeof evidencePath === 'string',
      hasModule: typeof moduleUrl === 'string',
      hooks: hooksToRegister,
      elision: elisionMode,
      sessionHook: typeof context?.session?.hook,
    });
    const names =
      hooksToRegister === 'all'
        ? ['prompt', 'context', 'compaction', 'generate', 'title', 'model.request', 'http.request', 'http.response', 'retry']
        : ['context', 'model.request'];

    let elision;
    if (elisionMode !== 'off' && typeof moduleUrl === 'string') {
      try {
        elision = await import(moduleUrl);
      } catch (error) {
        record({ event: 'module-import-failed', error: String(error && error.name) });
      }
    }

    for (const name of names) {
      try {
        await context.session.hook(name, async (payload) => {
          const entry = { event: 'session-hook', hook: name, keys: safeKeys(payload) };
          try {
            if (payload && typeof payload.kind === 'string') entry.kind = payload.kind;
            if (payload && Array.isArray(payload.messages)) entry.messages = payload.messages.length;
            if (payload && payload.request && typeof payload.request.method === 'string') entry.httpMethod = payload.request.method;
          } catch {
            entry.read = 'threw';
          }
          if (name === 'context' && elision !== undefined && elisionMode !== 'off') {
            try {
              entry.elision = elision.applySafeModeElision(payload, {
                requestKindBasis: requestKind,
                enabled: elisionMode === 'apply',
              });
            } catch (error) {
              entry.elisionThrew = String(error && error.name);
            }
          }
          record(entry);
        });
      } catch (error) {
        record({ event: 'registration-failed', hook: name, error: String(error && error.name) });
      }
    }

    return () => {};
  },
};
`;

writeFileSync(join(plugins, 'dr-token-1t-harness.ts'), `${harnessBody.trim()}\n`, 'utf8');

process.stdout.write(
  [
    `base=${base}`,
    `project=${project}`,
    `plugin=${join(plugins, 'dr-token-1t-harness.ts')}`,
    `bigFixture=${join(fixtures, 'big-content.json')}`,
    `smallFixture=${join(fixtures, 'small-content.json')}`,
    `bigBytes=${Buffer.byteLength(JSON.stringify(bigContent, null, 2))}`,
    '',
  ].join('\n'),
);
