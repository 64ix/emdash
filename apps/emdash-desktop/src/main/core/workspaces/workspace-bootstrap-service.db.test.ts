import crypto from 'node:crypto';
import { err, ok } from '@emdash/shared';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectManager } from '@main/core/projects/project-manager';
import type { ProjectProvider } from '@main/core/projects/project-provider';
import { projects, tasks, workspaces } from '@main/db/schema';
import type { Task } from '@shared/core/tasks/tasks';
import { WorkspaceBootstrapService } from './workspace-bootstrap-service';
import { computeWorkspaceKey } from './workspace-key';

const mocks = vi.hoisted(() => ({
  acquireWorkspace: vi.fn(),
  releaseWorkspace: vi.fn(),
  buildTaskFromWorkspace: vi.fn(),
  emitTaskProvisionProgress: vi.fn(),
}));

// Prevent the module-level singleton from attempting to open the Electron app DB.
vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }));

vi.mock('@main/core/tasks/task-builder', () => ({
  buildTaskFromWorkspace: mocks.buildTaskFromWorkspace,
  emitTaskProvisionProgress: mocks.emitTaskProvisionProgress,
}));

vi.mock('./workspace-registry', () => ({
  workspaceRegistry: {
    acquire: mocks.acquireWorkspace,
    release: mocks.releaseWorkspace,
  },
}));

const WS_ID = 'ws-1';

const task: Task = {
  id: 'task-1',
  projectId: 'proj-1',
  name: 'Task 1',
  status: 'in_progress',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  statusChangedAt: '2026-01-01T00:00:00.000Z',
  isPinned: false,
  prs: [],
  conversations: {},
  workspaceId: WS_ID,
  type: 'task',
};

