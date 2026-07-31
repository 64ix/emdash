import { ok } from '@emdash/shared';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projects, pullRequests, tasks, workspaces } from '@main/db/schema';
import {
  ghostCardsUpdatedChannel,
  linkSuggestionsUpdatedChannel,
} from '@shared/core/issues/issueEvents';
import {
  taskLinkedIssueRoleUpdatedChannel,
  taskWorkflowStageUpdatedChannel,
} from '@shared/core/tasks/taskEvents';
import { getCachedGhostCards, rejectGhostCardUrl } from './ghost-card-store';
import type { GitHubIssuesClient, RemoteIssue } from './github-issues-client';
import { IssuesSyncEngine } from './issues-sync-engine';
import { dismissLinkSuggestionUrl, getCachedSuggestions } from './link-suggestions-store';

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

// The engine only depends on `getGitHubIssuesClient` to build its default
// singleton export — tests construct `IssuesSyncEngine` directly with a fake
// client, so this only needs to exist to satisfy the module's static import.
vi.mock('./github-issues-client', () => ({ getGitHubIssuesClient: vi.fn() }));

const PROJECT_ID = 'project-1';
const REPOSITORY_URL = 'https://github.com/acme/repo';

class FakeGitHubIssuesClient implements GitHubIssuesClient {
  constructor(
    private readonly issuesByNumber: Map<number, RemoteIssue>,
    private readonly mapIssues: RemoteIssue[] = [],
    private readonly specIssues: RemoteIssue[] = [],
    private readonly rootIssues: RemoteIssue[] = []
  ) {}

  async getIssue(_repo: unknown, number: number): Promise<RemoteIssue | null> {
    return this.issuesByNumber.get(number) ?? null;
  }
  async listMapIssues(): Promise<RemoteIssue[]> {
    return this.mapIssues;
  }
  async listSpecIssues(): Promise<RemoteIssue[]> {
    return this.specIssues;
  }
  async listOpenRootIssues(): Promise<RemoteIssue[]> {
    return this.rootIssues;
  }
}

