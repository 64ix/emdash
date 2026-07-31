import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projectRemotes, projects, tasks } from '@main/db/schema';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import { adoptGhostCard, getGhostCardsForProject, rejectGhostCard } from './ghost-card-service';
import { getCachedGhostCards, setCachedGhostCardsIfChanged } from './ghost-card-store';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
  getProject: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));

vi.mock('@main/lib/logger', () => {
  // task-service's import graph reaches app-scope, which derives scoped
  // loggers via log.child(...) at module load — the mock must support it.
  const makeLog = (): Record<string, unknown> => {
    const log: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    log.child = vi.fn(() => makeLog());
    return log;
  };
  return { log: makeLog() };
});

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: mocks.getProject },
}));

const PROJECT_ID = 'project-1';
const REPOSITORY_URL = 'https://github.com/acme/repo';

function makeGhostCard(overrides: Partial<GhostCard> = {}): GhostCard {
  return {
    id: `${REPOSITORY_URL}/issues/40`,
    issue: {
      provider: 'github',
      identifier: '#40',
      title: 'Fix the login bug',
      url: `${REPOSITORY_URL}/issues/40`,
      status: 'open',
    },
    ...overrides,
  };
}

describe('ghost-card-service', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();
    mocks.getProject.mockReturnValue({});

    await fixture.db.insert(projects).values({
      id: PROJECT_ID,
      name: 'Project',
      path: '/repo',
      repositoryWorkspaceId: 'ws-repo-1',
    });
    await fixture.db
      .insert(projectRemotes)
      .values({ projectId: PROJECT_ID, remoteName: 'origin', remoteUrl: REPOSITORY_URL });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('surfaces no task row before adoption for a cached Ghost Card', async () => {
    const ghostCard = makeGhostCard();
    await setCachedGhostCardsIfChanged(PROJECT_ID, REPOSITORY_URL, [ghostCard]);

    expect(await getGhostCardsForProject(PROJECT_ID)).toEqual([ghostCard]);
    expect(await fixture.db.select().from(tasks)).toEqual([]);
  });

  it('adopts a Ghost Card: creates a task with Origin set, lands it in idea, and removes the card', async () => {
    const ghostCard = makeGhostCard();
    await setCachedGhostCardsIfChanged(PROJECT_ID, REPOSITORY_URL, [ghostCard]);

    const result = await adoptGhostCard(PROJECT_ID, ghostCard);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, result.data.task.id));
    expect(row?.linkedIssues?.origin?.url).toBe(ghostCard.issue.url);
    expect(row?.workflowStage).toBe('idea');
    // Reuses the project's repository workspace — no new worktree/workspace is provisioned.
    expect(row?.workspaceId).toBe('ws-repo-1');

    expect(await getGhostCardsForProject(PROJECT_ID)).toEqual([]);
  });

  it('rejects a Ghost Card: persists only the rejection, no task row, and it never returns', async () => {
    const ghostCard = makeGhostCard();
    await setCachedGhostCardsIfChanged(PROJECT_ID, REPOSITORY_URL, [ghostCard]);

    await rejectGhostCard(PROJECT_ID, ghostCard);

    expect(await getGhostCardsForProject(PROJECT_ID)).toEqual([]);
    expect(await fixture.db.select().from(tasks)).toEqual([]);

    // A later sync-style re-add attempt (e.g. a fresh cache write from a sync
    // pass that hasn't yet observed the rejection) still yields no surfaced
    // card once the rejection is consulted by the caller — verified at the
    // engine level in issues-sync-engine.db.test.ts. Here we only assert the
    // service-level cache no longer carries it.
    expect(await getCachedGhostCards(PROJECT_ID, REPOSITORY_URL)).toEqual([]);
  });
});
