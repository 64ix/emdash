import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GIT_EXECUTABLE } from '@main/core/utils/exec';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

const { LocalExecutionContext } = await import('./local-execution-context');

class FakeChildProcess extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });

  kill = vi.fn();
}

describe('LocalExecutionContext', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
  });

  it('resolves logical git command for buffered local execution', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
    });
    const ctx = new LocalExecutionContext({ root: '/repo' });

    await ctx.exec('git', ['status']);

    expect(execFileMock).toHaveBeenCalledWith(
      GIT_EXECUTABLE,
      ['status'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({
          GIT_ASKPASS: '',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          SSH_ASKPASS: '',
        }),
      }),
      expect.any(Function)
    );
  });

  it('explains when git is missing during buffered local execution', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', path: GIT_EXECUTABLE })
      );
    });
    const ctx = new LocalExecutionContext({ root: '/repo' });

    await expect(ctx.exec('git', ['status'])).rejects.toThrow(
      'Git is not installed or Emdash cannot find it'
    );
  });

  it('resolves logical git command for streaming local execution', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const ctx = new LocalExecutionContext({ root: '/repo' });

    const promise = ctx.execStreaming('git', ['status'], () => true);
    child.emit('close', 0);
    await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      GIT_EXECUTABLE,
      ['status'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({
          GIT_ASKPASS: '',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          SSH_ASKPASS: '',
        }),
      })
    );
  });

  it('explains when git is missing during streaming local execution', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const ctx = new LocalExecutionContext({ root: '/repo' });

    const promise = ctx.execStreaming('git', ['status'], () => true);
    child.emit(
      'error',
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', path: GIT_EXECUTABLE })
    );

    await expect(promise).rejects.toThrow('Git is not installed or Emdash cannot find it');
  });

  describe.skipIf(process.platform !== 'win32')('Windows npm shim routing', () => {
    it('routes a .cmd shim through cmd.exe instead of failing with EINVAL', async () => {
      execFileMock.mockImplementation(
        (
          command: string,
          _args: string[],
          _options: unknown,
          callback: (e: unknown, r?: { stdout: string; stderr: string }) => void
        ) => {
          if (typeof command === 'string' && command.toLowerCase().endsWith('cmd.exe')) {
            callback(null, { stdout: 'fake-version-1.2.3\r\n', stderr: '' });
            return;
          }
          callback(Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }));
        }
      );
      const ctx = new LocalExecutionContext({ root: '/repo' });

      const result = await ctx.exec('C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd', [
        '--version',
      ]);

      expect(result.stdout).toContain('fake-version-1.2.3');
      const call = execFileMock.mock.calls.at(-1);
      expect(call?.[0]?.toLowerCase()).toBe((process.env.ComSpec ?? 'cmd.exe').toLowerCase());
      expect(call?.[1]).toEqual([
        '/d',
        '/s',
        '/c',
        '""C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd" --version"',
      ]);
    });
  });
});
