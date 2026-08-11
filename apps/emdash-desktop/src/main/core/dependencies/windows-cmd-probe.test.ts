import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostDependencyManager } from '@emdash/core/deps/runtime';
import { describe, expect, it } from 'vitest';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';

/**
 * Regression: npm-installed agents on Windows exist only as .cmd shims in the
 * npm global bin dir. Probes used to spawn those shims directly and failed with
 * EINVAL, leaving version null and npm provenance unconfirmed — which in turn
 * made a persisted { kind: 'method', method: 'npm' } selection resolve to
 * 'missing' ("Not found") even though the agent was installed.
 */
describe.skipIf(process.platform !== 'win32')('npm shim probes on Windows', () => {
  it('reports version and confirmed npm provenance for a .cmd shim installation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emdash-shim-probe-'));
    const shim = join(dir, 'fakeagent.cmd');
    writeFileSync(shim, '@echo off\r\necho fakeagent version 9.8.7\r\n', 'utf8');

    const descriptor = {
      id: 'fakeagent',
      name: 'Fake Agent',
      category: 'agent',
      commands: ['fakeagent'],
      binaryNames: ['fakeagent'],
      installCommands: { macos: [], linux: [], windows: [] },
      updates: { kind: 'none' },
      uninstall: { kind: 'none' },
    } as const;

    const ctx = new LocalExecutionContext();
    const manager = new HostDependencyManager(ctx, {
      dependencies: [descriptor as never],
      getDependencyDescriptor: () => descriptor as never,
      logger: {
        debug: () => {},
        info: () => {},
        warn: console.warn,
        error: console.error,
      } as never,
    });

    const originalPath = process.env.PATH;
    process.env.PATH = `${dir};${originalPath ?? ''}`;
    try {
      const state = await manager.probe('fakeagent' as never);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const hostDep = manager.getHostDependency('fakeagent' as never);

      expect(state.status).toBe('available');
      expect(state.version).toBe('9.8.7');
      expect(hostDep?.installations[0]?.status).toBe('available');
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
