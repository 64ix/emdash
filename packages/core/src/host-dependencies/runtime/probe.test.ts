import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import { resolveAllCommandPaths, resolveCommandPath } from './probe';

function executionContext(stdout: string): IExecutionContext {
  return {
    supportsLocalSpawn: true,
    exec: vi.fn().mockResolvedValue({ stdout, stderr: '' }),
  } as unknown as IExecutionContext;
}

describe('Windows command resolution', () => {
  const unixCodex =
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0_x64__test\\app\\resources\\codex';
  const windowsCodex = `${unixCodex}.exe`;

  it('prefers a Windows executable when where also returns an extensionless binary', async () => {
    const ctx = executionContext(`${unixCodex}\r\n${windowsCodex}\r\n`);

    await expect(resolveCommandPath('codex', ctx, 'windows')).resolves.toBe(windowsCodex);
  });

  it('excludes extensionless binaries from all results for a bare Windows command', async () => {
    const ctx = executionContext(`${unixCodex}\r\n${windowsCodex}\r\n`);

    await expect(resolveAllCommandPaths('codex', ctx, 'windows')).resolves.toEqual([
      windowsCodex,
    ]);
  });

  it('preserves an explicitly requested extensionless path', async () => {
    const ctx = executionContext(`${unixCodex}\r\n`);

    await expect(resolveCommandPath(unixCodex, ctx, 'windows')).resolves.toBe(unixCodex);
  });
});
