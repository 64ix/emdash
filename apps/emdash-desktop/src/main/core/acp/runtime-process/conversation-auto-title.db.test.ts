import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { withConversationAutoTitle } from './conversation-auto-title';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));

type AcpRuntimeClient = Parameters<typeof withConversationAutoTitle>[0];

const rejectedPrompt = {
  success: false,
  error: { type: 'prompt_failed', error: { name: 'Error', message: 'rejected' } },
};

function makeRejectingClient(): AcpRuntimeClient {
  return {
    startSession: async () => rejectedPrompt,
    sendPrompt: async () => rejectedPrompt,
    queuePrompt: async () => rejectedPrompt,
  } as unknown as AcpRuntimeClient;
}

describe('withConversationAutoTitle', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();

    fixture.sqlite
      .prepare(
        `INSERT INTO projects (id, name, path, created_at, updated_at)
         VALUES ('project-1', 'Project', '/repo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run();
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status)
         VALUES ('task-1', 'project-1', 'Task', 'in_progress')`
      )
      .run();
    fixture.sqlite
      .prepare(
        `INSERT INTO conversations (id, project_id, task_id, title, provider, type)
         VALUES ('conversation-1', 'project-1', 'task-1', 'Claude (1)', 'claude', 'acp')`
      )
      .run();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  function storedTitle(): string {
    return (
      fixture.sqlite
        .prepare("SELECT title FROM conversations WHERE id = 'conversation-1'")
        .get() as { title: string }
    ).title;
  }

  it('stores the initial ACP prompt even when session start is rejected', async () => {
    const client = withConversationAutoTitle(makeRejectingClient());

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

    expect(storedTitle()).toBe('Initial ACP prompt');
  });

  it.each(['sendPrompt', 'queuePrompt'] as const)(
    'stores the first %s prompt and ignores a later prompt when dispatch is rejected',
    async (method) => {
      const client = withConversationAutoTitle(makeRejectingClient());

      await client[method]({
        conversationId: 'conversation-1',
        prompt: { text: 'First observable prompt' },
      });
      await client[method]({
        conversationId: 'conversation-1',
        prompt: { text: 'Later prompt' },
      });

      expect(storedTitle()).toBe('First observable prompt');
    }
  );
});
