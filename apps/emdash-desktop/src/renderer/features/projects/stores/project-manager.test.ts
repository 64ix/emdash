import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncStatusChannel } from '@shared/events/syncEvents';
import type { LocalProject, SshProject } from '@shared/projects';
import {
  createUnmountedProject,
  isMountedProject,
  isUnmountedProject,
  isUnregisteredProject,
} from './project';
import { ProjectManagerStore } from './project-manager';

const mocks = vi.hoisted(() => ({
  attachProject: vi.fn(),
  cloneRepository: vi.fn(),
  createGithubRepository: vi.fn(),
  createProject: vi.fn(),
  deleteGithubRepository: vi.fn(),
  initializeRepository: vi.fn(),
  inspectProjectPath: vi.fn(),
  openProject: vi.fn(),
  patchProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  eventOn: vi.fn(),
  sshConnect: vi.fn(),
  sshStateFor: vi.fn(),
  navRevalidate: vi.fn(),
  viewStateCacheGet: vi.fn(async (): Promise<unknown> => undefined),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: mocks.eventOn,
  },
  rpc: {
    github: {
      createRepository: mocks.createGithubRepository,
      deleteRepository: mocks.deleteGithubRepository,
    },
    projectSetup: {
      cloneRepository: mocks.cloneRepository,
      initializeRepository: mocks.initializeRepository,
    },
    projects: {
      attachProject: mocks.attachProject,
      createProject: mocks.createProject,
      getProjects: vi.fn(async () => []),
      inspectProjectPath: mocks.inspectProjectPath,
      openProject: mocks.openProject,
      patchProjectSettings: mocks.patchProjectSettings,
      updateProjectSettings: mocks.updateProjectSettings,
    },
    tasks: {
      getTasks: vi.fn(async () => []),
    },
    conversations: {
      getConversationsForProject: vi.fn(async () => []),
    },
    gitRepository: {
      getRepoSnapshot: vi.fn(async () => ({ success: true, data: { refs: {}, remotes: {} } })),
      resolveProviderRepository: vi.fn(async () => ({ success: true, data: null })),
      getDefaultBranch: vi.fn(async () => ({ success: true, data: null })),
    },
    pullRequests: {
      cancelSync: vi.fn(),
      syncPullRequests: vi.fn(),
    },
  },
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      currentViewId: 'home',
      revalidate: mocks.navRevalidate,
      viewParamsStore: {},
    },
    sshConnections: {
      connect: mocks.sshConnect,
      stateFor: mocks.sshStateFor,
    },
  },
}));

vi.mock('@renderer/lib/stores/view-state-cache', () => ({
  viewStateCache: {
    get: mocks.viewStateCacheGet,
    set: vi.fn(),
  },
}));

vi.mock('@renderer/features/conversations/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    conversationId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/conversations/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: vi.fn(),
}));

function localProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    type: 'local',
    id: 'project-id',
    name: 'Project',
    path: '/project',
    baseRef: 'main',
    repositoryWorkspaceId: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

