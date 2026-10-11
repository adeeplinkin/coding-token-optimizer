import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyContainedPath,
  classifyToolCall,
  createContainmentGuardPluginV2,
  summarizeContainmentEvidence,
} from '../src/index.js';
import type {
  ContainmentEvidenceLine,
  OpenCodeV2PluginContext,
  OpenCodeV2Registration,
  OpenCodeV2ToolHookSpec,
} from '../src/index.js';
import { projectLocation, v2Envelope } from './v2-host.js';

/**
 * The containment guard, tested at both seams.
 *
 * The policy is pure, so it is tested directly: no filesystem, no runtime, no model.
 * The plugin is then driven through a small but faithful V2 host — `setup(ctx)` with
 * a declared location, a real `execute.before` registration, a real event
 * subscription — so a blocked call is a *thrown* call, exactly as the runtime's tool
 * pipeline would receive it, and the evidence file is the real one the arm driver
 * reads back.
 *
 * These tests are why the canary can claim containment as enforced rather than
 * assumed: the rehearsal proves the guard travels through the installed runtime,
 * and these prove what it does when a call leaves the workspace.
 */

const ROOT = 'C:\\ws\\repo';

function kind(lines: readonly ContainmentEvidenceLine[], wanted: string): ContainmentEvidenceLine {
  const found = lines.find((entry) => entry.kind === wanted);
  if (found === undefined) {
    throw new Error(`no ${wanted} evidence line was written`);
  }
  return found;
}

describe('the containment path policy', () => {
  it('accepts paths that resolve inside the workspace, under either separator', () => {
    expect(classifyContainedPath('src/catalog.js', ROOT)).toBe('inside');
    expect(classifyContainedPath('src\\catalog.js', ROOT)).toBe('inside');
    expect(classifyContainedPath('C:\\ws\\repo\\src\\catalog.js', ROOT)).toBe('inside');
    expect(classifyContainedPath('C:/ws/repo/.', ROOT)).toBe('inside');
    expect(classifyContainedPath('C:/ws/repo/../repo/data/x.json', ROOT)).toBe('inside');
    expect(classifyContainedPath('sub//dir//file.ts', ROOT)).toBe('inside');
  });

  it('refuses a sibling directory whose name merely starts with the workspace name', () => {
    // A prefix check on raw strings would accept these; segment-aware comparison must not.
    expect(classifyContainedPath('C:/ws/repo-other/file.ts', ROOT)).toBe('outside');
    expect(classifyContainedPath('C:/ws/repo2/file.ts', ROOT)).toBe('outside');
  });

  it('refuses absolute, relative and climbing paths outside the workspace', () => {
    expect(classifyContainedPath('C:/elsewhere/file.ts', ROOT)).toBe('outside');
    expect(classifyContainedPath('../outside.txt', ROOT)).toBe('outside');
    expect(classifyContainedPath('..\\..\\outside.txt', ROOT)).toBe('outside');
    expect(classifyContainedPath('src/../../outside.txt', ROOT)).toBe('outside');
  });

  it('refuses targets it cannot resolve rather than guessing', () => {
    expect(classifyContainedPath('/etc/passwd', ROOT)).toBe('unusable');
    expect(classifyContainedPath('~/secrets.txt', ROOT)).toBe('unusable');
    expect(classifyContainedPath('\\\\server\\share\\x', ROOT)).toBe('unusable');
    expect(classifyContainedPath('C:relative-file.ts', ROOT)).toBe('unusable');
    expect(classifyContainedPath('', ROOT)).toBe('unusable');
    expect(classifyContainedPath('   ', ROOT)).toBe('unusable');
  });

  it('classifies glob patterns by their static prefix', () => {
    expect(classifyContainedPath('**/*.ts', ROOT)).toBe('inside');
    expect(classifyContainedPath('src/**/*.ts', ROOT)).toBe('inside');
    expect(classifyContainedPath('C:/ws/repo/**/*.ts', ROOT)).toBe('inside');
    expect(classifyContainedPath('../**/*.ts', ROOT)).toBe('outside');
    expect(classifyContainedPath('C:/elsewhere/**/*.ts', ROOT)).toBe('outside');
  });
});

