import { ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getIssueTrackerRepositoryUrl } from './issue-tracker-repository';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  resolveRepository: vi.fn(),
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: mocks.getProject },
}));

vi.mock('@main/core/github/services/github-repository-resolver', () => ({
  githubRepositoryResolver: { resolve: mocks.resolveRepository },
}));

/** A fork checkout: our tracker on `origin`, somebody else's on `upstream`. */
const FORK_REMOTES = [
  { name: 'origin', url: 'https://github.com/acme/repo.git' },
  { name: 'upstream', url: 'https://github.com/upstream-org/repo.git' },
];

function createProject(remotes = FORK_REMOTES, baseRemote = 'origin') {
  return {
    gitRepository: {
      getRemotes: vi.fn().mockResolvedValue(remotes),
      getBaseRemote: vi.fn().mockResolvedValue(baseRemote),
    },
  };
}

function repositoryRefFor(url: string) {
  const nameWithOwner = url.replace('https://github.com/', '').replace(/\.git$/, '');
  const [owner, repo] = nameWithOwner.split('/');
  return ok({
    host: 'github.com',
    repositoryUrl: `https://github.com/${nameWithOwner}`,
    nameWithOwner,
    owner,
    repo,
  });
}

describe('getIssueTrackerRepositoryUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRepository.mockImplementation((url: string) => repositoryRefFor(url));
  });

  it('resolves the base remote and never looks at the other remotes', async () => {
    mocks.getProject.mockReturnValue(createProject());

    await expect(getIssueTrackerRepositoryUrl('project-1')).resolves.toBe(
      'https://github.com/acme/repo'
    );
    // The upstream remote must not even be probed — a fork's upstream tracker
    // is not a source of inbound issues.
    expect(mocks.resolveRepository).toHaveBeenCalledTimes(1);
    expect(mocks.resolveRepository).toHaveBeenCalledWith('https://github.com/acme/repo.git');
  });

  it('follows the configured base remote when it is not origin', async () => {
    mocks.getProject.mockReturnValue(createProject(FORK_REMOTES, 'upstream'));

    await expect(getIssueTrackerRepositoryUrl('project-1')).resolves.toBe(
      'https://github.com/upstream-org/repo'
    );
  });

  it('returns null when the project is not mounted', async () => {
    mocks.getProject.mockReturnValue(undefined);

    await expect(getIssueTrackerRepositoryUrl('project-1')).resolves.toBeNull();
    expect(mocks.resolveRepository).not.toHaveBeenCalled();
  });

  it('returns null when no remote matches the base remote name', async () => {
    mocks.getProject.mockReturnValue(createProject([], 'origin'));

    await expect(getIssueTrackerRepositoryUrl('project-1')).resolves.toBeNull();
    expect(mocks.resolveRepository).not.toHaveBeenCalled();
  });

  it('returns null when the base remote is not a GitHub repository', async () => {
    mocks.getProject.mockReturnValue(
      createProject([{ name: 'origin', url: 'git@gitlab.com:acme/repo.git' }])
    );
    mocks.resolveRepository.mockResolvedValue({
      success: false,
      error: { type: 'not_parseable', error: { type: 'invalid-repository-ref', input: '' } },
    });

    await expect(getIssueTrackerRepositoryUrl('project-1')).resolves.toBeNull();
  });

  it('returns null instead of throwing when reading git remotes fails', async () => {
    mocks.getProject.mockReturnValue({
      gitRepository: {
        getRemotes: vi.fn().mockRejectedValue(new Error('git exploded')),
        getBaseRemote: vi.fn().mockResolvedValue('origin'),
      },
    });

    await expect(getIssueTrackerRepositoryUrl('project-1')).resolves.toBeNull();
  });
});
