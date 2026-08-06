import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChildAcpProcessHost, resolveChildProcessSpawnSpec } from './child-process-host';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveChildProcessSpawnSpec', () => {
  it('wraps Windows cmd shims without enabling shell mode', () => {
    expect(
      resolveChildProcessSpawnSpec(
        {
          command: 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd',
          args: ['acp', 'hello world', 'A&B'],
          env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
          cwd: 'C:\\workspace',
        },
        'win32'
      )
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd" acp "hello world" "A^&B""',
      ],
    });
  });

  it('leaves native executables unchanged', () => {
    expect(
      resolveChildProcessSpawnSpec(
        {
          command: 'C:\\tools\\codex.exe',
          args: ['app-server'],
          env: {},
          cwd: 'C:\\workspace',
        },
        'win32'
      )
    ).toEqual({ command: 'C:\\tools\\codex.exe', args: ['app-server'] });
  });
});

describe.runIf(process.platform === 'win32')('ChildAcpProcessHost on Windows', () => {
  it('spawns a cmd shim with piped stdio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emdash-acp-cmd-shim-'));
    tempDirs.push(dir);
    const shim = join(dir, 'agent.cmd');
    await writeFile(shim, '@echo off\r\necho ready\r\n', 'utf8');

    const handle = await new ChildAcpProcessHost().spawn({
      command: shim,
      args: [],
      env: { PATH: process.env.PATH ?? '' },
      cwd: dir,
    });
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      handle.stdout.setEncoding('utf8');
      handle.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      handle.onError(reject);
      handle.onExit((code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`shim exited with ${String(code)}`));
      });
    });

    expect(output).toBe('ready');
  });
});