describe('the containment tool policy', () => {
  const inside = { path: 'src/catalog.js' };

  it('allows a path-taking tool whose path is inside the workspace', () => {
    expect(classifyToolCall({ tool: 'read', args: inside, workspaceRoot: ROOT })).toMatchObject({
      decision: 'allow',
      hadPathArguments: true,
    });
    expect(
      classifyToolCall({ tool: 'edit', args: { filePath: 'src/catalog.js' }, workspaceRoot: ROOT }),
    ).toMatchObject({ decision: 'allow', hadPathArguments: true });
  });

  it('blocks a path-taking tool whose path leaves the workspace, under either key name', () => {
    expect(
      classifyToolCall({ tool: 'read', args: { path: 'C:/elsewhere/x' }, workspaceRoot: ROOT }),
    ).toMatchObject({ decision: 'block', reason: 'path-outside-workspace' });
    expect(
      classifyToolCall({ tool: 'edit', args: { filePath: '../x.ts' }, workspaceRoot: ROOT }),
    ).toMatchObject({ decision: 'block', reason: 'path-outside-workspace' });
    expect(
      classifyToolCall({ tool: 'write', args: { path: ['a.ts', '../b.ts'] }, workspaceRoot: ROOT }),
    ).toMatchObject({ decision: 'block', reason: 'path-outside-workspace' });
  });

  it('blocks the shell, subagent, fetcher and patch tools outright', () => {
    for (const tool of ['shell', 'bash', 'task', 'subagent', 'webfetch', 'patch', 'apply_patch']) {
      expect(classifyToolCall({ tool, args: {}, workspaceRoot: ROOT })).toMatchObject({
        decision: 'block',
        reason: 'denied-tool',
      });
    }
  });

  it('blocks a shell-like command even when the tool is named something else', () => {
    expect(
      classifyToolCall({ tool: 'execute', args: { command: 'node --test' }, workspaceRoot: ROOT }),
    ).toMatchObject({ decision: 'block', reason: 'shell-like-arguments' });
    expect(
      classifyToolCall({ tool: 'execute', args: { cmd: 'rm -rf /' }, workspaceRoot: ROOT }),
    ).toMatchObject({ decision: 'block', reason: 'shell-like-arguments' });
  });

  it('blocks an unreadable path argument instead of assuming it is harmless', () => {
    expect(classifyToolCall({ tool: 'read', args: { path: 5 }, workspaceRoot: ROOT })).toMatchObject({
      decision: 'block',
      reason: 'unusable-path-argument',
    });
    expect(classifyToolCall({ tool: 'read', args: { path: [] }, workspaceRoot: ROOT })).toMatchObject({
      decision: 'block',
      reason: 'unusable-path-argument',
    });
  });

  it('fails closed when the host never declared a workspace', () => {
    expect(classifyToolCall({ tool: 'read', args: inside, workspaceRoot: undefined })).toMatchObject({
      decision: 'block',
      reason: 'unknown-workspace',
    });
    expect(classifyToolCall({ tool: 'read', args: {}, workspaceRoot: undefined })).toMatchObject({
      decision: 'allow',
    });
    expect(classifyToolCall({ tool: 'shell', args: {}, workspaceRoot: undefined })).toMatchObject({
      decision: 'block',
      reason: 'denied-tool',
    });
  });

  it('allows a tool that declares no path and no command', () => {
    expect(
      classifyToolCall({ tool: 'todo', args: { items: ['a'] }, workspaceRoot: ROOT }),
    ).toMatchObject({ decision: 'allow', hadPathArguments: false });
    expect(classifyToolCall({ tool: 'grep', args: { pattern: 'x' }, workspaceRoot: ROOT })).toMatchObject({
      decision: 'allow',
    });
  });
});

interface GuardHost {
  /** Invoke the registered `execute.before` as the host's tool pipeline would. */
  readonly tool: (payload: unknown) => Promise<void>;
  /** Deliver one raw runtime event through the real subscription. */
  readonly push: (event: unknown) => void;
  readonly close: () => Promise<void>;
  /** The evidence file the plugin wrote, parsed; empty when no path was configured. */
  readonly evidence: () => Promise<readonly ContainmentEvidenceLine[]>;
}