function sshProject(overrides: Partial<SshProject> = {}): SshProject {
  return {
    type: 'ssh',
    id: 'ssh-project-id',
    name: 'SSH Project',
    path: '/project',
    baseRef: 'main',
    connectionId: 'ssh-1',
    repositoryWorkspaceId: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

function okProject(project: LocalProject) {
  return { success: true as const, data: project };
}

describe('ProjectManagerStore project creation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventOn.mockReturnValue(vi.fn());
    mocks.inspectProjectPath.mockResolvedValue({ isDirectory: true, isGitRepo: true });
    mocks.createProject.mockResolvedValue(okProject(localProject()));
    mocks.openProject.mockReturnValue(new Promise(() => {}));
    mocks.cloneRepository.mockReturnValue(new Promise(() => {}));
    mocks.createGithubRepository.mockResolvedValue({
      success: true,
      repoUrl: 'https://github.com/acme/project.git',
      cloneUrl: 'https://github.com/acme/project.git',
      nameWithOwner: 'acme/project',
    });
    mocks.deleteGithubRepository.mockResolvedValue({ success: true });
    mocks.initializeRepository.mockResolvedValue({ success: true });
    mocks.updateProjectSettings.mockResolvedValue({
      success: true,
      data: { githubAccountId: 'github.com:42' },
    });
    mocks.patchProjectSettings.mockResolvedValue({
      success: true,
      data: { githubAccountId: 'github.com:42' },
    });
    mocks.sshConnect.mockResolvedValue(undefined);
    mocks.sshStateFor.mockReturnValue('disconnected');
    mocks.viewStateCacheGet.mockResolvedValue(undefined);
  });

  it('returns an existing project without starting creation', async () => {
    const existingProject = localProject({ id: 'existing-project' });
    mocks.inspectProjectPath.mockResolvedValueOnce({
      isDirectory: true,
      isGitRepo: true,
      existingProject,
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/project' },
      { id: 'optimistic-project' }
    );

    expect(result).toEqual({ kind: 'existing', projectId: 'existing-project' });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(store.projects.has('optimistic-project')).toBe(false);
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(false);
  });

  it('creates unregistered project state before returning creating', async () => {
    let resolveCreateProject: (project: LocalProject) => void = () => {};
    mocks.createProject.mockReturnValueOnce(
      new Promise<ReturnType<typeof okProject>>((resolve) => {
        resolveCreateProject = (project) => resolve(okProject(project));
      })
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/project' },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    const pendingProject = store.projects.get('optimistic-project');
    expect(pendingProject && isUnregisteredProject(pendingProject)).toBe(true);
    expect(pendingProject?.phase).toBe('registering');
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(true);
    expect(mocks.inspectProjectPath).toHaveBeenCalledTimes(1);

    resolveCreateProject(localProject({ id: 'optimistic-project' }));
    if (result.kind === 'creating') await result.completion;

    expect(mocks.inspectProjectPath).toHaveBeenCalledTimes(1);
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(false);
  });

  it('inspects the final clone path instead of the parent directory', async () => {
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'clone',
        name: 'child-project',
        path: '/parent',
        repositoryUrl: 'https://github.com/acme/child-project.git',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') void result.completion;
    expect(mocks.inspectProjectPath).toHaveBeenCalledWith({
      type: 'local',
      path: '/parent/child-project',
    });
  });

  it('inspects the final new-project path instead of the parent directory', async () => {
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'child-project',
        path: '/parent',
        repositoryName: 'child-project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') void result.completion;
    expect(mocks.inspectProjectPath).toHaveBeenCalledWith({
      type: 'local',
      path: '/parent/child-project',
    });
  });

  it('does not let a project registered at the clone parent path short-circuit creation', async () => {
    const parentProject = localProject({ id: 'parent-project', path: '/parent' });
    mocks.inspectProjectPath.mockImplementation(async ({ path }: { path: string }) => ({
      isDirectory: true,
      isGitRepo: true,
      existingProject: path === '/parent' ? parentProject : undefined,
    }));
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'clone',
        name: 'child-project',
        path: '/parent',
        repositoryUrl: 'https://github.com/acme/child-project.git',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') void result.completion;
    expect(result.kind).toBe('creating');
    expect(store.projects.has('optimistic-project')).toBe(true);
  });

  it('does not let a project registered at the new-project parent path short-circuit creation', async () => {
    const parentProject = localProject({ id: 'parent-project', path: '/parent' });
    mocks.inspectProjectPath.mockImplementation(async ({ path }: { path: string }) => ({
      isDirectory: true,
      isGitRepo: true,
      existingProject: path === '/parent' ? parentProject : undefined,
    }));
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'child-project',
        path: '/parent',
        repositoryName: 'child-project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') void result.completion;
    expect(result.kind).toBe('creating');
    expect(store.projects.has('optimistic-project')).toBe(true);
  });

  it('persists the selected GitHub account after registering a new project', async () => {
    mocks.cloneRepository.mockResolvedValueOnce({ success: true });
    mocks.createProject.mockResolvedValueOnce(
      okProject(localProject({ id: 'optimistic-project' }))
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'Project',
        path: '/parent',
        repositoryName: 'project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') await result.completion;

    expect(mocks.patchProjectSettings).toHaveBeenCalledWith('optimistic-project', {
      githubAccountId: 'github.com:42',
    });
    expect(mocks.updateProjectSettings).not.toHaveBeenCalled();
  });

  it('removes window and SSH event listeners on dispose', () => {
    const disposeSshEvent = vi.fn();
    mocks.eventOn.mockReturnValueOnce(disposeSshEvent);
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal('window', { addEventListener, removeEventListener });
    const store = new ProjectManagerStore();

    store.dispose();
    store.dispose();

    expect(disposeSshEvent).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
  });

  it('retries SSH-disconnected projects without mounting before the connection is ready', async () => {
    const store = new ProjectManagerStore();
    const project = sshProject();
    store.projects.set(project.id, createUnmountedProject(project, 'idle'));
    const projectStore = store.projects.get(project.id);
    if (!projectStore) throw new Error('Expected project store');
    projectStore.phase = 'error';
    projectStore.error = project.connectionId ?? undefined;
    projectStore.errorCode = 'ssh-disconnected';

    store.retryDisconnectedSshProjects({ force: true });
    await Promise.resolve();

    expect(mocks.sshConnect).toHaveBeenCalledWith('ssh-1', { force: true });
    expect(mocks.openProject).not.toHaveBeenCalled();
  });

  it('mounts SSH-disconnected projects after a successful reconnect event', () => {
    const store = new ProjectManagerStore();
    const project = sshProject();
    store.projects.set(project.id, createUnmountedProject(project, 'idle'));
    const projectStore = store.projects.get(project.id);
    if (!projectStore) throw new Error('Expected project store');
    projectStore.phase = 'error';
    projectStore.error = project.connectionId ?? undefined;
    projectStore.errorCode = 'ssh-disconnected';

    const handler = mocks.eventOn.mock.calls[0]?.[1];
    if (!handler) throw new Error('Expected SSH event subscription');
    handler({ type: 'connected', connectionId: 'ssh-1' });

    expect(mocks.openProject).toHaveBeenCalledWith(project.id);
  });

  it('mounts SSH-disconnected projects when the connection is already connected', () => {
    mocks.sshStateFor.mockReturnValue('connected');
    const store = new ProjectManagerStore();
    const project = sshProject();
    store.projects.set(project.id, createUnmountedProject(project, 'idle'));
    const projectStore = store.projects.get(project.id);
    if (!projectStore) throw new Error('Expected project store');
    projectStore.phase = 'error';
    projectStore.error = project.connectionId ?? undefined;
    projectStore.errorCode = 'ssh-disconnected';

    store.retryDisconnectedSshProjects({ force: true });

    expect(mocks.sshConnect).not.toHaveBeenCalled();
    expect(mocks.openProject).toHaveBeenCalledWith(project.id);
  });

  it('revalidates navigation once a mounted project has restored its saved work-mode snapshot (ticket #44)', async () => {
    // Reproduces the disclosed race: `projectView.canActivate`'s board-redirect
    // check reads `getProjectViewStore(projectId)`, which is `undefined` until
    // this project is mounted. If nothing revalidates the current view's guard
    // once mounting finishes and the saved ProjectViewSnapshot (activeView:
    // 'board') is restored, a user who reopens this still-unmounted project
    // (e.g. an SSH project regaining connection while its `project` view is
    // already on screen) would stay stuck on List instead of Board.
    mocks.openProject.mockResolvedValueOnce({
      success: true,
      data: { repositoryWorkspaceId: null },
    });
    mocks.viewStateCacheGet.mockResolvedValueOnce({
      activeView: 'board',
      taskViewTab: 'active',
    });

    const store = new ProjectManagerStore();
    const project = localProject();
    store.projects.set(project.id, createUnmountedProject(project, 'idle'));

    await store.mountProject(project.id);

    const mounted = store.projects.get(project.id)?.mountedProject;
    expect(mounted?.view.activeView).toBe('board');
    expect(mocks.navRevalidate).toHaveBeenCalled();
  });

  it('does not write GitHub account settings when creation did not specify one', async () => {
    mocks.createProject.mockResolvedValueOnce(
      okProject(localProject({ id: 'optimistic-project' }))
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/project' },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') await result.completion;

    expect(mocks.patchProjectSettings).not.toHaveBeenCalled();
    expect(mocks.updateProjectSettings).not.toHaveBeenCalled();
  });

  it('marks project creation as failed when the project RPC returns a typed error', async () => {
    mocks.createProject.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'not-repository',
        path: '/project',
      },
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/project' },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: { type: 'not-repository', path: '/project' },
      });
    }

    const project = store.projects.get('optimistic-project');
    expect(project && isUnregisteredProject(project)).toBe(true);
    if (project && isUnregisteredProject(project)) {
      expect(project.phase).toBe('error');
      expect(project.error).toBe(
        'Directory is not a git repository. Enable "Initialize git repository" to continue.'
      );
    }
  });

  it('marks project creation with an inspection failure message', async () => {
    mocks.createProject.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'inspect-failed',
        path: '/Volumes/Data/dev/myapp',
        message: 'Permission denied',
      },
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/Volumes/Data/dev/myapp' },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: {
          type: 'inspect-failed',
          path: '/Volumes/Data/dev/myapp',
          message: 'Permission denied',
        },
      });
    }

    const project = store.projects.get('optimistic-project');
    expect(project && isUnregisteredProject(project)).toBe(true);
    if (project && isUnregisteredProject(project)) {
      expect(project.phase).toBe('error');
      expect(project.error).toBe('Could not inspect directory: Permission denied');
    }
  });

  it('persists the default GitHub account after initializing a picked folder', async () => {
    mocks.createProject.mockResolvedValueOnce(
      okProject(localProject({ id: 'optimistic-project' }))
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'pick',
        name: 'Project',
        path: '/project',
        initGitRepository: true,
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') await result.completion;

    expect(mocks.patchProjectSettings).toHaveBeenCalledWith('optimistic-project', {
      githubAccountId: 'github.com:42',
    });
    expect(mocks.updateProjectSettings).not.toHaveBeenCalled();
  });

  it('does not persist a GitHub account for picked repositories that were already git repos', async () => {
    mocks.createProject.mockResolvedValueOnce(
      okProject(localProject({ id: 'optimistic-project' }))
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'pick',
        name: 'Project',
        path: '/project',
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') await result.completion;

    expect(mocks.patchProjectSettings).not.toHaveBeenCalled();
    expect(mocks.updateProjectSettings).not.toHaveBeenCalled();
  });

  it('uses the selected GitHub account when creating a repository for a new project', async () => {
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'Project',
        path: '/parent',
        repositoryName: 'project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') void result.completion;

    expect(mocks.createGithubRepository).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'github.com:42' })
    );
  });

  it('clones a newly created repository from the API-provided clone URL', async () => {
    mocks.createGithubRepository.mockResolvedValueOnce({
      success: true,
      repoUrl: 'https://ghe.example.com/acme/project',
      cloneUrl: 'https://ghe.example.com/acme/project.git',
      nameWithOwner: 'acme/project',
    });
    mocks.cloneRepository.mockResolvedValueOnce({ success: true });
    mocks.createProject.mockResolvedValueOnce(
      okProject(localProject({ id: 'optimistic-project' }))
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'Project',
        path: '/parent',
        repositoryName: 'project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
        githubAccountId: 'ghe.example.com:168',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') await result.completion;

    expect(mocks.cloneRepository).toHaveBeenCalledWith(
      'https://ghe.example.com/acme/project.git',
      '/parent/Project',
      undefined
    );
  });

  it('deletes a newly created GitHub repository with the selected account if clone fails', async () => {
    mocks.cloneRepository.mockResolvedValueOnce({ success: false, error: 'Clone failed' });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'Project',
        path: '/parent',
        repositoryName: 'project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: { type: 'clone-failed', message: 'Clone failed' },
      });
    }

    expect(mocks.deleteGithubRepository).toHaveBeenCalledWith({
      owner: 'acme',
      name: 'project',
      accountId: 'github.com:42',
    });
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('does not attempt GitHub repository rollback when repository creation fails', async () => {
    mocks.createGithubRepository.mockResolvedValueOnce({
      success: false,
      error: 'Repository creation failed',
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'Project',
        path: '/parent',
        repositoryName: 'project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: { type: 'repository-create-failed', message: 'Repository creation failed' },
      });
    }

    expect(mocks.deleteGithubRepository).not.toHaveBeenCalled();
  });
});

