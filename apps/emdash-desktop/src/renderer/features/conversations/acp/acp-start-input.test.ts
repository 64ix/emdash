import { describe, expect, it } from 'vitest';
import type { Conversation } from '@shared/core/conversations/conversations';
import { buildAcpStartInput, type AcpStartInputSource } from './acp-start-input';

const baseConversation: Conversation = {
  id: 'conversation-1',
  projectId: 'project-1',
  taskId: 'task-1',
  providerId: 'opencode',
  title: 'Auto-approve test',
  lastInteractedAt: null,
  isInitialConversation: false,
  type: 'acp',
};

function makeSource(conversation: Conversation): AcpStartInputSource {
  return {
    conversationId: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    workspacePath: '/worktrees/task-1',
    conversation,
  };
}

describe('buildAcpStartInput', () => {
  it('copies autoApprove from the conversation when enabled', () => {
    const input = buildAcpStartInput(
      makeSource({ ...baseConversation, autoApprove: true, model: 'sonnet' })
    );

    expect(input.autoApprove).toBe(true);
    expect(input.model).toBe('sonnet');
    expect(input.providerId).toBe('opencode');
    expect(input.cwd).toBe('/worktrees/task-1');
    expect(input.workspaceId).toBe('workspace-1');
    expect(input.sessionId).toBeNull();
  });

  it('defaults autoApprove to false when the conversation does not set it', () => {
    const input = buildAcpStartInput(makeSource({ ...baseConversation, autoApprove: undefined }));

    expect(input.autoApprove).toBe(false);
  });

  it('defaults autoApprove to false when the conversation explicitly disables it', () => {
    const input = buildAcpStartInput(makeSource({ ...baseConversation, autoApprove: false }));

    expect(input.autoApprove).toBe(false);
  });

  it('carries the session id once established', () => {
    const input = buildAcpStartInput(makeSource({ ...baseConversation, sessionId: 'ses_123' }));

    expect(input.sessionId).toBe('ses_123');
  });

  it('queues initial prompts only before a session id is established', () => {
    const fresh = buildAcpStartInput(
      makeSource({ ...baseConversation, initialQueue: [{ text: 'first' }, { text: 'second' }] })
    );
    expect(fresh.sessionId).toBeNull();
    expect(fresh.initialQueue).toEqual([{ text: 'first' }, { text: 'second' }]);

    const resumed = buildAcpStartInput(
      makeSource({
        ...baseConversation,
        sessionId: 'ses_123',
        initialQueue: [{ text: 'stale' }],
      })
    );
    expect(resumed.sessionId).toBe('ses_123');
    expect(resumed.initialQueue).toBeUndefined();
  });
});
