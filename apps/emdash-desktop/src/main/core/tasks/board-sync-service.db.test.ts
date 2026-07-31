import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projectRemotes, projects, pullRequests, tasks, workspaces } from '@main/db/schema';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequestStatus } from '@shared/core/pull-requests/pull-requests';

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

vi.mock('@main/lib/events', () => ({
  events: {
    emit: mocks.emit,
    on: vi.fn(),
  },
}));

vi.mock('@main/core/tasks/task-session-manager', () => ({
  taskSessionManager: {
    hooks: { on: vi.fn() },
  },
}));

const { BoardSyncService } = await import('./board-sync-service');

const PROJECT_ID = 'project-1';
const REPOSITORY_URL = 'https://github.com/acme/repo';

function specLink(identifier: string): LinkedIssueRoles {
  return {
    version: '1',
    spec: {
      provider: 'github',
      url: `${REPOSITORY_URL}/issues/${identifier.replace('#', '')}`,
      title: `[Spec] Feature ${identifier}`,
      identifier,
    },
  };
}

async function insertTask(
  db: NonNullable<typeof mocks.db>,
  overrides: {
    id: string;
    workflowStage?: string | null;
    linkedIssues?: LinkedIssueRoles | null;
    workspaceId?: string | null;
  }
) {
  await db.insert(tasks).values({
    id: overrides.id,
    projectId: PROJECT_ID,
    name: overrides.id,
    status: 'in_progress',
    workflowStage: overrides.workflowStage ?? null,
    linkedIssues: overrides.linkedIssues ?? null,
    workspaceId: overrides.workspaceId ?? null,
  });
}

async function insertWorkspace(
  db: NonNullable<typeof mocks.db>,
  id: string,
  branchName: string
): Promise<void> {
  await db.insert(workspaces).values({ id, type: 'local', branchName });
}

async function insertPr(
  db: NonNullable<typeof mocks.db>,
  overrides: {
    url: string;
    headRefName: string;
    status: PullRequestStatus;
    description?: string | null;
  }
): Promise<void> {
  await db.insert(pullRequests).values({
    url: overrides.url,
    repositoryUrl: REPOSITORY_URL,
    baseRefName: 'main',
    baseRefOid: 'base-oid',
    headRepositoryUrl: REPOSITORY_URL,
    headRefName: overrides.headRefName,
    headRefOid: 'head-oid',
    identifier: '#1',
    title: 'PR',
    description: overrides.description ?? null,
    status: overrides.status,
  });
}

async function stageOf(db: NonNullable<typeof mocks.db>, taskId: string): Promise<string | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row?.workflowStage ?? null;
}

