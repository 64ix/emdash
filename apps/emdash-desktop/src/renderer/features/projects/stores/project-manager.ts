import { err, ok, type Result } from '@emdash/shared';
import { makeObservable, observable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { log } from '@renderer/utils/logger';
import { captureTelemetry } from '@renderer/utils/telemetryClient';
import { sshConnectionEventChannel } from '@shared/core/ssh/sshEvents';
import { syncStatusChannel } from '@shared/events/syncEvents';
import type {
  AttachProjectParams,
  AttachProjectResult,
  LocalProject,
  Project,
  SshProject,
} from '@shared/projects';
import { isUnattachedProjectData } from '@shared/projects';
import { splitNameWithOwner } from '@shared/repository-ref';
import type { ProjectViewSnapshot } from '@shared/view-state';
import {
  createUnmountedProject,
  createUnregisteredProject,
  isMountedProject,
  isUnmountedProject,
  isUnregisteredProject,
  type ProjectStore,
  type UnregisteredProjectPhase,
} from './project';
import type {
  ModeData,
  ProjectCreationCompletion,
  ProjectCreationError,
  ProjectType,
  StartProjectCreationOptions,
  StartProjectCreationResult,
} from './project-creation-types';

export class ProjectManagerStore {
  projects = observable.map<string, ProjectStore>();
  pendingCreationIds = observable.set<string>();
  private _projectMountPromises = new Map<string, Promise<void>>();
  private _loadPromise: Promise<void> | null = null;
  private _syncReloadInFlight: Promise<void> | null = null;
  private _lastSshRecoveryAttemptAt = 0;
  private _disposeSshConnectionEvent: (() => void) | null = null;
  private _disposeSyncStatusEvent: (() => void) | null = null;
  private readonly _handleOnline = (): void => {
    this.retryDisconnectedSshProjects({ force: true });
  };
  private readonly _handleFocus = (): void => {
    this.retryDisconnectedSshProjects();
  };

  constructor() {
    makeObservable(this, { projects: observable, pendingCreationIds: observable });

    this._disposeSshConnectionEvent = events.on(sshConnectionEventChannel, (event) => {
      if (event.type !== 'connected' && event.type !== 'reconnected') return;
      this._mountDisconnectedSshProjects(event.connectionId);
    });

    // A completed sync cycle may have applied pulled rows (spec #130): the
    // engine writes them straight into the DB, so the project list loaded at
    // boot is stale. Re-query and merge the rows the boot load did not see —
    // e.g. a project synced from another machine — without touching rows the
    // user is already looking at. Merge-only: remotely deleted rows are
    // reaped on the next launch.
    this._disposeSyncStatusEvent = events.on(syncStatusChannel, (status) => {
      if (status.state !== 'up-to-date') return;
      void this._reloadSyncedProjects();
    });

    globalThis.window?.addEventListener('online', this._handleOnline);
    globalThis.window?.addEventListener('focus', this._handleFocus);
  }

  dispose(): void {
    this._disposeSshConnectionEvent?.();
    this._disposeSshConnectionEvent = null;
    this._disposeSyncStatusEvent?.();
    this._disposeSyncStatusEvent = null;
    globalThis.window?.removeEventListener('online', this._handleOnline);
    globalThis.window?.removeEventListener('focus', this._handleFocus);
  }

  load(): Promise<void> {
    if (!this._loadPromise) {
      this._loadPromise = this._doLoad();
    }
    return this._loadPromise;
  }

  private async _doLoad(): Promise<void> {
    const rawProjects = await rpc.projects.getProjects();
    await this._mergeProjectRows(rawProjects);
  }

  /**
   * Re-queries the project list after a sync cycle completes, merging in any
   * projects that arrived via the relay while the app was running (spec
   * #130: synced projects must appear without a restart). Coalesced: a burst
   * of status events collapses onto one reload.
   */
  private _reloadSyncedProjects(): void {
    if (this._syncReloadInFlight !== null) return;
    this._syncReloadInFlight = (async () => {
      try {
        const rawProjects = await rpc.projects.getProjects();
        await this._mergeProjectRows(rawProjects);
      } finally {
        this._syncReloadInFlight = null;
      }
    })();
  }

  private async _mergeProjectRows(rawProjects: Project[]): Promise<void> {
    const toMount: string[] = [];
    runInAction(() => {
      for (const p of rawProjects) {
        if (this.projects.has(p.id)) continue;
        const store = createUnmountedProject(p, 'idle');
        // A synced project with no local anchor stays Unattached: it must not
        // be opened (openProject would fail with `unattached`) — the user
        // attaches it first.
        if (isUnattachedProjectData(p)) {
          store.errorCode = 'unattached';
        } else {
          toMount.push(p.id);
        }
        this.projects.set(p.id, store);
      }
    });
    await Promise.allSettled(toMount.map((id) => this.mountProject(id)));
  }

  async createProject(
    projectType: ProjectType,
    data: ModeData,
    id?: string
  ): Promise<string | undefined> {
    const result = await this.startProjectCreation(projectType, data, { id });
    if (result.kind === 'existing') return result.projectId;

    const completion = await result.completion;
    return completion.success ? result.projectId : undefined;
  }

  async startProjectCreation(
    projectType: ProjectType,
    data: ModeData,
    options: StartProjectCreationOptions = {}
  ): Promise<StartProjectCreationResult> {
    const isSsh = projectType.type === 'ssh';
    const projectId = options.id ?? crypto.randomUUID();
    const targetPath = data.mode === 'pick' ? data.path : `${data.path}/${data.name}`;
    const inspection = await rpc.projects.inspectProjectPath(
      isSsh
        ? { type: 'ssh', path: targetPath, connectionId: projectType.connectionId }
        : { type: 'local', path: targetPath }
    );
    if (inspection.existingProject) {
      return { kind: 'existing', projectId: inspection.existingProject.id };
    }

    runInAction(() => {
      this.pendingCreationIds.add(projectId);
      this.projects.set(
        projectId,
        createUnregisteredProject(projectId, data.name, initialCreationPhase(data.mode), data.mode)
      );
    });

    const completion = this._doCreateProject(projectType, data, projectId, targetPath).finally(
      () => {
        runInAction(() => this.pendingCreationIds.delete(projectId));
      }
    );

    return { kind: 'creating', projectId, completion };
  }

  private async _doCreateProject(
    projectType: ProjectType,
    data: ModeData,
    projectId: string,
    targetPath: string
  ): Promise<ProjectCreationCompletion> {
    const isSsh = projectType.type === 'ssh';
    const projectTelemetryType: 'local' | 'ssh' = isSsh ? 'ssh' : 'local';
    const projectTelemetryStrategy: 'open' | 'create' | 'clone' =
      data.mode === 'clone' ? 'clone' : data.mode === 'new' ? 'create' : 'open';

    let result: ProjectCreationCompletion;
    try {
      switch (data.mode) {
        case 'pick': {
          const projectResult =
            projectType.type === 'ssh'
              ? await rpc.projects.createProject({
                  type: 'ssh',
                  id: projectId,
                  path: targetPath,
                  name: data.name,
                  connectionId: projectType.connectionId,
                  initGitRepository: data.initGitRepository,
                })
              : await rpc.projects.createProject({
                  type: 'local',
                  id: projectId,
                  path: targetPath,
                  name: data.name,
                  initGitRepository: data.initGitRepository,
                });
          if (!projectResult.success) {
            result = err(projectResult.error);
            break;
          }

          const project = projectResult.data;
          if (data.initGitRepository) {
            await this._saveInitialGitHubAccountSetting(project.id, data.githubAccountId);
          }
          this._setAndOpenProject(projectId, project);
          result = ok();
          break;
        }

        case 'clone': {
          const connectionId = projectType.type === 'ssh' ? projectType.connectionId : undefined;
          const cloneResult = await rpc.projectSetup.cloneRepository(
            data.repositoryUrl,
            targetPath,
            connectionId
          );
          if (!cloneResult.success) {
            result = err({
              type: 'clone-failed',
              message: cloneResult.error?.trim() || 'Clone failed',
            });
            break;
          }

          this._updatePhase(projectId, 'registering');
          const projectResult =
            projectType.type === 'ssh'
              ? await rpc.projects.createProject({
                  type: 'ssh',
                  id: projectId,
                  path: targetPath,
                  name: data.name,
                  connectionId: projectType.connectionId,
                })
              : await rpc.projects.createProject({
                  type: 'local',
                  id: projectId,
                  path: targetPath,
                  name: data.name,
                });
          if (!projectResult.success) {
            result = err(projectResult.error);
            break;
          }

          this._setAndOpenProject(projectId, projectResult.data);
          result = ok();
          break;
        }

        case 'new': {
          const repoResult = await rpc.github.createRepository({
            name: data.repositoryName,
            owner: data.repositoryOwner,
            isPrivate: data.repositoryVisibility === 'private',
            accountId: data.githubAccountId ?? undefined,
          });
          if (!repoResult.success) {
            result = err({
              type: 'repository-create-failed',
              message: repoResult.error?.trim() || 'Repository creation failed',
            });
            break;
          }
          if (!repoResult.nameWithOwner || !repoResult.cloneUrl) {
            result = err({
              type: 'repository-response-incomplete',
              message: 'Repository creation response was incomplete',
            });
            break;
          }

          const projectResult = await this._cloneInitializeAndCreateGitHubProject({
            projectType,
            projectId,
            targetPath,
            name: data.name,
            cloneUrl: repoResult.cloneUrl,
            repositoryNameWithOwner: repoResult.nameWithOwner,
            githubAccountId: data.githubAccountId,
          });
          if (!projectResult.success) {
            result = err(projectResult.error);
            break;
          }

          const project = projectResult.data;
          await this._saveInitialGitHubAccountSetting(project.id, data.githubAccountId);
          this._setAndOpenProject(projectId, project);
          result = ok();
          break;
        }
      }
    } catch (error) {
      this._markUnexpectedCreationError(projectId, error);
      captureTelemetry('project_added', {
        type: projectTelemetryType,
        strategy: projectTelemetryStrategy,
        success: false,
      });
      throw error;
    }

    if (!result.success) this._markCreationError(projectId, result.error);
    captureTelemetry('project_added', {
      type: projectTelemetryType,
      strategy: projectTelemetryStrategy,
      success: result.success,
    });
    return result;
  }

  mountProject(projectId: string): Promise<void> {
    const inFlight = this._projectMountPromises.get(projectId);
    if (inFlight) return inFlight;

    const project = this.projects.get(projectId);
    if (!project || !isUnmountedProject(project)) return Promise.resolve();
    // Unattached projects have nothing to mount until the user attaches them.
    if (project.errorCode === 'unattached') return Promise.resolve();

    runInAction(() => {
      project.phase = 'opening';
      project.error = undefined;
      project.errorCode = undefined;
    });

    const promise = Promise.all([
      rpc.projects.openProject(projectId),
      viewStateCache.get(`project:${projectId}`),
    ])
      .then(async ([openResult, savedSnapshot]) => {
        if (!openResult.success) {
          runInAction(() => {
            const current = this.projects.get(projectId);
            if (current && isUnmountedProject(current)) {
              current.phase = 'error';
              if (openResult.error.type === 'path-not-found') {
                current.error = openResult.error.path;
                current.errorCode = 'path-not-found';
              } else if (openResult.error.type === 'ssh-disconnected') {
                current.error = openResult.error.connectionId;
                current.errorCode = 'ssh-disconnected';
              } else if (openResult.error.type === 'unattached') {
                // Safety net: a synced project with no local anchor must not
                // mount; it stays Unattached with an Attach action.
                current.error = undefined;
                current.errorCode = 'unattached';
              } else {
                current.error = openResult.error.message;
                current.errorCode = undefined;
              }
            }
          });
          return;
        }
        runInAction(() => {
          const current = this.projects.get(projectId);
          if (current && isUnmountedProject(current)) {
            // Patch repositoryWorkspaceId from the main process response so the
            // mounted project data is up-to-date (fixes stale null after creation).
            const projectData = current.data;
            if (openResult.data.repositoryWorkspaceId && projectData) {
              projectData.repositoryWorkspaceId = openResult.data.repositoryWorkspaceId;
            }
            current.transitionToMounted(
              projectData,
              savedSnapshot as ProjectViewSnapshot | undefined
            );
          }
        });
        // Revalidate the current view's guard now that this project's saved
        // ProjectViewStore snapshot is in place (ticket #44). If the user is
        // already sitting on `project` for this projectId -- e.g. it just
        // reconnected from an SSH-disconnected or mount-error state while
        // still mounted -- and its persisted work mode is Board,
        // `projectView.canActivate` could not see that preference before
        // this project had a mounted view store; this catches that case up
        // instead of leaving it stuck on List until the next navigation.
        appState.navigation.revalidate();
        // Load the task list before provisioning so the tasks map is populated.
        const taskManager = this.projects.get(projectId)?.mountedProject?.taskManager;
        if (taskManager) {
          await taskManager.loadTasks();
          const nav = appState.navigation;
          const navParams = nav.viewParamsStore['task'] as
            | { projectId?: string; taskId?: string }
            | undefined;
          const navTaskId =
            nav.currentViewId === 'task' && navParams?.projectId === projectId
              ? navParams.taskId
              : undefined;
          if (navTaskId) {
            taskManager.provisionTask(navTaskId).catch(() => {});
          }
        }
      })
      .catch((err: unknown) => {
        runInAction(() => {
          const current = this.projects.get(projectId);
          if (current && isUnmountedProject(current)) {
            current.phase = 'error';
            current.error = err instanceof Error ? err.message : String(err);
            current.errorCode = undefined;
          }
        });
        throw err;
      })
      .finally(() => {
        this._projectMountPromises.delete(projectId);
      });

    this._projectMountPromises.set(projectId, promise);
    return promise;
  }

  async deleteProject(projectId: string): Promise<void> {
    const snapshot = this.projects.get(projectId);
    runInAction(() => {
      this.projects.delete(projectId);
    });
    appState.navigation.revalidate();
    try {
      await rpc.projects.deleteProject(projectId);
    } catch (err) {
      runInAction(() => {
        if (snapshot) this.projects.set(projectId, snapshot);
      });
      throw err;
    }
  }

  retryDisconnectedSshProjects(options: { force?: boolean } = {}): void {
    const now = Date.now();
    if (!options.force && now - this._lastSshRecoveryAttemptAt < 5_000) return;

    const connectionIds = new Set<string>();
    for (const store of this.projects.values()) {
      if (
        isUnmountedProject(store) &&
        store.errorCode === 'ssh-disconnected' &&
        store.data.type === 'ssh' &&
        store.data.connectionId !== null
      ) {
        connectionIds.add(store.data.connectionId);
      }
    }

    if (connectionIds.size === 0) return;
    this._lastSshRecoveryAttemptAt = now;

    for (const connectionId of connectionIds) {
      const state = appState.sshConnections.stateFor(connectionId);
      if (state === 'connected') {
        this._mountDisconnectedSshProjects(connectionId);
        continue;
      }
      if (state === 'connecting') continue;
      void appState.sshConnections
        .connect(connectionId, { force: true })
        .then(() => {
          if (appState.sshConnections.stateFor(connectionId) === 'connected') {
            this._mountDisconnectedSshProjects(connectionId);
          }
        })
        .catch(() => {});
    }
  }

  private _mountDisconnectedSshProjects(connectionId: string): void {
    for (const [projectId, store] of this.projects) {
      if (
        isUnmountedProject(store) &&
        store.errorCode === 'ssh-disconnected' &&
        store.data.type === 'ssh' &&
        store.data.connectionId === connectionId
      ) {
        this.mountProject(projectId).catch(() => {});
      }
    }
  }

  async updateProjectConnection(projectId: string, newConnectionId: string): Promise<void> {
    await rpc.projects.updateProjectConnection(projectId, newConnectionId);

    const store = this.projects.get(projectId);
    if (!store || !store.data || store.data.type !== 'ssh') return;

    const newData: SshProject = { ...store.data, connectionId: newConnectionId };

    runInAction(() => {
      const current = this.projects.get(projectId);
      if (!current || !current.data || current.data.type !== 'ssh') return;
      if (isMountedProject(current)) {
        current.transitionToUnmounted(newData, 'opening');
      } else if (isUnmountedProject(current)) {
        current.data = newData;
        current.phase = 'opening';
        current.error = undefined;
        current.errorCode = undefined;
      }
    });

    // Wait for any existing in-flight mount to settle before attempting a fresh mount
    const inFlight = this._projectMountPromises.get(projectId);
    if (inFlight) await inFlight.catch(() => {});

    this.mountProject(projectId).catch(() => {});
  }

  /**
   * Attach an unattached (synced) project on this machine (ticket #136).
   * On a direct attach the store is updated and the project is mounted; on a
   * merge the synced row disappears (the local project wins) and the store
   * entry is dropped.
   */
  async attachProject(
    projectId: string,
    params: AttachProjectParams
  ): Promise<AttachProjectResult> {
    const result = await rpc.projects.attachProject(params);
    if (!result.success) return result;

    runInAction(() => {
      if (result.data.mergedInto !== null) {
        // The synced row merged into an existing local project — one row left.
        this.projects.delete(projectId);
      } else {
        const current = this.projects.get(projectId);
        if (current && isUnmountedProject(current)) {
          current.data = result.data.project;
          current.error = undefined;
          current.errorCode = undefined;
        }
      }
    });

    if (result.data.mergedInto === null) {
      this.mountProject(projectId).catch(() => {});
    }
    return result;
  }

  removeUnregisteredProject(projectId: string): void {
    runInAction(() => {
      const store = this.projects.get(projectId);
      if (store && isUnregisteredProject(store)) {
        this.projects.delete(projectId);
      }
    });
  }

  private _setAndOpenProject(id: string, project: LocalProject | SshProject): void {
    runInAction(() => {
      const current = this.projects.get(id);
      if (current) {
        current.transitionToUnmounted(project, 'opening');
      } else {
        this.projects.set(id, createUnmountedProject(project, 'opening'));
      }
    });
    void this.mountProject(id);
  }

  private async _saveInitialGitHubAccountSetting(
    projectId: string,
    githubAccountId?: string
  ): Promise<void> {
    if (githubAccountId === undefined) return;

    const result = await rpc.projects.patchProjectSettings(projectId, { githubAccountId });
    if (!result.success) {
      log.error('Failed to save initial GitHub account for project', {
        projectId,
        error: result.error,
      });
    }
  }

  private async _rollbackCreatedGitHubRepository(
    nameWithOwner: string,
    githubAccountId?: string
  ): Promise<void> {
    try {
      const { owner, repo } = splitNameWithOwner(nameWithOwner);
      const result = await rpc.github.deleteRepository({
        owner,
        name: repo,
        accountId: githubAccountId ?? undefined,
      });
      if (!result.success) {
        log.error('Failed to delete GitHub repository after project creation failure', {
          nameWithOwner,
          error: result.error,
        });
      }
    } catch (error) {
      log.error('Failed to delete GitHub repository after project creation failure', {
        nameWithOwner,
        error,
      });
    }
  }

  private async _cloneInitializeAndCreateGitHubProject(opts: {
    projectType: ProjectType;
    projectId: string;
    targetPath: string;
    name: string;
    cloneUrl: string;
    repositoryNameWithOwner: string;
    githubAccountId?: string;
  }): Promise<Result<LocalProject | SshProject, ProjectCreationError>> {
    const connectionId =
      opts.projectType.type === 'ssh' ? opts.projectType.connectionId : undefined;

    let result: Result<LocalProject | SshProject, ProjectCreationError>;
    try {
      this._updatePhase(opts.projectId, 'cloning');
      const cloneResult = await rpc.projectSetup.cloneRepository(
        opts.cloneUrl,
        opts.targetPath,
        connectionId
      );
      if (!cloneResult.success) {
        result = err({
          type: 'clone-failed',
          message: cloneResult.error?.trim() || 'Clone failed',
        });
      } else {
        const initResult = await rpc.projectSetup.initializeRepository({
          targetPath: opts.targetPath,
          name: opts.name,
          connectionId,
        });
        if (!initResult.success) {
          result = err({
            type: 'initialize-failed',
            message: initResult.error?.trim() || 'Project initialization failed',
          });
        } else {
          this._updatePhase(opts.projectId, 'registering');
          result =
            opts.projectType.type === 'ssh'
              ? await rpc.projects.createProject({
                  type: 'ssh',
                  id: opts.projectId,
                  path: opts.targetPath,
                  name: opts.name,
                  connectionId: opts.projectType.connectionId,
                })
              : await rpc.projects.createProject({
                  type: 'local',
                  id: opts.projectId,
                  path: opts.targetPath,
                  name: opts.name,
                });
        }
      }
    } catch (error) {
      await this._rollbackCreatedGitHubRepository(
        opts.repositoryNameWithOwner,
        opts.githubAccountId
      );
      throw error;
    }

    if (!result.success) {
      await this._rollbackCreatedGitHubRepository(
        opts.repositoryNameWithOwner,
        opts.githubAccountId
      );
    }
    return result;
  }

  private _updatePhase(id: string, phase: UnregisteredProjectPhase): void {
    runInAction(() => {
      const store = this.projects.get(id);
      if (store && isUnregisteredProject(store)) store.phase = phase;
    });
  }

  private _markCreationError(id: string, error: ProjectCreationError): void {
    runInAction(() => {
      const store = this.projects.get(id);
      if (store && isUnregisteredProject(store)) {
        store.phase = 'error';
        store.error =
          error.type === 'not-repository'
            ? 'Directory is not a git repository. Enable "Initialize git repository" to continue.'
            : error.type === 'inspect-failed'
              ? `Could not inspect directory: ${error.message}`
              : error.message;
      }
    });
  }

  private _markUnexpectedCreationError(id: string, error: unknown): void {
    runInAction(() => {
      const store = this.projects.get(id);
      if (store && isUnregisteredProject(store)) {
        store.phase = 'error';
        store.error = error instanceof Error ? error.message : String(error);
      }
    });
  }
}

function initialCreationPhase(mode: ModeData['mode']): UnregisteredProjectPhase {
  switch (mode) {
    case 'pick':
      return 'registering';
    case 'clone':
      return 'cloning';
    case 'new':
      return 'creating-repo';
  }
}
