import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { conversationEvents } from './conversation-events';
import { maybeAutoTitleConversation } from './maybeAutoTitleConversation';

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

describe('maybeAutoTitleConversation', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const renamed =
    vi.fn<(conversationId: string, projectId: string, taskId: string, newTitle: string) => void>();
  let stopListening: () => void;

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

    renamed.mockClear();
    stopListening = conversationEvents.on('conversation:renamed', renamed);
  });

  afterEach(() => {
    stopListening();
    fixture.close();
    mocks.db = undefined;
  });

  function insertConversation(title = 'Claude (1)', id = 'conversation-1'): void {
    fixture.sqlite
      .prepare(
        `INSERT INTO conversations (id, project_id, task_id, title, provider, type)
         VALUES (?, 'project-1', 'task-1', ?, 'claude', 'pty')`
      )
      .run(id, title);
  }

  function storedTitle(id = 'conversation-1'): string {
    return (
      fixture.sqlite.prepare('SELECT title FROM conversations WHERE id = ?').get(id) as {
        title: string;
      }
    ).title;
  }

  it('stores the first meaningful line with collapsed whitespace', async () => {
    insertConversation();

    const result = await maybeAutoTitleConversation(
      'conversation-1',
      '\n  Investigate   the\tconversation titles  \nThis line is ignored',
      fixture.db
    );

    expect(result).toEqual({ applied: true, title: 'Investigate the conversation titles' });
    expect(storedTitle()).toBe('Investigate the conversation titles');
  });

  it('truncates a long title at a word boundary with an ellipsis', async () => {
    insertConversation();

    await maybeAutoTitleConversation(
      'conversation-1',
      'Investigate why conversation tabs lose their titles after restarting the application',
      fixture.db
    );

    expect(storedTitle()).toBe('Investigate why conversation tabs lose their…');
    expect(storedTitle().length).toBeLessThanOrEqual(48);
  });

  it('does not replace a manual title, including one set before the first prompt', async () => {
    insertConversation('Release blocker investigation');

    const result = await maybeAutoTitleConversation(
      'conversation-1',
      'Fix the release blocker',
      fixture.db
    );

    expect(result).toEqual({ applied: false, title: 'Release blocker investigation' });
    expect(storedTitle()).toBe('Release blocker investigation');
    expect(renamed).not.toHaveBeenCalled();
  });

  it('applies at most once when later prompts arrive', async () => {
    insertConversation();

    await maybeAutoTitleConversation('conversation-1', 'First prompt', fixture.db);
    await maybeAutoTitleConversation('conversation-1', 'Second prompt', fixture.db);

    expect(storedTitle()).toBe('First prompt');
    expect(renamed).toHaveBeenCalledTimes(1);
  });

  it.each(['', '   \n\t  ', '/help'])('ignores a non-meaningful prompt %j', async (prompt) => {
    insertConversation();

    const result = await maybeAutoTitleConversation('conversation-1', prompt, fixture.db);

    expect(result).toEqual({ applied: false });
    expect(storedTitle()).toBe('Claude (1)');
    expect(renamed).not.toHaveBeenCalled();
  });

  it('emits renamed and renderer change events exactly when a title is applied', async () => {
    insertConversation();

    await maybeAutoTitleConversation('conversation-1', 'Fix title propagation', fixture.db);

    expect(renamed).toHaveBeenCalledOnce();
    expect(renamed).toHaveBeenCalledWith(
      'conversation-1',
      'project-1',
      'task-1',
      'Fix title propagation'
    );
    expect(mocks.emit).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'conversation:changed' }),
      expect.objectContaining({ changes: { title: 'Fix title propagation' } })
    );
  });
});