function makeIssue(overrides: Partial<RemoteIssue> = {}): RemoteIssue {
  return {
    number: 1,
    url: `${REPOSITORY_URL}/issues/1`,
    title: '[Spec] Feature',
    body: null,
    state: 'open',
    labels: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEngine(client: GitHubIssuesClient): IssuesSyncEngine {
  return new IssuesSyncEngine(async () => ok(client));
}

describe('IssuesSyncEngine', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();

    await fixture.db.insert(projects).values({
      id: PROJECT_ID,
      name: 'Project',
      path: '/repo',
    });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  async function insertTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
    const [row] = await fixture.db
      .insert(tasks)
      .values({
        id: 'task-1',
        projectId: PROJECT_ID,
        name: 'Task 1',
        status: 'in_progress',
        ...overrides,
      })
      .returning();
    return row!;
  }

  it('attaches the Spec role via a valid Task Marker and derives the spec stage', async () => {
    await insertTask();
    const issue = makeIssue({
      number: 10,
      url: `${REPOSITORY_URL}/issues/10`,
      title: '[Spec] Feature X',
      body: 'Some spec content.\n\nEmdash-Task: task-1',
      state: 'open',
    });
    const client = new FakeGitHubIssuesClient(new Map(), [], [issue]);

    const result = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

    expect(result).toEqual(
      ok({
        stageChanges: 1,
        roleAttachments: 1,
        suggestionsChanged: false,
        ghostCardsChanged: false,
      })
    );

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row?.linkedIssues?.spec?.url).toBe(issue.url);
    expect(row?.workflowStage).toBe('spec');

    expect(mocks.emit).toHaveBeenCalledWith(
      taskLinkedIssueRoleUpdatedChannel,
      expect.objectContaining({ taskId: 'task-1', role: 'spec' })
    );
    expect(mocks.emit).toHaveBeenCalledWith(
      taskWorkflowStageUpdatedChannel,
      expect.objectContaining({ taskId: 'task-1', stage: 'spec' })
    );
  });

  it('attaches the Map role via a valid Task Marker and derives the exploring stage', async () => {
    await insertTask();
    const issue = makeIssue({
      number: 11,
      url: `${REPOSITORY_URL}/issues/11`,
      title: 'Explore feature X',
      labels: ['wayfinder:map'],
      body: 'Exploration notes.\nEmdash-Task: task-1',
      state: 'open',
    });
    const client = new FakeGitHubIssuesClient(new Map(), [issue], []);

    const result = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

    expect(result).toEqual(
      ok({
        stageChanges: 1,
        roleAttachments: 1,
        suggestionsChanged: false,
        ghostCardsChanged: false,
      })
    );

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row?.linkedIssues?.map?.url).toBe(issue.url);
    expect(row?.workflowStage).toBe('exploring');
  });

  it('ignores a Task Marker pointing at an unknown task safely, with no attach and no suggestion', async () => {
    const issue = makeIssue({
      number: 12,
      url: `${REPOSITORY_URL}/issues/12`,
      title: '[Spec] Orphaned by a bad marker',
      body: 'Emdash-Task: does-not-exist',
      state: 'open',
    });
    const client = new FakeGitHubIssuesClient(new Map(), [], [issue]);

    const result = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

    expect(result).toEqual(
      ok({
        stageChanges: 0,
        roleAttachments: 0,
        suggestionsChanged: false,
        ghostCardsChanged: false,
      })
    );
    expect(await getCachedSuggestions(PROJECT_ID, REPOSITORY_URL)).toEqual([]);
  });

  it('surfaces an orphan Spec-shaped issue with no marker as a link suggestion, and hides it once dismissed', async () => {
    const issue = makeIssue({
      number: 13,
      url: `${REPOSITORY_URL}/issues/13`,
      title: '[Spec] Unclaimed feature',
      body: null,
      state: 'open',
    });
    const client = new FakeGitHubIssuesClient(new Map(), [], [issue]);

    const first = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);
    expect(first).toEqual(
      ok({
        stageChanges: 0,
        roleAttachments: 0,
        suggestionsChanged: true,
        ghostCardsChanged: false,
      })
    );
    expect(await getCachedSuggestions(PROJECT_ID, REPOSITORY_URL)).toEqual([
      { id: issue.url, role: 'spec', issue: expect.objectContaining({ url: issue.url }) },
    ]);
    expect(mocks.emit).toHaveBeenCalledWith(
      linkSuggestionsUpdatedChannel,
      expect.objectContaining({ projectId: PROJECT_ID, repositoryUrl: REPOSITORY_URL })
    );

    await dismissLinkSuggestionUrl(PROJECT_ID, REPOSITORY_URL, issue.url);
    mocks.emit.mockClear();

    const second = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);
    expect(second).toEqual(
      ok({
        stageChanges: 0,
        roleAttachments: 0,
        suggestionsChanged: true,
        ghostCardsChanged: false,
      })
    );
    expect(await getCachedSuggestions(PROJECT_ID, REPOSITORY_URL)).toEqual([]);
  });

  it('derives triage when a linked Spec closes without a merged PR', async () => {
    await insertTask({
      workflowStage: 'spec',
      linkedIssues: {
        version: '1',
        spec: {
          provider: 'github',
          identifier: '#20',
          title: '[Spec] Feature',
          url: `${REPOSITORY_URL}/issues/20`,
          status: 'open',
        },
      },
    });
    const issue = makeIssue({ number: 20, url: `${REPOSITORY_URL}/issues/20`, state: 'closed' });
    const client = new FakeGitHubIssuesClient(new Map([[20, issue]]));

    const result = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

    expect(result).toEqual(
      ok({
        stageChanges: 1,
        roleAttachments: 0,
        suggestionsChanged: false,
        ghostCardsChanged: false,
      })
    );
    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row?.workflowStage).toBe('triage');
  });

  it('leaves the stage untouched when a linked Spec closes with a merged PR (owned by PR-fact derivation)', async () => {
    const [workspace] = await fixture.db
      .insert(workspaces)
      .values({ id: 'workspace-1', type: 'local', branchName: 'feature/x' })
      .returning();
    await insertTask({
      workflowStage: 'shipped',
      workspaceId: workspace!.id,
      linkedIssues: {
        version: '1',
        spec: {
          provider: 'github',
          identifier: '#21',
          title: '[Spec] Feature',
          url: `${REPOSITORY_URL}/issues/21`,
          status: 'open',
        },
      },
    });
    await fixture.db.insert(pullRequests).values({
      url: `${REPOSITORY_URL}/pull/1`,
      repositoryUrl: REPOSITORY_URL,
      baseRefName: 'main',
      baseRefOid: 'base-oid',
      headRepositoryUrl: REPOSITORY_URL,
      headRefName: 'feature/x',
      headRefOid: 'head-oid',
      identifier: '#1',
      title: 'Ship feature X',
      status: 'merged',
    });
    const issue = makeIssue({ number: 21, url: `${REPOSITORY_URL}/issues/21`, state: 'closed' });
    const client = new FakeGitHubIssuesClient(new Map([[21, issue]]));

    const result = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

    expect(result).toEqual(
      ok({
        stageChanges: 0,
        roleAttachments: 0,
        suggestionsChanged: false,
        ghostCardsChanged: false,
      })
    );
    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row?.workflowStage).toBe('shipped');
    expect(mocks.emit).not.toHaveBeenCalledWith(taskWorkflowStageUpdatedChannel, expect.anything());
  });

  it('never auto-moves a task out of triage even when its Spec reopens', async () => {
    await insertTask({
      workflowStage: 'triage',
      linkedIssues: {
        version: '1',
        spec: {
          provider: 'github',
          identifier: '#22',
          title: '[Spec] Feature',
          url: `${REPOSITORY_URL}/issues/22`,
          status: 'closed',
        },
      },
    });
    const issue = makeIssue({ number: 22, url: `${REPOSITORY_URL}/issues/22`, state: 'open' });
    const client = new FakeGitHubIssuesClient(new Map([[22, issue]]));

    const result = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

    expect(result).toEqual(
      ok({
        stageChanges: 0,
        roleAttachments: 0,
        suggestionsChanged: false,
        ghostCardsChanged: false,
      })
    );
    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task-1'));
    expect(row?.workflowStage).toBe('triage');
  });

  it('is idempotent: an unchanged GitHub state produces no writes and no events on a second pass', async () => {
    await insertTask();
    const issue = makeIssue({
      number: 30,
      url: `${REPOSITORY_URL}/issues/30`,
      title: '[Spec] Feature X',
      body: 'Emdash-Task: task-1',
      state: 'open',
    });
    const client = new FakeGitHubIssuesClient(new Map([[30, issue]]), [], [issue]);
    const engine = makeEngine(client);

    const first = await engine.sync(PROJECT_ID, REPOSITORY_URL);
    expect(first).toEqual(
      ok({
        stageChanges: 1,
        roleAttachments: 1,
        suggestionsChanged: false,
        ghostCardsChanged: false,
      })
    );

    mocks.emit.mockClear();
    const second = await engine.sync(PROJECT_ID, REPOSITORY_URL);

    expect(second).toEqual(
      ok({
        stageChanges: 0,
        roleAttachments: 0,
        suggestionsChanged: false,
        ghostCardsChanged: false,
      })
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  describe('Ghost Cards (ticket #9)', () => {
    function makeRootIssue(overrides: Partial<RemoteIssue> = {}): RemoteIssue {
      return makeIssue({
        number: 40,
        url: `${REPOSITORY_URL}/issues/40`,
        title: 'Fix the login bug',
        labels: [],
        body: null,
        state: 'open',
        ...overrides,
      });
    }

    it('surfaces a plain open root issue with no shape and no marker as a Ghost Card', async () => {
      const issue = makeRootIssue();
      const client = new FakeGitHubIssuesClient(new Map(), [], [], [issue]);

      const result = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

      expect(result).toEqual(
        ok({
          stageChanges: 0,
          roleAttachments: 0,
          suggestionsChanged: false,
          ghostCardsChanged: true,
        })
      );
      expect(await getCachedGhostCards(PROJECT_ID, REPOSITORY_URL)).toEqual([
        { id: issue.url, issue: expect.objectContaining({ url: issue.url, title: issue.title }) },
      ]);
      expect(mocks.emit).toHaveBeenCalledWith(
        ghostCardsUpdatedChannel,
        expect.objectContaining({ projectId: PROJECT_ID, repositoryUrl: REPOSITORY_URL })
      );
    });

    it('excludes a [Spec]-titled issue', async () => {
      const issue = makeRootIssue({ title: '[Spec] Some feature' });
      const client = new FakeGitHubIssuesClient(new Map(), [], [], [issue]);

      const result = await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

      expect(result.success && result.data.ghostCardsChanged).toBe(false);
      expect(await getCachedGhostCards(PROJECT_ID, REPOSITORY_URL)).toEqual([]);
    });

    it('excludes any wayfinder:*-labelled issue, not just wayfinder:map', async () => {
      const issue = makeRootIssue({ labels: ['wayfinder:research'] });
      const client = new FakeGitHubIssuesClient(new Map(), [], [], [issue]);

      await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

      expect(await getCachedGhostCards(PROJECT_ID, REPOSITORY_URL)).toEqual([]);
    });

    it('excludes an issue carrying a Task Marker, even one pointing at an unknown task', async () => {
      const issue = makeRootIssue({ body: 'Emdash-Task: does-not-exist' });
      const client = new FakeGitHubIssuesClient(new Map(), [], [], [issue]);

      await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

      expect(await getCachedGhostCards(PROJECT_ID, REPOSITORY_URL)).toEqual([]);
    });

    it('excludes an issue already referenced by a task (Origin role)', async () => {
      const issue = makeRootIssue();
      await insertTask({
        linkedIssues: {
          version: '1',
          origin: {
            provider: 'github',
            identifier: '#40',
            title: issue.title,
            url: issue.url,
            status: 'open',
          },
        },
      });
      const client = new FakeGitHubIssuesClient(new Map(), [], [], [issue]);

      await makeEngine(client).sync(PROJECT_ID, REPOSITORY_URL);

      expect(await getCachedGhostCards(PROJECT_ID, REPOSITORY_URL)).toEqual([]);
    });

    it('never resurfaces a rejected Ghost Card on a later sync pass', async () => {
      const issue = makeRootIssue();
      const client = new FakeGitHubIssuesClient(new Map(), [], [], [issue]);
      const engine = makeEngine(client);

      const first = await engine.sync(PROJECT_ID, REPOSITORY_URL);
      expect(first.success && first.data.ghostCardsChanged).toBe(true);

      await rejectGhostCardUrl(PROJECT_ID, REPOSITORY_URL, issue.url);
      mocks.emit.mockClear();

      const second = await engine.sync(PROJECT_ID, REPOSITORY_URL);
      expect(second).toEqual(
        ok({
          stageChanges: 0,
          roleAttachments: 0,
          suggestionsChanged: false,
          ghostCardsChanged: true,
        })
      );
      expect(await getCachedGhostCards(PROJECT_ID, REPOSITORY_URL)).toEqual([]);
    });

    it('is idempotent: an unchanged set of root issues produces no cache write and no event on a second pass', async () => {
      const issue = makeRootIssue();
      const client = new FakeGitHubIssuesClient(new Map(), [], [], [issue]);
      const engine = makeEngine(client);

      await engine.sync(PROJECT_ID, REPOSITORY_URL);
      mocks.emit.mockClear();

      const second = await engine.sync(PROJECT_ID, REPOSITORY_URL);
      expect(second.success && second.data.ghostCardsChanged).toBe(false);
      expect(mocks.emit).not.toHaveBeenCalledWith(ghostCardsUpdatedChannel, expect.anything());
    });
  });
});
