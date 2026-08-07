import type { AcpStartInputWire } from '@emdash/core/acp';
import { describe, expect, it } from 'vitest';
import type { ProviderCustomConfig } from '@shared/core/app-settings';
import { applyProviderLaunchDefaults } from './start-input-defaults';

function makeBaseInput(): AcpStartInputWire {
  return {
    conversationId: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    providerId: 'opencode',
    workspaceId: 'workspace-1',
    cwd: '/tmp/workspace',
    sessionId: null,
    model: null,
  };
}

describe('applyProviderLaunchDefaults', () => {
  const config: ProviderCustomConfig = { defaultModel: 'gpt-5-codex', defaultEffort: 'high' };

  it('fills model and effort from the per-provider config when absent', () => {
    const input = applyProviderLaunchDefaults(makeBaseInput(), config);
    expect(input.model).toBe('gpt-5-codex');
    expect(input.effort).toBe('high');
  });

  it('keeps an explicitly chosen model and effort', () => {
    const input = applyProviderLaunchDefaults(
      { ...makeBaseInput(), model: 'claude-sonnet-5', effort: 'low' },
      config
    );
    expect(input.model).toBe('claude-sonnet-5');
    expect(input.effort).toBe('low');
  });

  it('keeps an explicit model when only an effort default exists', () => {
    const input = applyProviderLaunchDefaults(
      { ...makeBaseInput(), model: 'claude-sonnet-5' },
      { defaultEffort: 'high' }
    );
    expect(input.model).toBe('claude-sonnet-5');
    expect(input.effort).toBe('high');
  });

  it('leaves fields null when no defaults are configured', () => {
    const input = applyProviderLaunchDefaults(makeBaseInput(), {});
    expect(input.model).toBeNull();
    expect(input.effort).toBeNull();
  });

  it('leaves other start input fields untouched', () => {
    const input = applyProviderLaunchDefaults(
      { ...makeBaseInput(), initialQueue: [{ text: 'hello' }], env: { K: 'v' } },
      config
    );
    expect(input.initialQueue).toEqual([{ text: 'hello' }]);
    expect(input.env).toEqual({ K: 'v' });
    expect(input.conversationId).toBe('conversation-1');
  });
});
