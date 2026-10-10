import { describe, expect, it } from 'vitest';
import { classifyReadAttempt, isReadLikeToolName, isShellToolName } from '../src/reads.js';
import { defaultHash } from '../src/identity.js';

const identified = (toolName: string, input: unknown) => {
  const classification = classifyReadAttempt(toolName, input, defaultHash);
  expect(classification.attempt, `${toolName} should be a read attempt`).toBe(true);
  if (!classification.attempt) {
    throw new Error('unreachable');
  }
  expect(classification.result.identified).toBe(true);
  if (!classification.result.identified) {
    throw new Error('unreachable');
  }
  return classification.result;
};

const refused = (toolName: string, input: unknown): string => {
  const classification = classifyReadAttempt(toolName, input, defaultHash);
  expect(classification.attempt).toBe(true);
  if (!classification.attempt || classification.result.identified) {
    throw new Error('expected an unidentified read');
  }
  return classification.result.reason;
};

describe('read tool names', () => {
  it('recognizes documented and conventional read tool names', () => {
    expect(isReadLikeToolName('mcp__filesystem__read_file')).toBe(true);
    expect(isReadLikeToolName('mcp__fs__read_text_file')).toBe(true);
    expect(isReadLikeToolName('read')).toBe(true);
    expect(isReadLikeToolName('read_file')).toBe(true);
  });

  it('does not treat writes, searches or plans as reads', () => {
    for (const name of ['apply_patch', 'write_file', 'update_plan', 'spawn_agent', 'web_search', 'rg']) {
      expect(isReadLikeToolName(name), name).toBe(false);
      expect(classifyReadAttempt(name, { path: 'a.ts' }, defaultHash).attempt, name).toBe(false);
    }
  });

  it('recognizes shell tools', () => {
    expect(isShellToolName('Bash')).toBe(true);
    expect(isShellToolName('bash')).toBe(true);
    expect(isShellToolName('exec_command')).toBe(true);
    expect(isShellToolName('apply_patch')).toBe(false);
  });
});

describe('function and MCP tool reads', () => {
  it('identifies a read by path and defaults the range', () => {
    const read = identified('mcp__filesystem__read_file', { path: 'src/a.ts' });
    expect(read.basis).toBe('tool-argument');
    expect(read.offset).toBe(1);
    expect(read.limit).toBe(0);
    expect(read.malformed).toBe(false);
    expect(read.key).toBe(`${defaultHash('src/a.ts')}:1:0`);
  });

  it('gives one identity to equivalent path spellings', () => {
    const forward = identified('mcp__fs__read_file', { path: 'src/a.ts' });
    const windows = identified('mcp__fs__read_file', { path: 'src\\a.ts' });
    const padded = identified('mcp__fs__read_file', { path: '  src/a.ts  ' });
    const collapsed = identified('mcp__fs__read_file', { path: 'src//a.ts' });
    expect(new Set([forward.targetId, windows.targetId, padded.targetId, collapsed.targetId]).size).toBe(1);
  });

  it('separates ranges of the same file', () => {
    const whole = identified('read_file', { path: 'src/a.ts' });
    const ranged = identified('read_file', { path: 'src/a.ts', offset: 1, limit: 200 });
    expect(whole.key).not.toBe(ranged.key);
    expect(ranged.offset).toBe(1);
    expect(ranged.limit).toBe(200);
  });

  it('accepts the documented path argument names', () => {
    for (const key of ['path', 'filePath', 'file_path', 'filename', 'file']) {
      const read = identified('mcp__fs__read_file', { [key]: 'notes.md' });
      expect(read.targetId).toBe(defaultHash('notes.md'));
    }
  });

  it('refuses a read with no usable path', () => {
    expect(refused('read_file', {})).toBe('missing-path');
    expect(refused('read_file', { path: '' })).toBe('missing-path');
    expect(refused('read_file', { path: 42 })).toBe('missing-path');
    expect(refused('read_file', undefined)).toBe('unusable-input');
  });

  it('refuses ranges it does not model rather than assuming a whole-file read', () => {
    expect(refused('read_file', { path: 'a.ts', start_line: 10 })).toBe('unusable-input');
    expect(refused('read_file', { path: 'a.ts', lines: [1, 20] })).toBe('unusable-input');
  });

  it('flags a range that was present but unusable', () => {
    const read = identified('read_file', { path: 'a.ts', offset: 'ten', limit: 5 });
    expect(read.malformed).toBe(true);
    expect(read.offset).toBe(1);
    expect(read.limit).toBe(5);
  });
});

describe('shell reads', () => {
  it('identifies an unambiguous single-file read', () => {
    const read = identified('Bash', { command: 'cat notes.md' });
    expect(read.basis).toBe('shell-command');
    expect(read.targetId).toBe(defaultHash('notes.md'));
    expect(identified('Bash', { command: '  head  report.txt' }).targetId).toBe(
      defaultHash('report.txt'),
    );
    expect(identified('Bash', { command: 'Get-Content log.txt' }).targetId).toBe(
      defaultHash('log.txt'),
    );
  });

  it('handles a quoted path and a Windows path', () => {
    expect(identified('Bash', { command: 'cat "my file.txt"' }).targetId).toBe(
      defaultHash('my file.txt'),
    );
    expect(identified('Bash', { command: 'cat C:\\repo\\a.ts' }).targetId).toBe(
      defaultHash('C:/repo/a.ts'),
    );
    expect(identified('Bash', { command: 'cat C:\\repo\\a.ts' }).targetId).toBe(
      identified('Bash', { command: 'cat C:/repo/a.ts' }).targetId,
    );
  });

  it('refuses anything that is not one literal file read', () => {
    const commands = [
      'cat a.txt b.txt',
      'cat a.txt | head',
      'cat *.ts',
      'cat $HOME/x',
      'cat a.txt > out.txt',
      'cat `whoami`',
      'grep needle a.txt',
      'sed -n 1,20p a.txt',
      'rg needle',
      'ls -la',
      'cat',
      'cat ~/notes.md',
    ];
    for (const command of commands) {
      const classification = classifyReadAttempt('Bash', { command }, defaultHash);
      expect(classification.attempt, command).toBe(true);
      if (classification.attempt) {
        expect(classification.result.identified, command).toBe(false);
      }
    }
  });

  it('refuses a shell call with no command', () => {
    expect(refused('Bash', {})).toBe('missing-path');
    expect(refused('Bash', { command: 42 })).toBe('missing-path');
  });

  it('never throws on unusual input', () => {
    const inputs: unknown[] = [null, undefined, [], 'cat a.txt', { command: "cat 'unterminated" }];
    for (const input of inputs) {
      expect(() => classifyReadAttempt('Bash', input, defaultHash)).not.toThrow();
      expect(() => classifyReadAttempt('read_file', input, defaultHash)).not.toThrow();
    }
  });
});
