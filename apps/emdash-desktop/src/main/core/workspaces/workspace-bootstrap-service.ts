import crypto from 'node:crypto';
import type { GitBranchRef } from '@emdash/core/git';
import { err, ok, type Result } from '@emdash/shared';
import { eq, sql } from 'drizzle-orm';
import { projectManager } from '@main/core/projects/project-manager';
import type { ProjectProvider, TaskProvider } from '@main/core/projects/project-provider';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import {
  formatProvisionTaskError,
  mapWorktreeErrorToProvisionError,
} from '@main/core/tasks/provision-task-error';
import { buildTaskFromWorkspace, emitTaskProvisionProgress } from '@main/core/tasks/task-builder';
import { mapTaskRowToTask } from '@main/core/tasks/utils/utils';
import { db as appDb, type AppDb } from '@main/db/client';
import { projects, tasks, workspaces } from '@main/db/schema';
import type { Task, ProvisionWorkspaceError } from '@shared/core/tasks/tasks';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';
import type { WorkspaceProviderData } from '@shared/core/workspaces/workspace-provider-data';
import { compileSetupSpec } from '@shared/core/workspaces/workspace-setup-spec';
import type { WorkspaceType } from '@shared/core/workspaces/workspaces';
import { deriveBranchName, resolveWorkspaceIntent } from '../tasks/resolve-workspace-intent';
import { provisionBYOITask } from './byoi/provision-byoi-task';
import { getProvisionedWorkspaceBranch } from './workspace-branch';
import { createWorkspaceFactory } from './workspace-factory';
import { computeWorkspaceKey } from './workspace-key';
import { workspaceRegistry } from './workspace-registry';

export type WorkspaceBootstrapResult = {
  path: string;
  workspaceId: string;
  sshConnectionId?: string;
  worktreeGitDir?: string;
  taskProvider: TaskProvider;
  /** BYOI only — workspace provider data to persist in the DB. */
  workspaceProviderData?: WorkspaceProviderData;
};

export class WorkspaceBootstrapService {
  constructor(private readonly db: AppDb) {}

