import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projectRemotes, projects, pullRequests, tasks, workspaces } from '@main/db/schema';
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

  // ── Global Board seam (spec #104, ticket #105): no-projectId path ──────────

  const REPO_A = 'https://github.com/acme/repo-a';
  const REPO_B = 'https://github.com/acme/repo-b';

  function insertProject(id: string): Promise<unknown> {
    return fixture.db
      .insert(projects)
      .values({ id, name: `Project ${id}`, path: `/repo/${id}` });
  }

  function insertRemote(projectId: string, remoteUrl: string): Promise<unknown> {
    return fixture.db
      .insert(projectRemotes)
      .values({ projectId, remoteName: 'origin', remoteUrl });
  }

  function insertWorkspace(id: string, branchName: string | null): Promise<unknown> {
    return fixture.db.insert(workspaces).values({ id, type: 'local', branchName });
  }

  function insertTask(row: {
    id: string;
    projectId: string;
    name: string;
    workspaceId?: string | null;
  }): Promise<unknown> {
    return fixture.db.insert(tasks).values({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      status: 'in_progress',
      workspaceId: row.workspaceId ?? null,
    });
  }

  function insertPr(row: {
    url: string;
    repositoryUrl: string;
    headRepositoryUrl?: string;
    headRefName: string;
    identifier?: string;
    title?: string;
  }): Promise<unknown> {
    return fixture.db.insert(pullRequests).values({
      url: row.url,
      repositoryUrl: row.repositoryUrl,
      baseRefName: 'main',
      baseRefOid: 'b'.repeat(40),
      headRepositoryUrl: row.headRepositoryUrl ?? row.repositoryUrl,
      headRefName: row.headRefName,
      headRefOid: 'h'.repeat(40),
      identifier: row.identifier ?? null,
      title: row.title ?? 'PR title',
    });
  }

  it('without a projectId returns tasks across all projects', async () => {
    await insertProject('project-2');
    await insertTask({ id: 'task-a', projectId: 'project-1', name: 'Task A' });
    await insertTask({ id: 'task-b', projectId: 'project-2', name: 'Task B' });

    const rows = await getTasks();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.id, r.projectId])).toEqual([
      ['task-a', 'project-1'],
      ['task-b', 'project-2'],
    ]);
  });

  it('loads each task’s branch-matched PRs with one batched query (no-projectId path)', async () => {
    await insertProject('project-2');
    await insertRemote('project-1', REPO_A);
    await insertRemote('project-2', REPO_B);
    await insertWorkspace('ws-a', 'feature/a');
    await insertWorkspace('ws-b', 'feature/b');
    await insertTask({ id: 'task-a', projectId: 'project-1', name: 'Task A', workspaceId: 'ws-a' });
    await insertTask({ id: 'task-b', projectId: 'project-2', name: 'Task B', workspaceId: 'ws-b' });
    await insertPr({
      url: `${REPO_A}/pull/1`,
      repositoryUrl: REPO_A,
      headRefName: 'feature/a',
      identifier: '#1',
      title: 'PR for A',
    });
    await insertPr({
      url: `${REPO_B}/pull/2`,
      repositoryUrl: REPO_B,
      headRefName: 'feature/b',
      identifier: '#2',
      title: 'PR for B',
    });

    // One batched `pull_requests` statement must serve every returned task —
    // never one query per task.
    let pullRequestQueries = 0;
    const originalPrepare = fixture.sqlite.prepare.bind(fixture.sqlite);
    const prepareSpy = vi
      .spyOn(fixture.sqlite, 'prepare')
      .mockImplementation((sql: string) => {
        if (sql.includes('from "pull_requests"')) pullRequestQueries += 1;
        return originalPrepare(sql);
      });

    const rows = await getTasks();
    prepareSpy.mockRestore();

    expect(pullRequestQueries).toBe(1);
    const taskA = rows.find((r) => r.id === 'task-a');
    const taskB = rows.find((r) => r.id === 'task-b');
    expect(taskA?.prs).toHaveLength(1);
    expect(taskA?.prs[0]?.identifier).toBe('#1');
    expect(taskA?.prs[0]?.title).toBe('PR for A');
    expect(taskB?.prs).toHaveLength(1);
    expect(taskB?.prs[0]?.identifier).toBe('#2');
    expect(taskB?.prs[0]?.headRefName).toBe('feature/b');
  });

  it('scopes batched PRs per project so a shared branch name never leaks a PR across projects', async () => {
    await insertProject('project-2');
    await insertRemote('project-1', REPO_A);
    await insertRemote('project-2', REPO_B);
    await insertWorkspace('ws-a', 'feature/shared');
    await insertWorkspace('ws-b', 'feature/shared');
    await insertTask({ id: 'task-a', projectId: 'project-1', name: 'Task A', workspaceId: 'ws-a' });
    await insertTask({ id: 'task-b', projectId: 'project-2', name: 'Task B', workspaceId: 'ws-b' });
    // Only project-1's repo has a PR on the shared branch.
    await insertPr({
      url: `${REPO_A}/pull/1`,
      repositoryUrl: REPO_A,
      headRefName: 'feature/shared',
      identifier: '#1',
    });

    const rows = await getTasks();

    expect(rows.find((r) => r.id === 'task-a')?.prs).toHaveLength(1);
    expect(rows.find((r) => r.id === 'task-b')?.prs).toEqual([]);
  });

  it('leaves prs empty for tasks with no workspace or no branch (no-projectId path)', async () => {
    await insertProject('project-2');
    await insertRemote('project-1', REPO_A);
    await insertWorkspace('ws-a', null);
    await insertTask({ id: 'task-a', projectId: 'project-1', name: 'Task A', workspaceId: 'ws-a' });
    await insertTask({ id: 'task-b', projectId: 'project-2', name: 'Task B' });
    await insertPr({
      url: `${REPO_A}/pull/1`,
      repositoryUrl: REPO_A,
      headRefName: 'feature/a',
      identifier: '#1',
    });

    const rows = await getTasks();

    expect(rows.find((r) => r.id === 'task-a')?.prs).toEqual([]);
    expect(rows.find((r) => r.id === 'task-b')?.prs).toEqual([]);
  });

  it('keeps the projectId path unchanged — prs stay empty and only that project’s tasks are returned', async () => {
    await insertProject('project-2');
    await insertRemote('project-1', REPO_A);
    await insertWorkspace('ws-a', 'feature/a');
    await insertTask({ id: 'task-a', projectId: 'project-1', name: 'Task A', workspaceId: 'ws-a' });
    await insertTask({ id: 'task-b', projectId: 'project-2', name: 'Task B' });
    await insertPr({
      url: `${REPO_A}/pull/1`,
      repositoryUrl: REPO_A,
      headRefName: 'feature/a',
      identifier: '#1',
    });

    const rows = await getTasks('project-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('task-a');
    expect(rows[0]?.prs).toEqual([]);
  });
});
