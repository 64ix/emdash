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
    assignedPrUrl?: string | null;
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
    assignedPrUrl: overrides.assignedPrUrl ?? null,
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

  describe('syncProject — Assigned PR override (ticket #101)', () => {
    it('puts the task in review for an assigned open PR, even against a merged Spec fact', async () => {
      // The Spec-referencing PR already merged, but the user's explicit
      // assignment (a fork-flow PR that neither references the Spec nor matches
      // the branch) is the holding fact and proves `review`.
      await insertTask(fixture.db, { id: 'task-assigned-open', linkedIssues: specLink('#110') });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/21`,
        headRefName: 'spec/110',
        status: 'merged',
        description: 'Closes #110',
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/22`,
        headRefName: 'fork-flow/assigned',
        status: 'open',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/22` })
        .where(eq(tasks.id, 'task-assigned-open'));

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-assigned-open')).toBe('review');
    });

    it('puts the task in shipped for an assigned merged PR', async () => {
      await insertTask(fixture.db, { id: 'task-assigned-merged', linkedIssues: specLink('#111') });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/23`,
        headRefName: 'fork-flow/assigned',
        status: 'merged',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/23` })
        .where(eq(tasks.id, 'task-assigned-merged'));

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-assigned-merged')).toBe('shipped');
    });

    it('puts the task in triage for an assigned closed-without-merge PR', async () => {
      await insertTask(fixture.db, { id: 'task-assigned-closed', linkedIssues: specLink('#112') });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/24`,
        headRefName: 'fork-flow/assigned',
        status: 'closed',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/24` })
        .where(eq(tasks.id, 'task-assigned-closed'));

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-assigned-closed')).toBe('triage');
    });

    it('derives a stage for a link-less task once a PR is assigned to it', async () => {
      await insertTask(fixture.db, { id: 'task-assigned-linkless', linkedIssues: null });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/25`,
        headRefName: 'fork-flow/assigned',
        status: 'open',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/25` })
        .where(eq(tasks.id, 'task-assigned-linkless'));

      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-assigned-linkless')).toBe('review');
    });

    it('reverts to the Spec-derived stage when the assigned PR is unassigned', async () => {
      // Assigned merged PR proves `shipped`; unassigning must restore the
      // Spec-referencing open PR's `review` — not keep the assignment's fact.
      await insertTask(fixture.db, { id: 'task-assign-revert', linkedIssues: specLink('#113') });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/26`,
        headRefName: 'spec/113',
        status: 'open',
        description: 'Closes #113',
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/27`,
        headRefName: 'fork-flow/assigned',
        status: 'merged',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/27` })
        .where(eq(tasks.id, 'task-assign-revert'));

      await service.syncProject(PROJECT_ID);
      expect(await stageOf(fixture.db, 'task-assign-revert')).toBe('shipped');

      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: null })
        .where(eq(tasks.id, 'task-assign-revert'));
      await service.syncProject(PROJECT_ID);

      expect(await stageOf(fixture.db, 'task-assign-revert')).toBe('review');
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

    it('never downgrades a review/shipped task when no PR fact currently matches', async () => {
      // e.g. re-provisioning a shipped task right after app start, before the
      // repository's PR rows have been synced — review/shipped are
      // GitHub-proven stages a transiently absent PR fact must not undo.
      await insertTask(fixture.db, {
        id: 'task-provision-shipped',
        workflowStage: 'shipped',
        linkedIssues: specLink('#203'),
      });
      await insertTask(fixture.db, {
        id: 'task-provision-review',
        workflowStage: 'review',
        linkedIssues: specLink('#204'),
      });

      await service.applyProvisionedStage('task-provision-shipped');
      await service.applyProvisionedStage('task-provision-review');

      expect(await stageOf(fixture.db, 'task-provision-shipped')).toBe('shipped');
      expect(await stageOf(fixture.db, 'task-provision-review')).toBe('review');
    });

    it('never auto-moves a link-less task', async () => {
      await insertTask(fixture.db, { id: 'task-provision-linkless', linkedIssues: null });

      await service.applyProvisionedStage('task-provision-linkless');

      expect(await stageOf(fixture.db, 'task-provision-linkless')).toBeNull();
      expect(mocks.emit).not.toHaveBeenCalled();
    });
  });

  describe('applyProvisionedStage — Assigned PR override (ticket #101)', () => {
    it('sets review for an assigned open PR instead of implementing', async () => {
      await insertTask(fixture.db, {
        id: 'task-provision-assigned-open',
        linkedIssues: specLink('#210'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/30`,
        headRefName: 'fork-flow/assigned',
        status: 'open',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/30` })
        .where(eq(tasks.id, 'task-provision-assigned-open'));

      await service.applyProvisionedStage('task-provision-assigned-open');

      expect(await stageOf(fixture.db, 'task-provision-assigned-open')).toBe('review');
    });

    it('sets shipped for an assigned merged PR', async () => {
      await insertTask(fixture.db, {
        id: 'task-provision-assigned-merged',
        linkedIssues: specLink('#211'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/31`,
        headRefName: 'fork-flow/assigned',
        status: 'merged',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/31` })
        .where(eq(tasks.id, 'task-provision-assigned-merged'));

      await service.applyProvisionedStage('task-provision-assigned-merged');

      expect(await stageOf(fixture.db, 'task-provision-assigned-merged')).toBe('shipped');
    });

    it('stages a link-less task with an assigned PR on provisioning', async () => {
      await insertTask(fixture.db, {
        id: 'task-provision-assigned-linkless',
        linkedIssues: null,
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/32`,
        headRefName: 'fork-flow/assigned',
        status: 'open',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/32` })
        .where(eq(tasks.id, 'task-provision-assigned-linkless'));

      await service.applyProvisionedStage('task-provision-assigned-linkless');

      expect(await stageOf(fixture.db, 'task-provision-assigned-linkless')).toBe('review');
    });
  });

  describe('getStageAuthority — Task Detail Panel read-only fact (ticket #41)', () => {
    it('is declarative with no holding PR for a link-less task', async () => {
      await insertTask(fixture.db, { id: 'task-linkless', linkedIssues: null });

      expect(await service.getStageAuthority('task-linkless')).toEqual({
        holdingPr: null,
        isCurrentStageGithubProven: false,
      });
    });

    it('is declarative with no holding PR when no PR references the Spec', async () => {
      await insertTask(fixture.db, { id: 'task-no-pr', linkedIssues: specLink('#300') });

      expect(await service.getStageAuthority('task-no-pr')).toEqual({
        holdingPr: null,
        isCurrentStageGithubProven: false,
      });
    });

    it('is github-proven, pointing at the open PR, when it references the Spec', async () => {
      await insertTask(fixture.db, {
        id: 'task-open-pr',
        workflowStage: 'implementing',
        linkedIssues: specLink('#301'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/10`,
        headRefName: 'feature/10',
        status: 'open',
        description: 'Closes #301',
      });

      expect(await service.getStageAuthority('task-open-pr')).toEqual({
        holdingPr: {
          url: `${REPOSITORY_URL}/pull/10`,
          title: 'PR',
          identifier: '#1',
          status: 'open',
          isDraft: false,
        },
        isCurrentStageGithubProven: true,
      });
    });

    it('is github-proven, pointing at the merged PR, once the Spec-referencing PR ships', async () => {
      await insertTask(fixture.db, {
        id: 'task-merged-pr',
        workflowStage: 'review',
        linkedIssues: specLink('#302'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/11`,
        headRefName: 'feature/11',
        status: 'merged',
        description: 'Closes #302',
      });

      const authority = await service.getStageAuthority('task-merged-pr');
      expect(authority.holdingPr?.status).toBe('merged');
      expect(authority.isCurrentStageGithubProven).toBe(true);
    });

    it('is never github-proven while the task currently sits in triage', async () => {
      await insertTask(fixture.db, {
        id: 'task-triage-authority',
        workflowStage: 'triage',
        linkedIssues: specLink('#303'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/12`,
        headRefName: 'feature/12',
        status: 'closed',
        description: 'Closes #303',
      });

      const authority = await service.getStageAuthority('task-triage-authority');
      expect(authority.holdingPr?.status).toBe('closed');
      expect(authority.isCurrentStageGithubProven).toBe(false);
    });

    it('is declarative with no holding PR for a task that does not exist', async () => {
      expect(await service.getStageAuthority('does-not-exist')).toEqual({
        holdingPr: null,
        isCurrentStageGithubProven: false,
      });
    });
  });

  describe('getStageAuthority — Assigned PR override (ticket #101)', () => {
    it('is github-proven, pointing at the assigned open PR — even link-less', async () => {
      await insertTask(fixture.db, { id: 'task-authority-assigned-open', linkedIssues: null });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/40`,
        headRefName: 'fork-flow/assigned',
        status: 'open',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/40` })
        .where(eq(tasks.id, 'task-authority-assigned-open'));

      expect(await service.getStageAuthority('task-authority-assigned-open')).toEqual({
        holdingPr: {
          url: `${REPOSITORY_URL}/pull/40`,
          title: 'PR',
          identifier: '#1',
          status: 'open',
          isDraft: false,
        },
        isCurrentStageGithubProven: true,
      });
    });

    it('points at the assigned merged PR, winning over the Spec-referencing open PR', async () => {
      await insertTask(fixture.db, {
        id: 'task-authority-assigned-merged',
        workflowStage: 'implementing',
        linkedIssues: specLink('#310'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/41`,
        headRefName: 'spec/310',
        status: 'open',
        description: 'Closes #310',
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/42`,
        headRefName: 'fork-flow/assigned',
        status: 'merged',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/42` })
        .where(eq(tasks.id, 'task-authority-assigned-merged'));

      const authority = await service.getStageAuthority('task-authority-assigned-merged');
      expect(authority.holdingPr?.url).toBe(`${REPOSITORY_URL}/pull/42`);
      expect(authority.holdingPr?.status).toBe('merged');
      expect(authority.isCurrentStageGithubProven).toBe(true);
    });

    it('is never github-proven for an assigned closed PR while the task sits in triage', async () => {
      await insertTask(fixture.db, {
        id: 'task-authority-assigned-closed',
        workflowStage: 'triage',
        linkedIssues: specLink('#311'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/43`,
        headRefName: 'fork-flow/assigned',
        status: 'closed',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/43` })
        .where(eq(tasks.id, 'task-authority-assigned-closed'));

      const authority = await service.getStageAuthority('task-authority-assigned-closed');
      expect(authority.holdingPr?.url).toBe(`${REPOSITORY_URL}/pull/43`);
      expect(authority.holdingPr?.status).toBe('closed');
      expect(authority.isCurrentStageGithubProven).toBe(false);
    });

    it('reverts to the Spec-derived holding fact when the assigned PR is unassigned', async () => {
      await insertTask(fixture.db, {
        id: 'task-authority-assign-revert',
        workflowStage: 'triage',
        linkedIssues: specLink('#312'),
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/44`,
        headRefName: 'spec/312',
        status: 'open',
        description: 'Closes #312',
      });
      await insertPr(fixture.db, {
        url: `${REPOSITORY_URL}/pull/45`,
        headRefName: 'fork-flow/assigned',
        status: 'closed',
        description: null,
      });
      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: `${REPOSITORY_URL}/pull/45` })
        .where(eq(tasks.id, 'task-authority-assign-revert'));

      const assigned = await service.getStageAuthority('task-authority-assign-revert');
      expect(assigned.holdingPr?.url).toBe(`${REPOSITORY_URL}/pull/45`);

      await fixture.db
        .update(tasks)
        .set({ assignedPrUrl: null })
        .where(eq(tasks.id, 'task-authority-assign-revert'));

      const reverted = await service.getStageAuthority('task-authority-assign-revert');
      expect(reverted.holdingPr?.url).toBe(`${REPOSITORY_URL}/pull/44`);
      expect(reverted.holdingPr?.status).toBe('open');
      expect(reverted.isCurrentStageGithubProven).toBe(false); // task still in triage
    });
  });
});
