import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projectRemotes, projects, tasks } from '@main/db/schema';
import type { LinkSuggestion } from '@shared/core/issues/link-suggestion';
import {
  acceptLinkSuggestion,
  dismissLinkSuggestion,
  getLinkSuggestionsForProject,
} from './link-suggestions-service';
import { setCachedSuggestionsIfChanged } from './link-suggestions-store';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
  getProject: vi.fn(),
  resolveRepository: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));

vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: mocks.getProject },
}));

vi.mock('@main/core/github/services/github-repository-resolver', () => ({
  githubRepositoryResolver: { resolve: mocks.resolveRepository },
}));

const PROJECT_ID = 'project-1';
const REPOSITORY_URL = 'https://github.com/acme/repo';
/** A fork's upstream tracker — cached, but never ours to suggest links from. */
const UPSTREAM_REPOSITORY_URL = 'https://github.com/upstream-org/repo';

function makeSuggestion(repositoryUrl = REPOSITORY_URL, number = 1): LinkSuggestion {
  return {
    id: `${repositoryUrl}/issues/${number}`,
    role: 'spec',
    issue: {
      provider: 'github',
      identifier: `#${number}`,
      title: '[Spec] Feature',
      url: `${repositoryUrl}/issues/${number}`,
      status: 'open',
    },
  };
}

describe('link-suggestions-service', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();
    // A fork checkout: our tracker on `origin`, somebody else's on `upstream`.
    mocks.getProject.mockReturnValue({
      gitRepository: {
        getRemotes: vi.fn().mockResolvedValue([
          { name: 'origin', url: `${REPOSITORY_URL}.git` },
          { name: 'upstream', url: `${UPSTREAM_REPOSITORY_URL}.git` },
        ]),
        getBaseRemote: vi.fn().mockResolvedValue('origin'),
      },
    });
    mocks.resolveRepository.mockImplementation((url: string) => {
      const nameWithOwner = url.replace('https://github.com/', '').replace(/\.git$/, '');
      const [owner, repo] = nameWithOwner.split('/');
      return Promise.resolve({
        success: true,
        data: {
          host: 'github.com',
          repositoryUrl: `https://github.com/${nameWithOwner}`,
          nameWithOwner,
          owner,
          repo,
        },
      });
    });

    await fixture.db.insert(projects).values({ id: PROJECT_ID, name: 'Project', path: '/repo' });
    await fixture.db.insert(projectRemotes).values([
      { projectId: PROJECT_ID, remoteName: 'origin', remoteUrl: REPOSITORY_URL },
      { projectId: PROJECT_ID, remoteName: 'upstream', remoteUrl: UPSTREAM_REPOSITORY_URL },
    ]);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('attaches the role and derives the stage from an unstaged task', async () => {
    await fixture.db
      .insert(tasks)
      .values({ id: 'task-1', projectId: PROJECT_ID, name: 'Task 1', status: 'in_progress' });
    const suggestion = makeSuggestion();
    await setCachedSuggestionsIfChanged(PROJECT_ID, REPOSITORY_URL, [suggestion]);

    await acceptLinkSuggestion(PROJECT_ID, 'task-1', suggestion);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row?.linkedIssues?.spec?.url).toBe(suggestion.issue.url);
    expect(row?.workflowStage).toBe('spec');
    expect(await getLinkSuggestionsForProject(PROJECT_ID)).toEqual([]);
  });

  it('does not regress a stage already advanced past what the suggestion can prove', async () => {
    await fixture.db.insert(tasks).values({
      id: 'task-1',
      projectId: PROJECT_ID,
      name: 'Task 1',
      status: 'in_progress',
      workflowStage: 'shipped',
    });
    const suggestion = makeSuggestion();
    await setCachedSuggestionsIfChanged(PROJECT_ID, REPOSITORY_URL, [suggestion]);

    await acceptLinkSuggestion(PROJECT_ID, 'task-1', suggestion);

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row?.linkedIssues?.spec?.url).toBe(suggestion.issue.url);
    expect(row?.workflowStage).toBe('shipped');
  });

  it('dismisses a suggestion so it never returns', async () => {
    const suggestion = makeSuggestion();
    await setCachedSuggestionsIfChanged(PROJECT_ID, REPOSITORY_URL, [suggestion]);

    await dismissLinkSuggestion(PROJECT_ID, suggestion);

    expect(await getLinkSuggestionsForProject(PROJECT_ID)).toEqual([]);
  });

  it('surfaces only the base remote tracker, never a fork upstream', async () => {
    const ours = makeSuggestion();
    const theirs = makeSuggestion(UPSTREAM_REPOSITORY_URL, 99);
    await setCachedSuggestionsIfChanged(PROJECT_ID, REPOSITORY_URL, [ours]);
    await setCachedSuggestionsIfChanged(PROJECT_ID, UPSTREAM_REPOSITORY_URL, [theirs]);

    expect(await getLinkSuggestionsForProject(PROJECT_ID)).toEqual([ours]);
  });
});
