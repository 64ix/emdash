import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../../registry';

const spawnCtx = {
  cwd: '/home/user/worktrees/task-1',
  env: {},
  cli: '/usr/local/bin/opencode',
};

describe('opencode acp behavior', () => {
  const opencode = () => pluginRegistry.get('opencode')!;
  const acpBehavior = () => opencode().behavior.acp!;

  it('declares acp: { kind: supported }', () => {
    expect(opencode().capabilities.acp.kind).toBe('supported');
  });

  it('starts the documented ACP command', () => {
    const spawn = acpBehavior().buildSpawn({ ...spawnCtx, autoApprove: false });

    expect(spawn.command).toBe('/usr/local/bin/opencode');
    expect(spawn.args).toEqual(['acp']);
  });

  it('adds OPENCODE_PERMISSION allow-all to the spawn env when autoApprove is on', () => {
    const spawn = acpBehavior().buildSpawn({ ...spawnCtx, autoApprove: true });

    expect(spawn.env).toEqual({ OPENCODE_PERMISSION: '{"*":"allow"}' });
  });

  it('does not add OPENCODE_PERMISSION when autoApprove is off', () => {
    const spawn = acpBehavior().buildSpawn({ ...spawnCtx, autoApprove: false });

    expect(spawn.env).toBeUndefined();
  });
});