  /**
   * Ensures the workspace for a task is fully set up on disk, acquires the
   * workspace (running lifecycle scripts), and builds task providers.
   *
   * - **Fast path (idempotent)**: if a non-worktree `workspaceRow.path` is set and
   *   the directory exists on disk, skips git setup and goes straight to workspace
   *   acquisition. Persisted worktree paths are resolved through `WorktreeService`
   *   so stale partial directories are repaired before acquisition.
   * - **BYOI workspaces**: delegates to `provisionBYOITask` which runs the
   *   provision script, connects SSH, and acquires the workspace.
   * - **Local/SSH workspaces**: compiles and executes the `WorkspaceSetupSpec`,
   *   applies recovery on failure, persists the resolved path, then acquires.
   * - **SSH channel recovery**: calls `reportChannelRecovered` after a successful
   *   setup on an SSH project.
   */
  async ensureWorkspaceSetup(
    workspaceRow: {
      id: string;
      type: WorkspaceType;
      kind?: string | null;
      path: string | null;
      config?: WorkspaceConfig | null;
      branchName?: string | null;
      workspaceProvider?: string | null;
      data?: WorkspaceProviderData | null;
    },
    taskRow: {
      workspaceIntent: string | null;
      workspaceProvider: string | null;
      taskBranch?: string | null;
    },
    task: Task,
    project: ProjectProvider
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const wsKind = workspaceRow.kind;
    const isByoi = wsKind === 'byoi' || workspaceRow.type === 'byoi';

    // Derive branch info from workspace config for passing to task providers.
    const wsConfig = workspaceRow.config;
    const workspaceBranchName = getProvisionedWorkspaceBranch(workspaceRow) ?? undefined;
    const isWorktreeWorkspace = wsKind === 'worktree' || (!wsKind && !!workspaceBranchName);
    const workspaceSourceBranch: GitBranchRef | undefined =
      wsConfig?.git.kind === 'create-branch' ? wsConfig.git.fromBranch : undefined;
    const connectionId =
      project.defaultWorkspaceType.kind === 'ssh'
        ? project.defaultWorkspaceType.connectionId
        : undefined;

    // project-root fast-path: use the project repo path directly.
    // Path is set by ensureRepositoryWorkspace at mount time.
    if (wsKind === 'project-root') {
      const resolvedPath = workspaceRow.path ?? project.repoPath;
      return this._acquireAndBuild(
        workspaceRow.id,
        task,
        project,
        resolvedPath,
        workspaceBranchName,
        workspaceSourceBranch
      );
    }

    // Persisted worktree path: resolve through WorktreeService instead of trusting
    // path existence. Archive/delete can leave a partial directory behind; the
    // worktree service knows how to remove stale targets and recreate the checkout.
    if (workspaceRow.path && workspaceBranchName && isWorktreeWorkspace && !isByoi) {
      const serveResult = await project.worktreeService.serveBranchWorktree(
        workspaceBranchName,
        workspaceSourceBranch
      );
      if (serveResult.success) {
        const resolvedPath = serveResult.data;

        await this.persistPath(
          workspaceRow.id,
          resolvedPath,
          workspaceRow.type,
          connectionId,
          workspaceBranchName
        );

        if (connectionId) {
          sshConnectionManager.reportChannelRecovered(connectionId);
        }

        return this._acquireAndBuild(
          workspaceRow.id,
          task,
          project,
          resolvedPath,
          workspaceBranchName,
          workspaceSourceBranch
        );
      }

      // The branch no longer exists locally or on the checked remotes. When the
      // workspace still carries its config, fall through to the intent-based
      // setup below instead of failing: `create-branch` recreates the branch
      // from its source ref, `pr-branch` re-fetches refs/pull/<n>/head (which
      // survives the head branch being deleted). A config-less row can only
      // mean `use-branch` — the intent path would retry the same checkout and
      // fail identically, so surface the error directly.
      if (serveResult.error.type !== 'branch-not-found' || !wsConfig) {
        const provisionError = mapWorktreeErrorToProvisionError(
          workspaceBranchName,
          serveResult.error
        );
        return err({
          type: 'setup-failed',
          stepKind: 'worktree',
          stepErrorType: provisionError.type,
          message: formatProvisionTaskError(provisionError),
        });
      }
    }

    // Fast path: non-worktree path already persisted and still exists on disk.
    if (workspaceRow.path && !isByoi && !isWorktreeWorkspace) {
      const exists = await project.worktreeService.existsAtAbsolutePath(workspaceRow.path);
      if (exists) {
        return this._acquireAndBuild(
          workspaceRow.id,
          task,
          project,
          workspaceRow.path,
          workspaceBranchName,
          workspaceSourceBranch
        );
      }
    }

    // BYOI workspaces are managed by provisionBYOITask.
    if (isByoi) {
      return this._provisionBYOI(workspaceRow, task, project);
    }

    const intent = resolveWorkspaceIntent(taskRow, workspaceRow);
    if (!intent) {
      return err({ type: 'no-intent' });
    }

    const { baseRemote, pushRemote } = await project.gitRepository.getConfiguredRemotes();
    const spec = compileSetupSpec(intent.git, intent.workspace, { baseRemote, pushRemote });

    const intentBranchName = deriveBranchName(intent.git) ?? undefined;
    const intentSourceBranch: GitBranchRef | undefined =
      intent.git.kind === 'create-branch' ? intent.git.fromBranch : undefined;

    if (spec.length === 0) {
      // No git operations needed — use existing project root or provided path.
      const resolvedPath =
        'path' in intent.workspace && intent.workspace.path
          ? intent.workspace.path
          : project.repoPath;
      await this.persistPath(
        workspaceRow.id,
        resolvedPath,
        workspaceRow.type,
        connectionId,
        intentBranchName
      );
      return this._acquireAndBuild(
        workspaceRow.id,
        task,
        project,
        resolvedPath,
        intentBranchName,
        intentSourceBranch
      );
    }

    const worktreePoolPath = await project.worktreeService.getWorktreePoolPath();
    const setupResult = await project.runWorkspaceSetup(spec, worktreePoolPath);

    if (!setupResult.success) {
      const { kind, type } = setupResult.error;
      const message = 'message' in setupResult.error ? setupResult.error.message : undefined;
      return err({ type: 'setup-failed', stepKind: kind, stepErrorType: type, message });
    }

    const resolvedPath = setupResult.data.path;
    if (resolvedPath) {
      await this.persistPath(
        workspaceRow.id,
        resolvedPath,
        workspaceRow.type,
        connectionId,
        intentBranchName
      );
    }

    if (connectionId) {
      sshConnectionManager.reportChannelRecovered(connectionId);
    }

    return this._acquireAndBuild(
      workspaceRow.id,
      task,
      project,
      resolvedPath ?? '',
      intentBranchName,
      intentSourceBranch
    );
  }

  /**
   * Public entry point for the RPC controller.
   * Loads the workspace + task rows from DB, resolves the project,
   * and delegates to `ensureWorkspaceSetup`.
   */
  async ensureWorkspaceSetupForTask(
    taskId: string
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!row) return err({ type: 'missing-workspace' });

