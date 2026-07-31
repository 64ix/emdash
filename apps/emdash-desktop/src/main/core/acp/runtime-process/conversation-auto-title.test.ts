import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withConversationAutoTitle } from './conversation-auto-title';

const mocks = vi.hoisted(() => ({
  maybeAutoTitleConversation: vi.fn(),
}));

vi.mock('@main/core/conversations/maybeAutoTitleConversation', () => ({
  maybeAutoTitleConversation: mocks.maybeAutoTitleConversation,
}));

type AcpRuntimeClient = Parameters<typeof withConversationAutoTitle>[0];

function makeClient(overrides: Partial<AcpRuntimeClient> = {}): AcpRuntimeClient {
  return {
    startSession: vi.fn(),
    sendPrompt: vi.fn(),
    queuePrompt: vi.fn(),
    ...overrides,
  } as unknown as AcpRuntimeClient;
}

describe('withConversationAutoTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeAutoTitleConversation.mockResolvedValue({ applied: true, title: 'Prompt title' });
  });

  it('captures the initial ACP prompt before starting the provider session', async () => {
    const startSession = vi.fn().mockResolvedValue({
      success: true,
      data: { sessionId: 'session-1' },
    });
    const client = withConversationAutoTitle(makeClient({ startSession }));

    await client.startSession({
      input: {
        conversationId: 'conversation-1',
        projectId: 'project-1',
        taskId: 'task-1',
        providerId: 'claude',
        workspaceId: 'workspace-1',
        cwd: '/repo',
        sessionId: null,
        model: null,
        initialQueue: [{ text: 'Initial ACP prompt' }],
      },
    });

    expect(mocks.maybeAutoTitleConversation).toHaveBeenCalledWith(
      'conversation-1',
      'Initial ACP prompt'
    );
    expect(mocks.maybeAutoTitleConversation.mock.invocationCallOrder[0]).toBeLessThan(
      startSession.mock.invocationCallOrder[0]
    );
  });

  it.each(['sendPrompt', 'queuePrompt'] as const)(
    'captures %s text before dispatch, even when the provider rejects it',
    async (method) => {
      const dispatch = vi.fn().mockResolvedValue({
        success: false,
        error: { type: 'prompt_failed', error: { name: 'Error', message: 'rejected' } },
      });
      const client = withConversationAutoTitle(makeClient({ [method]: dispatch }));

      await client[method]({
        conversationId: 'conversation-1',
        prompt: { text: 'First observable prompt' },
      });

      expect(mocks.maybeAutoTitleConversation).toHaveBeenCalledWith(
        'conversation-1',
        'First observable prompt'
      );
      expect(mocks.maybeAutoTitleConversation.mock.invocationCallOrder[0]).toBeLessThan(
        dispatch.mock.invocationCallOrder[0]
      );
    }
  );
});
