import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationManagerStore } from './conversation-manager';

const hydrateConversation = vi.hoisted(() => vi.fn());
const dehydrateConversation = vi.hoisted(() => vi.fn());
const frontendConnect = vi.hoisted(() => vi.fn());
const frontendDispose = vi.hoisted(() => vi.fn());

vi.mock('@renderer/features/tasks/stores/open-file-in-file-editor', () => ({
  makeFileLinkHandlers: () => ({
    onOpenExternal: vi.fn(),
    onOpenFile: vi.fn(),
  }),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    conversations: {
      dehydrateConversation,
      getConversationsForTask: vi.fn(),
      hydrateConversation,
    },
  },
}));

vi.mock('@renderer/lib/pty/pty', () => ({
  FrontendPty: class {
    constructor(readonly sessionId: string) {}

    connect = frontendConnect;
    dispose = frontendDispose;
  },
}));

describe('ConversationManagerStore session hydration', () => {
  beforeEach(() => {
    hydrateConversation.mockReset();
    dehydrateConversation.mockReset();
    frontendConnect.mockReset();
    frontendDispose.mockReset();

    hydrateConversation.mockResolvedValue(undefined);
    dehydrateConversation.mockResolvedValue(undefined);
    frontendConnect.mockResolvedValue(undefined);
  });

  it('does not hydrate conversations from the PTY session connect path', async () => {
    const store = new ConversationManagerStore('project-1', 'task-1', [
      {
        id: 'conversation-1',
        projectId: 'project-1',
        taskId: 'task-1',
        providerId: 'codex',
        title: 'Conversation 1',
        lastInteractedAt: null,
        isInitialConversation: false,
      },
    ]);

    const session = store.sessions.get('conversation-1');
    expect(session).toBeDefined();

    await session?.connect();

    expect(hydrateConversation).not.toHaveBeenCalled();
    expect(frontendConnect).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it('restartConversation kills the backend session and swaps in a fresh renderer session', async () => {
    const store = new ConversationManagerStore('project-1', 'task-1', [
      {
        id: 'conversation-1',
        projectId: 'project-1',
        taskId: 'task-1',
        providerId: 'codex',
        title: 'Conversation 1',
        lastInteractedAt: null,
        isInitialConversation: false,
      },
    ]);

    const originalSession = store.sessions.get('conversation-1');
    expect(originalSession).toBeDefined();
    await originalSession?.connect();
    expect(dehydrateConversation).not.toHaveBeenCalled();

    await store.restartConversation('conversation-1');

    // Backend: tear down first (kills the PTY), then respawn with resume.
    expect(dehydrateConversation).toHaveBeenCalledTimes(1);
    expect(dehydrateConversation).toHaveBeenCalledWith('project-1', 'task-1', 'conversation-1');
    expect(hydrateConversation).toHaveBeenCalledTimes(1);
    expect(hydrateConversation).toHaveBeenCalledWith('project-1', 'task-1', 'conversation-1');
    expect(dehydrateConversation.mock.invocationCallOrder[0]).toBeLessThan(
      hydrateConversation.mock.invocationCallOrder[0]
    );

    // Renderer: the disposed session is replaced so the tab reconnects lazily
    // into a clean xterm instead of replaying into a dead one.
    const replacementSession = store.sessions.get('conversation-1');
    expect(replacementSession).toBeDefined();
    expect(replacementSession).not.toBe(originalSession);
    expect(originalSession?.status).toBe('disconnected');
    expect(frontendDispose).toHaveBeenCalled();

    store.dispose();
  });

  it('restartConversation still replaces the session when hydration fails', async () => {
    hydrateConversation.mockRejectedValue(new Error('spawn failed'));
    const store = new ConversationManagerStore('project-1', 'task-1', [
      {
        id: 'conversation-1',
        projectId: 'project-1',
        taskId: 'task-1',
        providerId: 'codex',
        title: 'Conversation 1',
        lastInteractedAt: null,
        isInitialConversation: false,
      },
    ]);

    const originalSession = store.sessions.get('conversation-1');

    await expect(store.restartConversation('conversation-1')).rejects.toThrow('spawn failed');

    const replacementSession = store.sessions.get('conversation-1');
    expect(replacementSession).toBeDefined();
    expect(replacementSession).not.toBe(originalSession);

    store.dispose();
  });
});
