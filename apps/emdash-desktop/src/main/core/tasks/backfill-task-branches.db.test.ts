import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects, tasks, workspaces } from '@main/db/schema';
import { backfillTaskBranches } from './backfill-task-branches';

describe('backfillTaskBranches', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(projects).values({ id: 'proj-1', name: 'Test Project', path: '/repo' });
  });

  afterEach(() => {
    fixture.close();
  });

  async function insertWorkspace(overrides: Record<string, unknown> = {}) {
    const [ws] = await fixture.db
      .insert(workspaces)
      .values({
        id: 'ws-1',
        kind: 'worktree',
        location: 'local',
        type: 'local',
        ...overrides,
      })
      .returning();
    return ws;
  }

  async function insertTask(id: string, workspaceId: string, taskBranch: string | null) {
    await fixture.db.insert(tasks).values({
      id,
      projectId: 'proj-1',
      name: `Task ${id}`,
      status: 'in_progress',
      workspaceId,
      taskBranch,
    });
  }

  it('backfills task_branch from the workspace config (create-branch)', async () => {
    await insertWorkspace({
      config: {
        version: '3',
        git: {
          kind: 'create-branch',
          branchName: 'feature/x',
          fromBranch: { type: 'local', branch: 'main' },
        },
        workspace: { kind: 'new-worktree' },
      },
    });
    await insertTask('task-1', 'ws-1', null);

    backfillTaskBranches(fixture.db);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.taskBranch).toBe('feature/x');
  });

  it('backfills the task branch of a pr-branch config', async () => {
    await insertWorkspace({
      config: {
        version: '3',
        git: {
          kind: 'pr-branch',
          prNumber: 153,
          headBranch: 'pr/153-head',
          headRepositoryUrl: 'https://github.com/64ix/emdash',
          isFork: false,
          taskBranch: 'task/from-pr',
        },
        workspace: { kind: 'new-worktree' },
      },
    });
    await insertTask('task-1', 'ws-1', null);

    backfillTaskBranches(fixture.db);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.taskBranch).toBe('task/from-pr');
  });

  it('falls back to the workspace branch_name column when there is no config', async () => {
    await insertWorkspace({ config: null, branchName: 'legacy/branch' });
    await insertTask('task-1', 'ws-1', null);

    backfillTaskBranches(fixture.db);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.taskBranch).toBe('legacy/branch');
  });

  it('leaves branchless tasks untouched', async () => {
    await insertWorkspace({
      kind: 'project-root',
      config: null,
      branchName: null,
    });
    await insertTask('task-1', 'ws-1', null);

    backfillTaskBranches(fixture.db);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.taskBranch).toBeNull();
  });

  it('leaves tasks that already carry a task_branch untouched', async () => {
    await insertWorkspace({
      config: {
        version: '3',
        git: { kind: 'use-branch', branchName: 'feature/x' },
        workspace: { kind: 'new-worktree' },
      },
    });
    await insertTask('task-1', 'ws-1', 'task/kept');

    backfillTaskBranches(fixture.db);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.taskBranch).toBe('task/kept');
  });

  it('is idempotent', async () => {
    await insertWorkspace({
      config: {
        version: '3',
        git: { kind: 'use-branch', branchName: 'feature/x' },
        workspace: { kind: 'new-worktree' },
      },
    });
    await insertTask('task-1', 'ws-1', null);

    backfillTaskBranches(fixture.db);
    const updatedAtAfterFirstRun = (
      await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'))
    )[0]?.updatedAt;
    backfillTaskBranches(fixture.db);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row.taskBranch).toBe('feature/x');
    expect(row.updatedAt).toBe(updatedAtAfterFirstRun);
  });
});
