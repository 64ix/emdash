import type { Client } from '@agentclientprotocol/sdk';
import type { AgentPluginHost, IAcpBehavior } from '@emdash/core/agents/plugins';
import { err, isErr, isOk, ok } from '@emdash/shared';
import { noopLogger } from '@emdash/shared/logger';
import { acquireAsResult } from '@emdash/wire/util';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, FakeAcpProcessHost, testPluginHost } from '../acp-test-support';
import { createAcpConnectionSource, isAcpConnectionError, makeAcpConnectionKey } from './source';

function makeBehavior(agent: FakeAcpAgent): IAcpBehavior {
  return {
    buildSpawn: vi.fn().mockReturnValue({ command: '/fake/agent', args: [], env: {} }),
    connect: agent.behavior.connect,
  };
}

function acquireInput(agent: FakeAcpAgent, workspaceId = 'ws-1', autoApprove = false) {
  return {
    providerId: 'claude',
    workspaceId,
    cwd: '/tmp/workspace',
    autoApprove,
    behavior: makeBehavior(agent),
    buildClient: vi.fn(() => ({}) as Client),
  };
}

function waitForTeardown(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sourceDeps(
  host: FakeAcpProcessHost,
  onClosed = vi.fn(),
  agentHost = testPluginHost({ acpBehavior: makeBehavior(new FakeAcpAgent()) })
) {
  return {
    host,
    agentHost,
    logger: noopLogger,
    onClosed,
  };
}

describe('makeAcpConnectionKey', () => {
  it('composes provider, workspace and auto-approve flag', () => {
    expect(makeAcpConnectionKey('opencode', 'ws-1', true)).toBe('opencode:ws-1:auto-approve');
    expect(makeAcpConnectionKey('opencode', 'ws-1', false)).toBe('opencode:ws-1:manual');
    expect(makeAcpConnectionKey('claude', 'ws-1', false)).toBe('claude:ws-1:manual');
    expect(makeAcpConnectionKey('opencode', 'ws-2', false)).toBe('opencode:ws-2:manual');
  });

  it('distinguishes auto-approve from manual conversations in the same workspace', () => {
    expect(makeAcpConnectionKey('opencode', 'ws-1', true)).not.toBe(
      makeAcpConnectionKey('opencode', 'ws-1', false)
    );
  });
});

describe('createAcpConnectionSource', () => {
  it('dedupes acquisitions by provider/workspace and refcounts release', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));
    const key = makeAcpConnectionKey('claude', 'ws-1', false);

    const first = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);
    const second = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(host.allHandles).toHaveLength(1);

    await first.data.release();
    expect(host.lastHandle.kill).not.toHaveBeenCalled();
    expect(source.peek(key)).not.toBeUndefined();

    await second.data.release();
    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    await waitForTeardown();
    expect(source.peek(key)).toBeUndefined();
  });

  it('provisions separate workspaces independently', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));

    await acquireAsResult(
      source,
      makeAcpConnectionKey('claude', 'ws-1', false),
      acquireInput(agent, 'ws-1'),
      isAcpConnectionError
    );
    await acquireAsResult(
      source,
      makeAcpConnectionKey('claude', 'ws-2', false),
      acquireInput(agent, 'ws-2'),
      isAcpConnectionError
    );

    expect(host.allHandles).toHaveLength(2);
  });

  it('forwards process close and invalidates closed entries', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const onClosed = vi.fn();
    const source = createAcpConnectionSource(sourceDeps(host, onClosed));
    const key = makeAcpConnectionKey('claude', 'ws-1', false);

    await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);
    host.lastHandle.emitExit(7);

    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledWith(key, 7));
    await source.invalidate(key);
    await waitForTeardown();
    expect(source.peek(key)).toBeUndefined();
  });

  it('disposes all active pooled processes', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));
    const key = makeAcpConnectionKey('claude', 'ws-1', false);

    const acquired = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);
    expect(isOk(acquired)).toBe(true);
    await source.dispose();

    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    expect(source.peek(key)).toBeUndefined();
  });

  it('returns spawn_failed when spawn resolution fails', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const agentHost = {
      buildAcpSpawn: vi
        .fn()
        .mockResolvedValue(
          err({ type: 'cli-not-found', providerId: 'claude', message: 'missing cli' })
        ),
    } as unknown as AgentPluginHost;
    const source = createAcpConnectionSource(sourceDeps(host, vi.fn(), agentHost));
    const key = makeAcpConnectionKey('claude', 'ws-1', false);

    const result = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.type).toBe('spawn_failed');
    expect(result.error.cause?.message).toBe('missing cli');
    expect(host.allHandles).toHaveLength(0);
  });

  it('returns initialize_failed without notifying close when initialize fails', async () => {
    const agent = new FakeAcpAgent();
    agent.initialize = vi.fn().mockRejectedValue(new Error('init failed'));
    const host = new FakeAcpProcessHost();
    const onClosed = vi.fn();
    const source = createAcpConnectionSource(sourceDeps(host, onClosed));
    const key = makeAcpConnectionKey('claude', 'ws-1', false);

    const result = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.type).toBe('initialize_failed');
    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    expect(source.peek(key)).toBeUndefined();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('shares a single failed in-flight initialization across concurrent acquires', async () => {
    const agent = new FakeAcpAgent();
    agent.initialize = vi.fn().mockRejectedValue(new Error('init failed'));
    const host = new FakeAcpProcessHost();
    const onClosed = vi.fn();
    const source = createAcpConnectionSource(sourceDeps(host, onClosed));
    const key = makeAcpConnectionKey('claude', 'ws-1', false);

    const [first, second] = await Promise.all([
      acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError),
      acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError),
    ]);

    expect(isErr(first)).toBe(true);
    expect(isErr(second)).toBe(true);
    expect(host.allHandles).toHaveLength(1);
    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    expect(source.peek(key)).toBeUndefined();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('provisions separate pooled processes for auto-approve and manual conversations in the same workspace', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));

    const autoKey = makeAcpConnectionKey('claude', 'ws-1', true);
    const manualKey = makeAcpConnectionKey('claude', 'ws-1', false);
    await acquireAsResult(source, autoKey, acquireInput(agent, 'ws-1', true), isAcpConnectionError);
    await acquireAsResult(
      source,
      manualKey,
      acquireInput(agent, 'ws-1', false),
      isAcpConnectionError
    );

    expect(host.allHandles).toHaveLength(2);
    expect(autoKey).not.toBe(manualKey);
  });

  it('dedupes acquisitions sharing the same auto-approve flag', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));
    const key = makeAcpConnectionKey('claude', 'ws-1', true);

    await acquireAsResult(source, key, acquireInput(agent, 'ws-1', true), isAcpConnectionError);
    await acquireAsResult(source, key, acquireInput(agent, 'ws-1', true), isAcpConnectionError);

    expect(host.allHandles).toHaveLength(1);
  });

  it('forwards the auto-approve flag into the agent-host spawn context', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const buildAcpSpawn = vi
      .fn()
      .mockResolvedValue(ok({ command: '/fake/agent', args: [], env: {}, cwd: '/tmp/workspace' }));
    const source = createAcpConnectionSource(
      sourceDeps(host, vi.fn(), { buildAcpSpawn } as unknown as AgentPluginHost)
    );

    const result = await acquireAsResult(
      source,
      makeAcpConnectionKey('claude', 'ws-1', true),
      acquireInput(agent, 'ws-1', true),
      isAcpConnectionError
    );

    expect(isOk(result)).toBe(true);
    expect(buildAcpSpawn).toHaveBeenCalledWith('claude', {
      cwd: '/tmp/workspace',
      env: undefined,
      autoApprove: true,
    });
  });
});