describe('BoardSyncService', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let service: InstanceType<typeof BoardSyncService>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();
    service = new BoardSyncService();

    await fixture.db.insert(projects).values({ id: PROJECT_ID, name: 'Project', path: '/repo' });
    await fixture.db.insert(projectRemotes).values({
      projectId: PROJECT_ID,
      remoteName: 'origin',
      remoteUrl: REPOSITORY_URL,
    });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  describe('syncProject — authority table', () => {
    it('puts a Spec-linked task in review when an open PR references the Spec', async () => {
      await insertTask(fixture.db, { id: 'task-review', linkedIssues: specLink('#100') });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/1`,
        headRefName: 'feature/1',
        status: 'open',
        description: 'Closes #100',
      });

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-review')).toBe('review');
      expect(mocks.emit).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'task:workflow-stage-updated' }),
        expect.objectContaining({ taskId: 'task-review', stage: 'review' })
      );
    });

    it('puts a Spec-linked task in shipped when its PR merged', async () => {
      await insertTask(fixture.db, { id: 'task-shipped', linkedIssues: specLink('#101') });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/2`,
        headRefName: 'feature/2',
        status: 'merged',
        description: 'Closes #101',
      });

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-shipped')).toBe('shipped');
    });

    it('puts a Spec-linked task in triage when its PR closed without merging', async () => {
      await insertTask(fixture.db, { id: 'task-triage', linkedIssues: specLink('#102') });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/3`,
        headRefName: 'feature/3',
        status: 'closed',
        description: 'Closes #102',
      });

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-triage')).toBe('triage');
    });

    it('falls back to the task branch match when no PR references the Spec number', async () => {
      await insertWorkspace(fixture.db, 'ws-branch-fallback', 'task/branch-fallback');
      await insertTask(fixture.db, {
        id: 'task-branch-fallback',
        linkedIssues: specLink('#199'),
        workspaceId: 'ws-branch-fallback',
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/4`,
        headRefName: 'task/branch-fallback',
        status: 'open',
        description: null,
      });

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-branch-fallback')).toBe('review');
    });
  });

  describe('syncProject — precedence and regressions', () => {
    it('overrides manual placement with a GitHub-proven fact', async () => {
      await insertTask(fixture.db, {
        id: 'task-manual',
        workflowStage: 'idea',
        linkedIssues: specLink('#103'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/5`,
        headRefName: 'feature/5',
        status: 'merged',
        description: 'Closes #103',
      });

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-manual')).toBe('shipped');
    });

    it('never auto-moves a link-less task, even when its own branch matches an open PR', async () => {
      await insertWorkspace(fixture.db, 'ws-linkless', 'task/linkless-branch');
      await insertTask(fixture.db, {
        id: 'task-linkless',
        linkedIssues: null,
        workspaceId: 'ws-linkless',
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/6`,
        headRefName: 'task/linkless-branch',
        status: 'open',
        description: null,
      });

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-linkless')).toBeNull();
      expect(mocks.emit).not.toHaveBeenCalled();
    });

    it('never moves a task out of triage on the periodic pass, even when its PR reopens', async () => {
      await insertTask(fixture.db, {
        id: 'task-triage-sink',
        workflowStage: 'triage',
        linkedIssues: specLink('#104'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/7`,
        headRefName: 'feature/7',
        status: 'open',
        description: 'Closes #104',
      });

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-triage-sink')).toBe('triage');
      expect(mocks.emit).not.toHaveBeenCalled();
    });
  });

  describe('syncProject — idempotence', () => {
    it('writes nothing and emits nothing on a second pass over unchanged state', async () => {
      await insertTask(fixture.db, { id: 'task-review', linkedIssues: specLink('#100') });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/1`,
        headRefName: 'feature/1',
        status: 'open',
        description: 'Closes #100',
      });

      await service.syncProject(PROJECT_ID);
      expect(mocks.emit).toHaveBeenCalledTimes(1);

      mocks.emit.mockClear();
      await service.syncProject(PROJECT_ID);

      expect(mocks.emit).not.toHaveBeenCalled();
      expect(await stageOf(fixture.db, 'task-review')).toBe('review');
    });
  });

  describe('applyProvisionedStage — task-provisioned hook', () => {
    it('sets implementing for a Spec-linked task with no PR facts yet', async () => {
      await insertTask(fixture.db, { id: 'task-provision-fresh', linkedIssues: specLink('#200') });

      await service.applyProvisionedStage('task-provision-fresh');

      expect(await stageOf(fixture.db, 'task-provision-fresh')).toBe('implementing');
    });

    it('defers to a stronger open PR fact instead of setting implementing', async () => {
      await insertTask(fixture.db, {
        id: 'task-provision-strong',
        linkedIssues: specLink('#201'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/8`,
        headRefName: 'feature/8',
        status: 'open',
        description: 'Closes #201',
      });

      await service.applyProvisionedStage('task-provision-strong');

      expect(await stageOf(fixture.db, 'task-provision-strong')).toBe('review');
    });

    it('leaves triage when the task is re-provisioned (a user/agent gesture)', async () => {
      await insertTask(fixture.db, {
        id: 'task-provision-leaves-triage',
        workflowStage: 'triage',
        linkedIssues: specLink('#202'),
      });

      await service.applyProvisionedStage('task-provision-leaves-triage');

      expect(await stageOf(fixture.db, 'task-provision-leaves-triage')).toBe('implementing');
    });

    it('never auto-moves a link-less task', async () => {
      await insertTask(fixture.db, { id: 'task-provision-linkless', linkedIssues: null });

      await service.applyProvisionedStage('task-provision-linkless');

      expect(await stageOf(fixture.db, 'task-provision-linkless')).toBeNull();
      expect(mocks.emit).not.toHaveBeenCalled();
    });
  });
});
