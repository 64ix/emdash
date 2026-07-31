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

const PROJECT_ID = 'project-1';
const REPOSITORY_URL = 'https://github.com/acme/repo';

function makeSuggestion(overrides: Partial<LinkSuggestion> = {}): LinkSuggestion {
  return {
    id: `${REPOSITORY_URL}/issues/1`,
    role: 'spec',
    issue: {
      provider: 'github',
      identifier: '#1',
      title: '[Spec] Feature',
      url: `${REPOSITORY_URL}/issues/1`,
      status: 'open',
    },
    ...overrides,
  };
}

describe('link-suggestions-service', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();

    await fixture.db.insert(projects).values({ id: PROJECT_ID, name: 'Project', path: '/repo' });
    await fixture.db
      .insert(projectRemotes)
      .values({ projectId: PROJECT_ID, remoteName: 'origin', remoteUrl: REPOSITORY_URL });
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
});
