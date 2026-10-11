import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IMPLEMENTED_HOOKS,
  OBSERVER_ADAPTER_NAME,
  OBSERVER_ADAPTER_REVISION,
  OBSERVER_DISABLE_ENV_VAR,
  OBSERVER_SUMMARY_FILE_ENV_VAR,
  OPENCODE_PLUGIN_VERIFIED_VERSION,
  SAFE_MODE_ENV_VAR,
} from '../src/index.js';

/**
 * Source-level guards.
 *
 * These check the properties that unit tests cannot: that the adapter has no
 * network, telemetry, logging, subprocess or hidden-write path, and that it adds
 * no runtime dependency.
 */

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(packageRoot, 'src');

function sourceFiles(): readonly string[] {
  return readdirSync(sourceDirectory)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

function readSource(name: string): string {
  return stripComments(readFileSync(path.join(sourceDirectory, name), 'utf8'));
}

/** Remove JSDoc blocks and full-line comments so only real code is inspected. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

function importSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('no telemetry or network path', () => {
  it('contains no network, subprocess or logging call', () => {
    const forbidden = [
      'fetch(',
      'XMLHttpRequest',
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
      'node:child_process',
      'child_process',
      'execSync',
      'spawnSync',
      'console.log',
      'console.warn',
      'console.error',
      'process.exit',
      'navigator.sendBeacon',
    ];
    for (const name of sourceFiles()) {
      const source = readSource(name);
      for (const pattern of forbidden) {
        expect(source.includes(pattern), `${name} must not contain "${pattern}"`).toBe(false);
      }
    }
  });

  it('imports no third-party runtime module', () => {
    const allowed = new Set(['node:crypto', 'node:fs/promises']);
    for (const name of sourceFiles()) {
      for (const specifier of importSpecifiers(readSource(name))) {
        const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
        expect(
          isRelative || allowed.has(specifier),
          `${name} imports unexpected module "${specifier}"`,
        ).toBe(true);
      }
    }
  });

  it('never imports the Node-only benchmark package', () => {
    for (const name of sourceFiles()) {
      for (const specifier of importSpecifiers(readSource(name))) {
        expect(specifier.startsWith('@dr-token/benchmarks')).toBe(false);
      }
    }
  });

  it('reads the environment only in the observer module', () => {
    const readers = sourceFiles().filter((name) => readSource(name).includes('process.env'));
    expect(readers).toEqual(['observer.ts']);
    expect(readSource('observer.ts')).toContain('OBSERVER_DISABLE_ENV_VAR');
    expect(readSource('observer.ts')).not.toContain('OBSERVER_SUMMARY_FILE_ENV_VAR');
  });

  it('never touches the filesystem outside the opt-in sink module', () => {
    const writers = sourceFiles().filter((name) => {
      const source = readSource(name);
      return source.includes('appendFile') || source.includes('writeFile') || source.includes('createWriteStream');
    });
    expect(writers).toEqual(['sink.ts']);
  });
});

describe('the Safe Mode apply path is opt-in, single-writer and unreachable when off', () => {
  it('keeps exactly one assignment to a tool-result value in the elision module', () => {
    const source = readSource('safe-mode-elision.ts');
    // One write, inside the documented loop, on `result['value']`.
    const assignments = [...source.matchAll(/result\['value'\]\s*=/g)];
    expect(assignments).toHaveLength(1);
  });

  it('is imported only by the observer (plus the type-only summary import)', () => {
    const importers = sourceFiles()
      .filter((name) => importSpecifiers(readSource(name)).includes('./safe-mode-elision.js'))
      .sort();
    // `index.ts` re-exports it, `types.ts` imports a type only, `observer.ts` is the one caller.
    expect(importers).toEqual(['index.ts', 'observer.ts', 'types.ts']);
  });

  it('calls the pass from exactly one place, behind the apply switch and the observe gate', () => {
    const observer = readSource('observer.ts');
    const calls = [...observer.matchAll(/applySafeModeElision\(/g)];
    expect(calls).toHaveLength(1);
    expect(observer).toContain('#safeModeApply && this.#canObserve()');
  });

  it('reads no environment and writes no file of its own', () => {
    const source = readSource('safe-mode-elision.ts');
    expect(source).not.toContain('process.env');
    expect(source.includes('appendFile') || source.includes('writeFile')).toBe(false);
  });

  it('is off unless the setting says apply', () => {
    // `resolveSafeModeSetting` is the only place the switch is interpreted.
    expect(readSource('observer.ts')).toContain("value === 'apply'");
  });
});

describe('the Stage 1R mutation probe cannot be activated by the product', () => {
  it('is not referenced from the package entry point', () => {
    expect(readFileSync(path.join(sourceDirectory, 'index.ts'), 'utf8')).not.toContain(
      'request-mutation-probe',
    );
  });

  it('is imported by no shipped module', () => {
    const importers = sourceFiles().filter((name) =>
      importSpecifiers(readSource(name)).includes('./request-mutation-probe.js'),
    );
    expect(importers).toEqual([]);
  });

  it('reads no environment and writes no file of its own', () => {
    const source = readSource('request-mutation-probe.ts');
    expect(source).not.toContain('process.env');
    expect(source.includes('appendFile') || source.includes('writeFile')).toBe(false);
  });

  it('keeps its only assignment inside the mutation it documents', () => {
    const source = readSource('request-mutation-probe.ts');
    // One assignment to a payload member, and it is the documented substitution.
    const assignments = [...source.matchAll(/target\.container\['value'\]\s*=/g)];
    expect(assignments).toHaveLength(1);
  });
});

describe('dependency hygiene', () => {
  it('declares no runtime dependency', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
      readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
      readonly name?: string;
      readonly version?: string;
    };

    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.name).toBe(OBSERVER_ADAPTER_NAME);
    expect(manifest.peerDependencies?.['@opencode-ai/plugin']).toBe('^1.18.35');
    expect(manifest.peerDependenciesMeta?.['@opencode-ai/plugin']?.optional).toBe(true);
    expect(OPENCODE_PLUGIN_VERIFIED_VERSION).toBe('1.18.35');
  });

  it('keeps the recorded adapter revision in sync with the package version', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      readonly version: string;
    };

    expect(OBSERVER_ADAPTER_REVISION).toBe(manifest.version);
  });

  it('documents every environment switch', () => {
    expect(OBSERVER_DISABLE_ENV_VAR).toBe('DR_TOKEN_OPENCODE_OBSERVER');
    expect(OBSERVER_SUMMARY_FILE_ENV_VAR).toBe('DR_TOKEN_OBSERVER_SUMMARY_FILE');
    expect(SAFE_MODE_ENV_VAR).toBe('DR_TOKEN_SAFE_MODE');
  });
});

describe('hook surface', () => {
  it('exposes exactly four hooks and none that can transform context', () => {
    expect([...IMPLEMENTED_HOOKS]).toEqual([
      'tool.execute.before',
      'tool.execute.after',
      'event',
      'dispose',
    ]);
  });

  it('documents the verified API version and the no-mutation guarantee', () => {
    const types = readFileSync(path.join(sourceDirectory, 'types.ts'), 'utf8');

    expect(types).toContain('1.18.35');
    expect(types).toContain('sha256');
    expect(types).toContain('observation only');
    expect(types).toContain('experimental.*');
  });
});