describe('ProjectManagerStore unattached projects (spec #130, ticket #136)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventOn.mockReturnValue(vi.fn());
    mocks.openProject.mockResolvedValue({
      success: true,
      data: { repositoryWorkspaceId: 'ws-1' },
    });
    mocks.viewStateCacheGet.mockResolvedValue(undefined);
  });

  it('loads unattached projects without mounting them, distinct from attached ones', async () => {
    const rpc = await import('@renderer/lib/ipc');
    vi.spyOn(rpc.rpc.projects, 'getProjects').mockResolvedValueOnce([
      localProject({ id: 'unattached-local', path: null }),
      sshProject({ id: 'unattached-ssh', connectionId: null }),
      localProject({ id: 'attached', path: '/attached' }),
    ]);
    const store = new ProjectManagerStore();
    await store.load();

    const unattachedLocal = store.projects.get('unattached-local');
    expect(unattachedLocal && isUnmountedProject(unattachedLocal)).toBe(true);
    expect(unattachedLocal?.errorCode).toBe('unattached');
    const unattachedSsh = store.projects.get('unattached-ssh');
    expect(unattachedSsh?.errorCode).toBe('unattached');
    const attached = store.projects.get('attached');
    expect(attached && isMountedProject(attached)).toBe(true);

    // openProject is only attempted for attached projects.
    expect(mocks.openProject).toHaveBeenCalledTimes(1);
    expect(mocks.openProject).toHaveBeenCalledWith('attached');
  });

  it('does not mount an unattached project on request', async () => {
    const rpc = await import('@renderer/lib/ipc');
    vi.spyOn(rpc.rpc.projects, 'getProjects').mockResolvedValueOnce([
      localProject({ id: 'unattached-local', path: null }),
    ]);
    const store = new ProjectManagerStore();
    await store.load();

    await store.mountProject('unattached-local');
    expect(mocks.openProject).not.toHaveBeenCalled();
    const storeEntry = store.projects.get('unattached-local');
    expect(storeEntry && isUnmountedProject(storeEntry)).toBe(true);
  });

  it('attaches directly: updates the store entry and mounts the project', async () => {
    const rpc = await import('@renderer/lib/ipc');
    vi.spyOn(rpc.rpc.projects, 'getProjects').mockResolvedValueOnce([
      localProject({ id: 'synced', path: null }),
    ]);
    const store = new ProjectManagerStore();
    await store.load();

    mocks.attachProject.mockResolvedValueOnce({
      success: true,
      data: { project: localProject({ id: 'synced', path: '/new/path' }), mergedInto: null },
    });

    const result = await store.attachProject('synced', {
      type: 'local',
      projectId: 'synced',
      path: '/new/path',
    });

    expect(result.success).toBe(true);
    const entry = store.projects.get('synced');
    expect(entry?.data).toMatchObject({ id: 'synced', path: '/new/path' });
    expect(entry?.errorCode).toBeUndefined();
    expect(mocks.openProject).toHaveBeenCalledWith('synced');
  });

  it('attaches with merge: drops the synced store entry (local row wins)', async () => {
    const rpc = await import('@renderer/lib/ipc');
    vi.spyOn(rpc.rpc.projects, 'getProjects').mockResolvedValueOnce([
      localProject({ id: 'synced', path: null }),
      localProject({ id: 'local-winner', path: '/repo' }),
    ]);
    const store = new ProjectManagerStore();
    await store.load();

    mocks.attachProject.mockResolvedValueOnce({
      success: true,
      data: {
        project: localProject({ id: 'local-winner', path: '/repo' }),
        mergedInto: 'local-winner',
      },
    });

    const result = await store.attachProject('synced', {
      type: 'local',
      projectId: 'synced',
      path: '/repo',
    });

    expect(result.success).toBe(true);
    expect(store.projects.has('synced')).toBe(false);
    expect(store.projects.get('local-winner')).toBeDefined();
    expect(mocks.openProject).not.toHaveBeenCalledWith('synced');
  });

  it('surfaces attach failures without touching the store', async () => {
    const rpc = await import('@renderer/lib/ipc');
    vi.spyOn(rpc.rpc.projects, 'getProjects').mockResolvedValueOnce([
      localProject({ id: 'synced', path: null }),
    ]);
    const store = new ProjectManagerStore();
    await store.load();

    mocks.attachProject.mockResolvedValueOnce({
      success: false,
      error: { type: 'remote-mismatch', path: '/other' },
    });

    const result = await store.attachProject('synced', {
      type: 'local',
      projectId: 'synced',
      path: '/other',
    });

    expect(result.success).toBe(false);
    const entry = store.projects.get('synced');
    expect(entry && isUnmountedProject(entry)).toBe(true);
    expect(entry?.errorCode).toBe('unattached');
    expect(mocks.openProject).not.toHaveBeenCalled();
  });
});

