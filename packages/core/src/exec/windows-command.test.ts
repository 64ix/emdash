import { describe, expect, it } from 'vitest';
import { resolveWindowsCommandSpec } from './windows-command';

const CMD = 'C:\\Windows\\System32\\cmd.exe';
const spec = (command: string, args: string[]) => ({
  command,
  args,
  env: { ComSpec: CMD },
});

describe('resolveWindowsCommandSpec', () => {
  it('routes a .cmd shim through cmd.exe with each argv token quoted', () => {
    expect(
      resolveWindowsCommandSpec(
        spec('C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd', ['--version']),
        'win32'
      )
    ).toEqual({
      command: CMD,
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd" --version"',
      ],
    });
  });

  it('routes a .bat shim through cmd.exe', () => {
    const resolved = resolveWindowsCommandSpec(spec('C:\\tools\\tool.bat', ['run']), 'win32');
    expect(resolved.command).toBe(CMD);
    expect(resolved.args).toEqual(['/d', '/s', '/c', 'C:\\tools\\tool.bat run']);
  });

  it('routes a bare npm-style command through cmd.exe so PATHEXT shims resolve', () => {
    const resolved = resolveWindowsCommandSpec(spec('npm', ['root', '-g']), 'win32');
    expect(resolved.command).toBe(CMD);
    expect(resolved.args).toEqual(['/d', '/s', '/c', 'npm root -g']);
  });

  it('leaves real executables untouched', () => {
    const input = spec('C:\\tools\\codex.exe', ['app-server']);
    expect(resolveWindowsCommandSpec(input, 'win32')).toEqual({
      command: 'C:\\tools\\codex.exe',
      args: ['app-server'],
    });
  });

  it('leaves commands untouched on non-Windows platforms', () => {
    const input = { command: '/usr/local/bin/opencode', args: ['--version'] };
    expect(resolveWindowsCommandSpec(input, 'linux')).toEqual(input);
    expect(resolveWindowsCommandSpec(input, 'darwin')).toEqual(input);
  });

  it('honors ComSpec when present in the supplied env', () => {
    const resolved = resolveWindowsCommandSpec(
      { command: 'C:\\shim\\agent.cmd', args: [], env: { ComSpec: 'C:\\custom\\cmd.exe' } },
      'win32'
    );
    expect(resolved.command).toBe('C:\\custom\\cmd.exe');
  });

  it('quotes argv tokens that carry cmd metacharacters', () => {
    const resolved = resolveWindowsCommandSpec(
      spec('C:\\shim\\agent.cmd', ['a b', 'x&y']),
      'win32'
    );
    expect(resolved.args[3]).toBe('C:\\shim\\agent.cmd "a b" "x^&y"');
  });
});