    let wsRow = row.workspaceId
      ? (
          await this.db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).limit(1)
        )[0]
      : undefined;

    const project = projectManager.getProject(row.projectId);

    // A synced task arrives with no local workspace: its `workspace_id` is a
    // machine-local reference that never travels (see allowlist.ts), so the
    // row imports with a NULL (or, defensively, dangling) workspace id and no
    // matching `workspaces` row on this machine. Mint one on demand from the
    // (attached) project so the task is provisionable here (spec #130 story 25
    // / ticket #136). Requires the project to be attached/mounted; until then
    // there is nothing to provision against — report missing-workspace so the
    // caller surfaces "attach the project first".
    if (!wsRow) {
      if (!project) return err({ type: 'missing-workspace' });
      // Branch-based synced tasks mint a worktree from their own branch; a
      // task with no branch identity (repository-instance / project-root
      // tasks) ran against the project root on its origin machine, so
      // re-attach it to this machine's own repository workspace.
      const minted = row.taskBranch
        ? await this.mintWorktreeWorkspaceForTask(row.projectId)
        : await this.mintProjectRootWorkspaceForTask(project, row.projectId);
      await this.db.update(tasks).set({ workspaceId: minted.id }).where(eq(tasks.id, taskId));
      row.workspaceId = minted.id;
      wsRow = minted;
    }

    if (!project) throw new Error(`Project ${row.projectId} not found`);

    const task = mapTaskRowToTask(row);
    return this.ensureWorkspaceSetup(wsRow, row, task, project);
  }

  /**
   * Creates a fresh local/SSH worktree `workspaces` row for a synced task that
   * has no workspace on this machine. Location and SSH connection are derived
   * from the project (mirroring `createTask`'s new-worktree branch); `config`
   * is left NULL so `resolveWorkspaceIntent` falls back to the task's own
   * branch (`use-branch`) — the branch was pushed from the origin machine, so
   * the worktree checks it out here.
   */
  private async mintWorktreeWorkspaceForTask(
    projectId: string
  ): Promise<typeof workspaces.$inferSelect> {
    const projectRow = await this.loadProjectWorkspaceFields(projectId);

    const isRemote = projectRow?.workspaceProvider === 'ssh';
    const [minted] = await this.db
      .insert(workspaces)
      .values({
        id: crypto.randomUUID(),
        kind: 'worktree',
        location: isRemote ? 'remote' : 'local',
        sshConnectionId: isRemote ? (projectRow?.sshConnectionId ?? null) : null,
        type: isRemote ? 'project-ssh' : 'local',
        config: null,
      })
      .returning();
    return minted;
  }

  /**
   * Re-attaches a branchless synced task (repository-instance / project-root
   * origin) to this machine's project-root workspace, creating it if needed
   * and linking `projects.repositoryWorkspaceId` exactly like
   * `ensureRepositoryWorkspace` does at attach time.
   */
  private async mintProjectRootWorkspaceForTask(
    project: ProjectProvider,
    projectId: string
  ): Promise<typeof workspaces.$inferSelect> {
    const projectRow = await this.loadProjectWorkspaceFields(projectId);

    if (projectRow?.repositoryWorkspaceId) {
      const [existing] = await this.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, projectRow.repositoryWorkspaceId))
        .limit(1);
      if (existing) return existing;
    }

    const isRemote = projectRow?.workspaceProvider === 'ssh';
    const type = isRemote ? 'project-ssh' : 'local';
    const sshConnectionId = isRemote ? (projectRow?.sshConnectionId ?? null) : null;
    const key = computeWorkspaceKey(type, project.repoPath, sshConnectionId ?? undefined);

    const [byKey] = await this.db.select().from(workspaces).where(eq(workspaces.key, key)).limit(1);
    const resolvedId = byKey?.id ?? crypto.randomUUID();

    if (!byKey) {
      await this.db.insert(workspaces).values({
        id: resolvedId,
        kind: 'project-root',
        location: isRemote ? 'remote' : 'local',
        sshConnectionId,
        type,
        path: project.repoPath,
        key,
      });
    }

    await this.db
      .update(projects)
      .set({ repositoryWorkspaceId: resolvedId })
      .where(eq(projects.id, projectId));

    const [resolved] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, resolvedId))
      .limit(1);
    return resolved;
  }

  private async loadProjectWorkspaceFields(
    projectId: string
  ): Promise<
    | {
        workspaceProvider: string | null;
        sshConnectionId: string | null;
        repositoryWorkspaceId: string | null;
      }
    | undefined
  > {
    const [projectRow] = await this.db
      .select({
        workspaceProvider: projects.workspaceProvider,
        sshConnectionId: projects.sshConnectionId,
        repositoryWorkspaceId: projects.repositoryWorkspaceId,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return projectRow;
  }

  /**
   * Persists a resolved path (and its derived key) onto a workspace row.
   *
   * If another workspace already owns that path (same key), its ID is returned
   * so the caller can re-point any tasks. Returns the original workspaceId when
   * the update succeeds normally.
   *
   * @internal Exposed for unit testing; prefer `ensureWorkspaceSetup` in application code.
   */
  async persistPath(
    workspaceId: string,
    path: string,
    type: WorkspaceType,
    connectionId?: string,
    branchName?: string
  ): Promise<string> {
    const key = type !== 'byoi' ? computeWorkspaceKey(type, path, connectionId) : null;

    if (key) {
      const [existing] = await this.db.select().from(workspaces).where(eq(workspaces.key, key));
      if (existing && existing.id !== workspaceId) {
        return existing.id;
      }
    }

    await this.db
      .update(workspaces)
      .set({ path, key, branchName: branchName ?? null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(workspaces.id, workspaceId));
    return workspaceId;
  }

  /**
   * Acquires the workspace via the registry (runs lifecycle scripts on first
   * acquire) then builds task providers. Returns a `WorkspaceBootstrapResult`.
   */
  private async _acquireAndBuild(
    workspaceId: string,
    task: Task,
    project: ProjectProvider,
    workDir: string,
    workspaceBranchName?: string,
    workspaceSourceBranch?: GitBranchRef
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const type = project.defaultWorkspaceType;

    emitTaskProvisionProgress({
      taskId: task.id,
      projectId: project.projectId,
      step: 'initialising-workspace',
      message: 'Initialising workspace…',
    });

    let acquired;
    try {
      acquired = await workspaceRegistry.acquire(
        workspaceId,
        project.projectId,
        createWorkspaceFactory(workspaceId, type, {
          task,
          workDir,
          projectId: project.projectId,
          projectPath: project.repoPath,
          workspaceRuntime: {
            machine: project.defaultWorkspaceMachine,
            manager: runtimeManager,
          },
          settings: project.settings,
          logPrefix: 'WorkspaceBootstrapService',
          gitRepository: project.gitRepository,
          gitRepositoryFetchService: project.gitRepositoryFetchService,
        })
      );
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'workspace-acquire',
        stepErrorType: 'error',
        message: String(e),
      });
    }

    emitTaskProvisionProgress({
      taskId: task.id,
      projectId: project.projectId,
      step: 'starting-sessions',
      message: 'Preparing task…',
    });

    let buildSucceeded = false;
    try {
      const buildResult = await buildTaskFromWorkspace(
        task,
        acquired.workspace,
        type,
        project.projectId,
        project.repoPath,
        project.settings,
        workspaceBranchName,
        workspaceSourceBranch,
        acquired.sshFilesRuntime
      );
      buildSucceeded = true;
      return ok({
        path: workDir,
        workspaceId,
        sshConnectionId: type.kind === 'ssh' ? type.connectionId : undefined,
        worktreeGitDir: undefined,
        taskProvider: buildResult.taskProvider,
      });
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'build-providers',
        stepErrorType: 'error',
        message: String(e),
      });
    } finally {
      if (!buildSucceeded) {
        await workspaceRegistry.teardown(workspaceId, 'terminate').catch(() => {});
      }
    }
  }

  /**
   * Provisions a BYOI workspace by delegating to `provisionBYOITask`.
   */
  private async _provisionBYOI(
    workspaceRow: {
      id: string;
      workspaceProvider?: string | null;
      data?: WorkspaceProviderData | null;
    },
    task: Task,
    project: ProjectProvider
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const projectSettings = await project.settings.get();
    if (projectSettings.workspaceProvider?.type !== 'script') {
      return err({
        type: 'setup-failed',
        stepKind: 'byoi-config',
        stepErrorType: 'missing-provider',
        message: 'Task has workspaceProvider=byoi but project has no script provider configured',
      });
    }

    try {
      const result = await provisionBYOITask({
        task,
        wpConfig: projectSettings.workspaceProvider,
        ctx: project.ctx,
        projectId: project.projectId,
        projectPath: project.repoPath,
        settings: project.settings,
        logPrefix: `${project.type}ProjectProvider[byoi]`,
        workspaceId: workspaceRow.id,
      });
      return ok(result);
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'byoi-provision',
        stepErrorType: 'error',
        message: String(e),
      });
    }
  }
}

export const workspaceBootstrapService = new WorkspaceBootstrapService(appDb);