describe('ProjectManagerStore sync reload (spec #130: rows applied while running)', () => {
  type Channel = { name: string };
  type Handler = (payload: unknown) => void;
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    handlers = new Map();
    mocks.eventOn.mockImplementation((channel: Channel, handler: Handler) => {
      handlers.set(channel.name, handler);
      return () => handlers.delete(channel.name);
    });
  });

  it('picks up projects a completed sync cycle applied while the app was running', async () => {
    const rpc = await import('@renderer/lib/ipc');
    vi.spyOn(rpc.rpc.projects, 'getProjects').mockResolvedValueOnce([]);
    const store = new ProjectManagerStore();
    await store.load();
    expect(store.projects.size).toBe(0);

    // The main process applies the pulled rows, then reports the cycle done.
    vi.spyOn(rpc.rpc.projects, 'getProjects').mockResolvedValueOnce([
      localProject({ id: 'synced-project', path: null }),
    ]);
    const fireSync = handlers.get(syncStatusChannel.name);
    expect(fireSync).toBeDefined();
    fireSync?.({
      state: 'up-to-date',
      paired: true,
      lastSyncAt: 1,
      lastError: null,
      pendingCount: 0,
    });

    await vi.waitFor(() => {
      const synced = store.projects.get('synced-project');
      expect(synced).toBeDefined();
      expect(synced?.errorCode).toBe('unattached');
    });
  });
});