describe('WorkspaceBootstrapService', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let svc: WorkspaceBootstrapService;

  beforeEach(async () => {
    vi.clearAllMocks();

    fixture = await openFixture('empty');
    svc = new WorkspaceBootstrapService(fixture.db);

    await fixture.db.insert(projects).values({ id: 'proj-1', name: 'Test Project', path: '/repo' });
    await fixture.db.insert(workspaces).values({ id: WS_ID, type: 'local' });

    mocks.acquireWorkspace.mockResolvedValue({
      git: {
        getWorktreeGitDir: vi.fn().mockResolvedValue('worktrees/task-branch'),
      },
    });
    mocks.releaseWorkspace.mockResolvedValue(undefined);
    mocks.buildTaskFromWorkspace.mockResolvedValue({
      taskProvider: {
        taskId: 'task-1',
        taskBranch: 'task/branch',
        sourceBranch: { type: 'local', branch: 'main' },
        taskEnvVars: {},
        conversations: {},
        terminals: {},
      },
    });
  });

  afterEach(() => {
    fixture.close();
  });

  describe('persistPath', () => {
    it('updates workspace path and key, returns original workspaceId', async () => {
      const returned = await svc.persistPath(WS_ID, '/worktrees/branch', 'local');

      expect(returned).toBe(WS_ID);
      const [ws] = await fixture.db.select().from(workspaces).where(eq(workspaces.id, WS_ID));
      expect(ws.path).toBe('/worktrees/branch');
      expect(ws.key).toBe(computeWorkspaceKey('local', '/worktrees/branch'));
    });

    it('does not set a key for byoi workspaces', async () => {
      await fixture.db.update(workspaces).set({ type: 'byoi' }).where(eq(workspaces.id, WS_ID));

      await svc.persistPath(WS_ID, '/some/path', 'byoi');

      const [ws] = await fixture.db.select().from(workspaces).where(eq(workspaces.id, WS_ID));
      expect(ws.key).toBeNull();
    });

    it('returns existing workspace id on UNIQUE key conflict', async () => {
      const existingWsId = crypto.randomUUID();
      const conflictPath = '/worktrees/taken';
      const conflictKey = computeWorkspaceKey('local', conflictPath);
      await fixture.db
        .insert(workspaces)
        .values({ id: existingWsId, type: 'local', path: conflictPath, key: conflictKey });

      const returned = await svc.persistPath(WS_ID, conflictPath, 'local');

      expect(returned).toBe(existingWsId);
      const [ws] = await fixture.db.select().from(workspaces).where(eq(workspaces.id, WS_ID));
      expect(ws.path).toBeNull();
    });

    it('does not mutate branch metadata when reusing an existing workspace by key', async () => {
      const existingWsId = crypto.randomUUID();
      const conflictPath = '/worktrees/taken';
      const conflictKey = computeWorkspaceKey('local', conflictPath);
      await fixture.db.insert(workspaces).values({
        id: existingWsId,
        type: 'local',
        kind: 'worktree',
        path: conflictPath,
        key: conflictKey,
        branchName: null,
      });

      const returned = await svc.persistPath(
        WS_ID,
        conflictPath,
        'local',
        undefined,
        'task/branch'
      );

      expect(returned).toBe(existingWsId);
      const [existing] = await fixture.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, existingWsId));
      expect(existing.branchName).toBeNull();
    });
  });

  describe('ensureWorkspaceSetupForTask', () => {
    it('returns missing-workspace when a task has no workspace id', async () => {
      await fixture.db.insert(tasks).values({
        id: 'task-missing-workspace-id',
        projectId: 'proj-1',
        name: 'Missing workspace ID',
        status: 'in_progress',
      });

      const result = await svc.ensureWorkspaceSetupForTask('task-missing-workspace-id');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.type).toBe('missing-workspace');
    });

    it('returns missing-workspace when the workspace row is absent', async () => {
      await fixture.db.insert(tasks).values({
        id: 'task-missing-workspace-row',
        projectId: 'proj-1',
        name: 'Missing workspace row',
        status: 'in_progress',
        workspaceId: 'workspace-missing',
      });

      const result = await svc.ensureWorkspaceSetupForTask('task-missing-workspace-row');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.type).toBe('missing-workspace');
    });

    // spec #130 story 25 / ticket #136: a synced task arrives with no local
    // workspace (its machine-local workspace_id is not carried). With the
    // project attached, provisioning mints a local worktree on demand from the
    // task's own branch and re-points the task at it.
    it('mints a local worktree on demand for a synced task with no workspace', async () => {
      const project = {
        projectId: 'proj-1',
        type: 'local',
        repoPath: '/repo',
        defaultWorkspaceType: { kind: 'local' },
        settings: { get: vi.fn() },
        gitRepository: {
          getConfiguredRemotes: vi.fn().mockResolvedValue({
            baseRemote: 'origin',
            pushRemote: 'origin',
          }),
        },
        gitRepositoryFetchService: {},
        runWorkspaceSetup: vi.fn().mockResolvedValue(ok({ path: '/worktrees/imported' })),
        worktreeService: {
          getWorktreePoolPath: vi.fn().mockResolvedValue('/worktrees'),
          existsAtAbsolutePath: vi.fn().mockResolvedValue(false),
          serveBranchWorktree: vi.fn().mockResolvedValue(ok('/worktrees/imported')),
        },
      } as unknown as ProjectProvider;
      const getProject = vi.spyOn(projectManager, 'getProject').mockReturnValue(project);

      await fixture.db.insert(tasks).values({
        id: 'task-imported',
        projectId: 'proj-1',
        name: 'Imported task',
        status: 'in_progress',
        workspaceId: null,
        taskBranch: 'task/imported-branch',
      });

      const result = await svc.ensureWorkspaceSetupForTask('task-imported');

      expect(result.success).toBe(true);

      const [taskRow] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-imported'));
      expect(taskRow.workspaceId).not.toBeNull();

      const [ws] = await fixture.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, taskRow.workspaceId!));
      expect(ws.kind).toBe('worktree');
      expect(ws.location).toBe('local');

      getProject.mockRestore();
    });

    // A modern synced task carries no branch identity on its own row (the
    // branch lives in the machine-local workspaces.config, which never
    // travels). Without a task_branch there is nothing to check out — the task
    // ran against the project root on its origin machine, so re-attach it to
    // this machine's own repository workspace instead of minting a worktree.
    it('re-points a branchless synced task to the project-root workspace', async () => {
      await fixture.db.insert(workspaces).values({
        id: 'ws-root',
        kind: 'project-root',
        location: 'local',
        type: 'local',
        path: '/repo',
      });
      await fixture.db
        .update(projects)
        .set({ repositoryWorkspaceId: 'ws-root' })
        .where(eq(projects.id, 'proj-1'));

      const project = {
        projectId: 'proj-1',
        type: 'local',
        repoPath: '/repo',
        defaultWorkspaceType: { kind: 'local' },
        settings: { get: vi.fn() },
        gitRepository: {
          getConfiguredRemotes: vi.fn(),
        },
        gitRepositoryFetchService: {},
        worktreeService: {
          existsAtAbsolutePath: vi.fn().mockResolvedValue(true),
        },
      } as unknown as ProjectProvider;
      const getProject = vi.spyOn(projectManager, 'getProject').mockReturnValue(project);

      await fixture.db.insert(tasks).values({
        id: 'task-branchless',
        projectId: 'proj-1',
        name: 'Branchless synced task',
        status: 'in_progress',
        workspaceId: null,
        taskBranch: null,
      });

      const result = await svc.ensureWorkspaceSetupForTask('task-branchless');

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.path).toBe('/repo');

      const [taskRow] = await fixture.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, 'task-branchless'));
      expect(taskRow.workspaceId).toBe('ws-root');

      const worktrees = await fixture.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.kind, 'worktree'));
      expect(worktrees).toHaveLength(0);
      expect(mocks.acquireWorkspace).toHaveBeenCalled();

      getProject.mockRestore();
    });
  });

  describe('ensureWorkspaceSetup', () => {
    it('repairs persisted branch worktree paths before acquiring the workspace', async () => {
      const serveBranchWorktree = vi.fn().mockResolvedValue(ok('/worktrees/task-branch'));
      const existsAtAbsolutePath = vi.fn().mockResolvedValue(true);
      const project = {
        projectId: 'proj-1',
        type: 'local',
        repoPath: '/repo',
        defaultWorkspaceType: { kind: 'local' },
        settings: {
          get: vi.fn(),
        },
        gitRepository: {
          getConfiguredRemotes: vi.fn(),
        },
        gitRepositoryFetchService: {},
        worktreeService: {
          existsAtAbsolutePath,
          serveBranchWorktree,
        },
      } as unknown as ProjectProvider;

      const result = await svc.ensureWorkspaceSetup(
        {
          id: WS_ID,
          type: 'local',
          kind: 'worktree',
          path: '/worktrees/broken-task-branch',
          branchName: 'task/branch',
          config: {
            version: '3',
            git: {
              kind: 'create-branch',
              branchName: 'task/branch',
              fromBranch: { type: 'local', branch: 'main' },
            },
            workspace: { kind: 'new-worktree' },
          },
        },
        { workspaceIntent: null, workspaceProvider: null },
        task,
        project
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.path).toBe('/worktrees/task-branch');
      expect(serveBranchWorktree).toHaveBeenCalledWith('task/branch', {
        type: 'local',
        branch: 'main',
      });
      expect(existsAtAbsolutePath).not.toHaveBeenCalledWith('/worktrees/broken-task-branch');
      expect(mocks.acquireWorkspace).toHaveBeenCalled();

      const [ws] = await fixture.db.select().from(workspaces).where(eq(workspaces.id, WS_ID));
      expect(ws.path).toBe('/worktrees/task-branch');
      expect(ws.branchName).toBe('task/branch');
    });

    it('does not acquire an explicit worktree from a stale path without branch intent', async () => {
      const serveBranchWorktree = vi.fn();
      const existsAtAbsolutePath = vi.fn().mockResolvedValue(false);
      const project = {
        projectId: 'proj-1',
        type: 'local',
        repoPath: '/repo',
        defaultWorkspaceType: { kind: 'local' },
        settings: {
          get: vi.fn(),
        },
        gitRepository: {
          getConfiguredRemotes: vi.fn(),
        },
        gitRepositoryFetchService: {},
        worktreeService: {
          existsAtAbsolutePath,
          serveBranchWorktree,
        },
      } as unknown as ProjectProvider;

      const result = await svc.ensureWorkspaceSetup(
        {
          id: WS_ID,
          type: 'local',
          kind: 'worktree',
          path: '/worktrees/missing-task-branch',
          branchName: null,
          config: null,
        },
        { workspaceIntent: null, workspaceProvider: null },
        task,
        project
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error.type).toBe('no-intent');
      expect(existsAtAbsolutePath).not.toHaveBeenCalled();
      expect(serveBranchWorktree).not.toHaveBeenCalled();
      expect(mocks.acquireWorkspace).not.toHaveBeenCalled();
    });

    it('recovers an explicit worktree from legacy task branch intent', async () => {
      const serveBranchWorktree = vi.fn();
      const existsAtAbsolutePath = vi.fn().mockResolvedValue(false);
      const getWorktreePoolPath = vi.fn().mockResolvedValue('/worktrees');
      const runWorkspaceSetup = vi.fn().mockResolvedValue(ok({ path: '/worktrees/task-branch' }));
      const project = {
        projectId: 'proj-1',
        type: 'local',
        repoPath: '/repo',
        defaultWorkspaceType: { kind: 'local' },
        settings: {
          get: vi.fn(),
        },
        gitRepository: {
          getConfiguredRemotes: vi.fn().mockResolvedValue({
            baseRemote: 'origin',
            pushRemote: 'origin',
          }),
        },
        gitRepositoryFetchService: {},
        worktreeService: {
          existsAtAbsolutePath,
          serveBranchWorktree,
          getWorktreePoolPath,
        },
        runWorkspaceSetup,
      } as unknown as ProjectProvider;

      const result = await svc.ensureWorkspaceSetup(
        {
          id: WS_ID,
          type: 'local',
          kind: 'worktree',
          path: '/worktrees/missing-task-branch',
          branchName: null,
          config: null,
        },
        {
          workspaceIntent: null,
          workspaceProvider: null,
          taskBranch: 'task/branch',
        },
        task,
        project
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.path).toBe('/worktrees/task-branch');
      expect(existsAtAbsolutePath).not.toHaveBeenCalled();
      expect(serveBranchWorktree).not.toHaveBeenCalled();
      expect(runWorkspaceSetup).toHaveBeenCalledWith(
        expect.arrayContaining([{ kind: 'add-worktree', args: { branchName: 'task/branch' } }]),
        '/worktrees'
      );
      expect(mocks.acquireWorkspace).toHaveBeenCalled();

      const [ws] = await fixture.db.select().from(workspaces).where(eq(workspaces.id, WS_ID));
      expect(ws.path).toBe('/worktrees/task-branch');
      expect(ws.branchName).toBe('task/branch');
    });

    it('recovers a legacy workspace with stale path from task branch intent', async () => {
      const serveBranchWorktree = vi.fn();
      const existsAtAbsolutePath = vi.fn().mockResolvedValue(false);
      const getWorktreePoolPath = vi.fn().mockResolvedValue('/worktrees');
      const runWorkspaceSetup = vi.fn().mockResolvedValue(ok({ path: '/worktrees/task-branch' }));
      const project = {
        projectId: 'proj-1',
        type: 'local',
        repoPath: '/repo',
        defaultWorkspaceType: { kind: 'local' },
        settings: {
          get: vi.fn(),
        },
        gitRepository: {
          getConfiguredRemotes: vi.fn().mockResolvedValue({
            baseRemote: 'origin',
            pushRemote: 'origin',
          }),
        },
        gitRepositoryFetchService: {},
        worktreeService: {
          existsAtAbsolutePath,
          serveBranchWorktree,
          getWorktreePoolPath,
        },
        runWorkspaceSetup,
      } as unknown as ProjectProvider;

      const result = await svc.ensureWorkspaceSetup(
        {
          id: WS_ID,
          type: 'local',
          kind: null,
          path: '/worktrees/missing-task-branch',
          branchName: null,
          config: null,
        },
        {
          workspaceIntent: null,
          workspaceProvider: null,
          taskBranch: 'task/branch',
        },
        task,
        project
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.path).toBe('/worktrees/task-branch');
      expect(existsAtAbsolutePath).toHaveBeenCalledWith('/worktrees/missing-task-branch');
      expect(serveBranchWorktree).not.toHaveBeenCalled();
      expect(runWorkspaceSetup).toHaveBeenCalledWith(
        expect.arrayContaining([{ kind: 'add-worktree', args: { branchName: 'task/branch' } }]),
        '/worktrees'
      );
      expect(mocks.acquireWorkspace).toHaveBeenCalled();

      const [ws] = await fixture.db.select().from(workspaces).where(eq(workspaces.id, WS_ID));
      expect(ws.path).toBe('/worktrees/task-branch');
      expect(ws.branchName).toBe('task/branch');
    });

    // A persisted worktree whose branch vanished (cleaned worktree + deleted
    // branch + remote branch gone) must not fail outright: the workspace still
    // carries its full config, so the intent path can rebuild the checkout —
    // for a pr-branch config by re-fetching refs/pull/<n>/head.
    it('recovers a persisted worktree via the pr-branch intent when the branch is gone', async () => {
      const serveBranchWorktree = vi
        .fn()
        .mockResolvedValue(err({ type: 'branch-not-found', branch: 'task/branch' }));
      const existsAtAbsolutePath = vi.fn().mockResolvedValue(true);
      const getWorktreePoolPath = vi.fn().mockResolvedValue('/worktrees');
      const runWorkspaceSetup = vi.fn().mockResolvedValue(ok({ path: '/worktrees/task-branch' }));
      const project = {
        projectId: 'proj-1',
        type: 'local',
        repoPath: '/repo',
        defaultWorkspaceType: { kind: 'local' },
        settings: {
          get: vi.fn(),
        },
        gitRepository: {
          getConfiguredRemotes: vi.fn().mockResolvedValue({
            baseRemote: 'origin',
            pushRemote: 'origin',
          }),
        },
        gitRepositoryFetchService: {},
        worktreeService: {
          existsAtAbsolutePath,
          serveBranchWorktree,
          getWorktreePoolPath,
        },
        runWorkspaceSetup,
      } as unknown as ProjectProvider;

      const result = await svc.ensureWorkspaceSetup(
        {
          id: WS_ID,
          type: 'local',
          kind: 'worktree',
          path: '/worktrees/task-branch',
          branchName: 'task/branch',
          config: {
            version: '3',
            git: {
              kind: 'pr-branch',
              prNumber: 153,
              headBranch: 'pr/153-head',
              headRepositoryUrl: 'https://github.com/64ix/emdash',
              isFork: false,
              taskBranch: 'task/branch',
            },
            workspace: { kind: 'new-worktree' },
          },
        },
        { workspaceIntent: null, workspaceProvider: null },
        task,
        project
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.path).toBe('/worktrees/task-branch');
      expect(serveBranchWorktree).toHaveBeenCalledWith('task/branch', undefined);
      expect(runWorkspaceSetup).toHaveBeenCalledWith(
        expect.arrayContaining([
          {
            kind: 'git-fetch',
            args: {
              remote: 'origin',
              refspec: 'refs/pull/153/head:refs/heads/pr/153-head',
              force: true,
            },
          },
          { kind: 'add-worktree', args: { branchName: 'task/branch' } },
        ]),
        '/worktrees'
      );
      expect(mocks.acquireWorkspace).toHaveBeenCalled();

      const [ws] = await fixture.db.select().from(workspaces).where(eq(workspaces.id, WS_ID));
      expect(ws.path).toBe('/worktrees/task-branch');
      expect(ws.branchName).toBe('task/branch');
    });

    it('surfaces branch-not-found when the intent path cannot recover the branch either', async () => {
      const serveBranchWorktree = vi
        .fn()
        .mockResolvedValue(err({ type: 'branch-not-found', branch: 'task/branch' }));
      const existsAtAbsolutePath = vi.fn().mockResolvedValue(true);
      const getWorktreePoolPath = vi.fn().mockResolvedValue('/worktrees');
      const runWorkspaceSetup = vi.fn().mockResolvedValue(
        err({
          kind: 'add-worktree',
          type: 'worktree-failed',
          branchName: 'task/branch',
          message: 'Branch "task/branch" was not found locally or on remote',
        })
      );
      const project = {
        projectId: 'proj-1',
        type: 'local',
        repoPath: '/repo',
        defaultWorkspaceType: { kind: 'local' },
        settings: {
          get: vi.fn(),
        },
        gitRepository: {
          getConfiguredRemotes: vi.fn().mockResolvedValue({
            baseRemote: 'origin',
            pushRemote: 'origin',
          }),
        },
        gitRepositoryFetchService: {},
        worktreeService: {
          existsAtAbsolutePath,
          serveBranchWorktree,
          getWorktreePoolPath,
        },
        runWorkspaceSetup,
      } as unknown as ProjectProvider;

      const result = await svc.ensureWorkspaceSetup(
        {
          id: WS_ID,
          type: 'local',
          kind: 'worktree',
          path: '/worktrees/task-branch',
          branchName: 'task/branch',
          config: {
            version: '3',
            git: { kind: 'use-branch', branchName: 'task/branch' },
            workspace: { kind: 'new-worktree' },
          },
        },
        { workspaceIntent: null, workspaceProvider: null },
        task,
        project
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error.type).toBe('setup-failed');
      if (result.error.type === 'setup-failed') {
        expect(result.error.stepKind).toBe('add-worktree');
        expect(result.error.stepErrorType).toBe('worktree-failed');
      }
      expect(mocks.acquireWorkspace).not.toHaveBeenCalled();
    });
  });
});
