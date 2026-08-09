/**
 * Conversation resumability (spec #130, ticket #137): `sessionId` is
 * machine-specific and never synced, so a conversation imported from another
 * machine has no session on this machine until one is created. The store
 * exposes `isResumable` (imported && no local session → not resumable) and the
 * conversation list renders the "not resumable on this device" state from it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@shared/core/conversations/conversations';
import { ConversationStore } from './conversation-manager';

// The manager store's module graph pulls renderer/pty/chat modules; mock the
// same seams as conversation-manager.test.ts so this stays a node-level test.
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
      dehydrateConversation: vi.fn(),
      getConversationsForTask: vi.fn(),
      hydrateConversation: vi.fn(),
      markConversationSeen: vi.fn(),
    },
  },
}));

vi.mock('@renderer/lib/pty/pty', () => ({
  FrontendPty: class {
    constructor(readonly sessionId: string) {}
    connect = vi.fn();
    dispose = vi.fn();
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    projectId: 'project-1',
    taskId: 'task-1',
    providerId: 'codex',
    title: 'Fix bug',
    lastInteractedAt: '2026-01-01T00:00:00.000Z',
    isInitialConversation: null,
    source: 'local',
    ...overrides,
  };
}

describe('ConversationStore.isResumable', () => {
  it('is resumable for locally-created conversations even before first spawn', () => {
    const store = new ConversationStore(makeConversation({ source: 'local' }));
    expect(store.isResumable).toBe(true);
  });

  it('is not resumable for an imported conversation without a local session', () => {
    const store = new ConversationStore(
      makeConversation({ source: 'imported', sessionId: undefined })
    );
    expect(store.isResumable).toBe(false);
  });

  it('becomes resumable once a local session exists', () => {
    const store = new ConversationStore(
      makeConversation({ source: 'imported', sessionId: 'local-session-1' })
    );
    expect(store.isResumable).toBe(true);
  });

  it('defaults to local (resumable) when source is absent', () => {
    // Older payloads predate the source field; they are local by definition.
    const store = new ConversationStore(makeConversation({ source: undefined }));
    expect(store.isResumable).toBe(true);
  });
});
