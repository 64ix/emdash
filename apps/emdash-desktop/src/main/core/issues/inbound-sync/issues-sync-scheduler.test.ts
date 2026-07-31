import { ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectGitHubAuthContext } from '@main/core/github/services/project-github-auth-context';
import { issuesSyncEngine } from './issues-sync-engine';
import { IssuesSyncScheduler } from './issues-sync-scheduler';

const mocks = vi.hoisted(() => ({
  resolveRepository: vi.fn(),
  getProject: vi.fn(),
  projectOn: vi.fn(),
  resolveProjectGitHubAuthContext: vi.fn(),
}));

vi.mock('@main/core/github/services/github-repository-resolver', () => ({
  githubRepositoryResolver: { resolve: mocks.resolveRepository },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: mocks.getProject, on: mocks.projectOn },
}));

vi.mock('@main/core/github/services/project-github-auth-context', () => ({
  resolveProjectGitHubAuthContext: mocks.resolveProjectGitHubAuthContext,
}));

vi.mock('@main/core/pull-requests/project-remotes-service', () => ({
  syncProjectRemotes: vi.fn(),
}));

vi.mock('./issues-sync-engine', () => ({
  issuesSyncEngine: { sync: vi.fn() },
}));

function createProject(remotes = [{ name: 'origin', url: 'https://github.com/acme/repo.git' }]) {
  return {
    gitRepository: {
      getRemotes: vi.fn().mockResolvedValue(remotes),
    },
  };
}

describe('IssuesSyncScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(issuesSyncEngine.sync).mockResolvedValue(
      ok({ stageChanges: 0, roleAttachments: 0, suggestionsChanged: false })
    );
  });

  it('syncs every resolved GitHub remote for a mounted project', async () => {
    const project = createProject();
    mocks.getProject.mockReturnValue(project);
    mocks.resolveRepository.mockResolvedValue(
      ok({
        host: 'github.com',
        repositoryUrl: 'https://github.com/acme/repo',
        nameWithOwner: 'acme/repo',
        owner: 'acme',
        repo: 'repo',
      })
    );
    mocks.resolveProjectGitHubAuthContext.mockResolvedValue(ok({ accountId: 'github.com:42' }));

    const scheduler = new IssuesSyncScheduler();
    await scheduler.onProjectMounted('project-1');

    expect(resolveProjectGitHubAuthContext).toHaveBeenCalledWith('project-1');
    expect(issuesSyncEngine.sync).toHaveBeenCalledWith(
      'project-1',
      'https://github.com/acme/repo',
      { accountId: 'github.com:42' }
    );

    scheduler.onProjectUnmounted('project-1');
  });

  it('does not sync when account resolution fails', async () => {
    const project = createProject();
    mocks.getProject.mockReturnValue(project);
    mocks.resolveRepository.mockResolvedValue(
      ok({
        host: 'github.com',
        repositoryUrl: 'https://github.com/acme/repo',
        nameWithOwner: 'acme/repo',
        owner: 'acme',
        repo: 'repo',
      })
    );
    mocks.resolveProjectGitHubAuthContext.mockResolvedValue({
      success: false,
      error: { type: 'unconfigured', projectId: 'project-1', message: 'not configured' },
    });

    const scheduler = new IssuesSyncScheduler();
    await scheduler.onProjectMounted('project-1');

    expect(issuesSyncEngine.sync).not.toHaveBeenCalled();
  });

  it('re-syncs remotes on demand via syncNow without waiting for the interval', async () => {
    vi.useFakeTimers();
    try {
      const project = createProject();
      mocks.getProject.mockReturnValue(project);
      mocks.resolveRepository.mockResolvedValue(
        ok({
          host: 'github.com',
          repositoryUrl: 'https://github.com/acme/repo',
          nameWithOwner: 'acme/repo',
          owner: 'acme',
          repo: 'repo',
        })
      );
      mocks.resolveProjectGitHubAuthContext.mockResolvedValue(ok({ accountId: 'github.com:42' }));

      const scheduler = new IssuesSyncScheduler();
      await scheduler.onProjectMounted('project-1');
      expect(issuesSyncEngine.sync).toHaveBeenCalledTimes(1);

      await scheduler.syncNow('project-1');
      expect(issuesSyncEngine.sync).toHaveBeenCalledTimes(2);

      scheduler.onProjectUnmounted('project-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the polling interval on unmount and dispose', async () => {
    vi.useFakeTimers();
    try {
      const project = createProject();
      mocks.getProject.mockReturnValue(project);
      mocks.resolveRepository.mockResolvedValue(
        ok({
          host: 'github.com',
          repositoryUrl: 'https://github.com/acme/repo',
          nameWithOwner: 'acme/repo',
          owner: 'acme',
          repo: 'repo',
        })
      );
      mocks.resolveProjectGitHubAuthContext.mockResolvedValue(ok({ accountId: 'github.com:42' }));

      const scheduler = new IssuesSyncScheduler();
      await scheduler.onProjectMounted('project-1');
      scheduler.onProjectUnmounted('project-1');

      vi.mocked(issuesSyncEngine.sync).mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(issuesSyncEngine.sync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
