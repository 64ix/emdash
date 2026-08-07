import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { getTasks } from './getTasks';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

describe('getTasks', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;

    fixture.sqlite
      .prepare(
        `INSERT INTO projects (id, name, path, created_at, updated_at)
         VALUES ('project-1', 'Project', '/repo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('loads tasks from the database', async () => {
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (
           id,
           project_id,
           name,
           status,
           created_at,
           updated_at,
           status_changed_at
         )
         VALUES (
           'task-1',
           'project-1',
           'My Task',
           'in_progress',
           CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP
         )`
      )
      .run();

    const rows = await getTasks('project-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('My Task');
    expect(rows[0]!.id).toBe('task-1');
  });

  it('resolves the assigned PR from the assigned_pr_url FK (CONTEXT.md "Assigned PR")', async () => {
    const prUrl = 'https://github.com/example/repo/pull/42';
    fixture.sqlite
      .prepare(
        `INSERT INTO pull_requests (
           url, repository_url, base_ref_name, base_ref_oid, head_repository_url,
           head_ref_name, head_ref_oid, identifier, title, status
         )
         VALUES (?, 'https://github.com/example/repo.git', 'main', ?, 'https://github.com/example/repo.git',
                 'feat/thing', ?, '#42', 'Add the thing', 'open')`
      )
      .run(prUrl, 'b'.repeat(40), 'h'.repeat(40));

    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (
           id, project_id, name, status, assigned_pr_url, created_at, updated_at, status_changed_at
         )
         VALUES (
           'task-2', 'project-1', 'Assigned task', 'review', ?,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )`
      )
      .run(prUrl);

    const rows = await getTasks('project-1');

    const task = rows.find((r) => r.id === 'task-2');
    expect(task?.assignedPr?.url).toBe(prUrl);
    expect(task?.assignedPr?.identifier).toBe('#42');
    expect(task?.assignedPr?.status).toBe('open');
  });

  it('leaves assignedPr undefined for tasks without an assigned_pr_url', async () => {
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (
           id, project_id, name, status, created_at, updated_at, status_changed_at
         )
         VALUES (
           'task-3', 'project-1', 'Plain task', 'in_progress',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )`
      )
      .run();

    const rows = await getTasks('project-1');

    expect(rows.find((r) => r.id === 'task-3')?.assignedPr).toBeUndefined();
  });
});
