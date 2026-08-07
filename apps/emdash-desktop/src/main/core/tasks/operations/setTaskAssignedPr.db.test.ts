import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { pullRequests, tasks } from '@main/db/schema';
import { getTasks } from './getTasks';
import { setTaskAssignedPr } from './setTaskAssignedPr';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

/**
 * Ticket #100's round-trip test: `setTaskAssignedPr` persists the assignment
 * in `tasks.assigned_pr_url`, `getTasks` resolves it back into
 * `Task.assignedPr` (the payload the titlebar chip and the Task Detail Panel
 * both read through `resolveTaskPr`), and unassigning reverts to no
 * assignment. Also covers the PR-sync survival seam: deleting the referenced
 * PR row (what `_archiveOldPrs`/`deleteProjectData` do) leaves the task row
 * intact — the FK's ON DELETE SET NULL nulls the column instead of breaking
 * the round trip.
 */
describe('setTaskAssignedPr (assign/unassign round trip)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  const PR_URL = 'https://github.com/example/repo/pull/42';

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;

    fixture.sqlite
      .prepare(
        `INSERT INTO projects (id, name, path, created_at, updated_at)
         VALUES ('project-1', 'Project', '/repo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run();

    fixture.sqlite
      .prepare(
        `INSERT INTO pull_requests (
           url, repository_url, base_ref_name, base_ref_oid, head_repository_url,
           head_ref_name, head_ref_oid, identifier, title, status
         )
         VALUES (?, 'https://github.com/example/repo.git', 'main', ?, 'https://github.com/example/repo.git',
                 'feat/thing', ?, '#42', 'Add the thing', 'open')`
      )
      .run(PR_URL, 'b'.repeat(40), 'h'.repeat(40));

    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (
           id, project_id, name, status, created_at, updated_at, status_changed_at
         )
         VALUES (
           'task-1', 'project-1', 'Round-trip task', 'review',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )`
      )
      .run();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('assigns a synced PR, persists it, and getTasks resolves it back into the task payload', async () => {
    await setTaskAssignedPr('task-1', PR_URL);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.assignedPrUrl).toBe(PR_URL);

    const [task] = await getTasks('project-1');
    expect(task?.assignedPr?.url).toBe(PR_URL);
    expect(task?.assignedPr?.identifier).toBe('#42');
    expect(task?.assignedPr?.status).toBe('open');
  });

  it('unassigns back to a null column and leaves assignedPr undefined', async () => {
    await setTaskAssignedPr('task-1', PR_URL);
    await setTaskAssignedPr('task-1', null);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.assignedPrUrl).toBeNull();

    const [task] = await getTasks('project-1');
    expect(task?.assignedPr).toBeUndefined();
  });

  it('throws for a task that does not exist', async () => {
    await expect(setTaskAssignedPr('missing', PR_URL)).rejects.toThrow(/Task not found/);
  });

  it('throws for a PR url that is not a synced pull request', async () => {
    await expect(
      setTaskAssignedPr('task-1', 'https://github.com/example/repo/pull/999')
    ).rejects.toThrow(/Pull request not found/);
  });

  it('survives a PR sync that deletes the referenced PR: the FK nulls the assignment instead of breaking it', async () => {
    await setTaskAssignedPr('task-1', PR_URL);

    // What `_archiveOldPrs` / `deleteProjectData` do: delete the PR rows.
    await fixture.db.delete(pullRequests).where(eq(pullRequests.url, PR_URL));

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.assignedPrUrl).toBeNull();

    // And the round trip still works: the task resolves with no assignment,
    // and can be re-assigned to a (re-synced) PR.
    const [task] = await getTasks('project-1');
    expect(task?.assignedPr).toBeUndefined();
  });
});