/** Wait for a condition, so a test never depends on a fixed sleep landing. */
async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A faithful-enough V2 host: real `setup`, real registration, real subscription. */
async function createGuardHost(environment: {
  readonly location?: unknown;
  readonly omitTool?: boolean;
  readonly evidencePath?: string;
}): Promise<GuardHost> {
  // The sink belongs to the caller (the generated project-local plugin does this in a
  // real run), so the package itself never touches the filesystem.
  const plugin = createContainmentGuardPluginV2(
    environment.evidencePath === undefined
      ? {}
      : {
          onEvidence: (line) => {
            appendFileSync(
              environment.evidencePath as string,
              `${JSON.stringify(line)}\n`,
              'utf8',
            );
          },
        },
  );
  const callbacks = new Map<string, (event: unknown) => unknown>();
  const buffer: unknown[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          for (;;) {
            if (buffer.length > 0) {
              return { done: false, value: buffer.shift() };
            }
            if (closed) {
              return { done: true, value: undefined };
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
    },
  };
  // Typed against the adapter's own V2 contract, so a change to that contract fails
  // this typecheck instead of silently diverging from the host.
  const hook = async <Name extends keyof OpenCodeV2ToolHookSpec>(
    name: Name,
    callback: (event: OpenCodeV2ToolHookSpec[Name]) => Promise<void> | void,
  ): Promise<OpenCodeV2Registration> => {
    callbacks.set(name, callback as unknown as (event: unknown) => unknown);
    return {
      dispose: async () => {
        callbacks.delete(name);
      },
    };
  };
  const context: OpenCodeV2PluginContext = {
    ...(environment.omitTool === true ? {} : { tool: { hook } }),
    event: {
      subscribe: (subscribeOptions?: { readonly signal?: AbortSignal }) => {
        subscribeOptions?.signal?.addEventListener('abort', () => {
          closed = true;
          notify();
        });
        return iterable;
      },
    },
    ...(environment.location === undefined
      ? {}
      : { location: environment.location as NonNullable<OpenCodeV2PluginContext['location']> }),
  };
  const cleanup = await plugin.setup(context);
  await new Promise((resolve) => setTimeout(resolve, 5));

  return {
    async tool(payload) {
      const callback = callbacks.get('execute.before');
      if (callback === undefined) {
        throw new Error('the guard did not register execute.before');
      }
      await callback(payload);
    },
    push(event) {
      buffer.push(event);
      notify();
    },
    async close() {
      closed = true;
      notify();
      await cleanup?.();
    },
    async evidence() {
      if (environment.evidencePath === undefined) {
        return [];
      }
      const text = await readFile(environment.evidencePath, 'utf8');
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((entry) => JSON.parse(entry) as ContainmentEvidenceLine);
    },
  };
}

async function withTempDir<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dr-token-containment-test-'));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the containment guard plugin', () => {
  it('blocks an out-of-workspace call by throwing, and records it without a path', async () => {
    await withTempDir(async (directory) => {
      const evidencePath = join(directory, 'guard.jsonl');
      const host = await createGuardHost({
        location: projectLocation(ROOT, 'prj_1'),
        evidencePath,
      });

      await expect(host.tool({ tool: 'read', input: { path: 'C:\\elsewhere\\secrets.txt' } })).rejects.toThrow(
        /refused/,
      );
      await expect(host.tool({ tool: 'read', input: { path: 'src/catalog.js' } })).resolves.toBeUndefined();
      await expect(host.tool({ tool: 'shell', input: { command: 'node --test' } })).rejects.toThrow(/refused/);

      const lines = await host.evidence();
      const summary = summarizeContainmentEvidence(lines);
      expect(summary.guardLoaded).toBe(true);
      expect(summary.rootKnown).toBe(true);
      expect(summary.blockedCalls).toBe(2);
      expect(summary.allowedCalls).toBe(1);
      expect(summary.blockedByTool).toEqual({ read: 1, shell: 1 });

      // Content-free: no evidence line carries the refused path or an argument value.
      const text = await readFile(evidencePath, 'utf8');
      expect(text).not.toContain('elsewhere');
      expect(text).not.toContain('secrets');
      expect(text).not.toContain('catalog');
      expect(text).not.toContain('node --test');
      await host.close();
    });
  });

  it('records the permission rules the session itself declared, classified by resource', async () => {
    await withTempDir(async (directory) => {
      const evidencePath = join(directory, 'guard.jsonl');
      const host = await createGuardHost({
        location: projectLocation(ROOT, 'prj_1'),
        evidencePath,
      });
      host.push(
        v2Envelope('session.created', {
          sessionID: 'ses_host',
          projectID: 'prj_1',
          slug: 'synthetic-session',
          version: '1',
          permissions: [
            { action: 'shell', resource: '*', effect: 'deny' },
            { action: 'external_directory', resource: '*', effect: 'deny' },
            { action: 'edit', resource: 'C:/ws/repo/**', effect: 'allow' },
            { action: 'edit', resource: 'C:/elsewhere/**', effect: 'deny' },
          ],
        }),
      );
      await until(async () =>
        (await host.evidence()).some((line) => line.kind === 'permissions'),
      );
      const summary = summarizeContainmentEvidence(await host.evidence());
      expect(summary.permissionRules).toEqual([
        { action: 'shell', effect: 'deny', resource: 'any' },
        { action: 'external_directory', effect: 'deny', resource: 'any' },
        { action: 'edit', effect: 'allow', resource: 'workspace' },
        { action: 'edit', effect: 'deny', resource: 'other' },
      ]);
      await host.close();
    });
  });

  it('reports a host with no tool hook as missing rather than silently unguarded', async () => {
    await withTempDir(async (directory) => {
      const evidencePath = join(directory, 'guard.jsonl');
      const host = await createGuardHost({
        location: projectLocation(ROOT, 'prj_1'),
        omitTool: true,
        evidencePath,
      });
      const summary = summarizeContainmentEvidence(await host.evidence());
      expect(summary.guardLoaded).toBe(false);
      expect(summary.capabilityMissing).toBe(true);
      await host.close();
    });
  });

  it('records an unknown workspace as unverified instead of assuming containment', async () => {
    await withTempDir(async (directory) => {
      const evidencePath = join(directory, 'guard.jsonl');
      const host = await createGuardHost({ evidencePath });
      const lines = await host.evidence();
      const summary = summarizeContainmentEvidence(lines);
      expect(summary.guardLoaded).toBe(true);
      expect(summary.rootKnown).toBe(false);
      expect(kind(lines, 'loaded').rootKnown).toBe(false);
      await host.close();
    });
  });
});
