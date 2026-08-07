import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { pullRequests, tasks } from '@main/db/schema';

const TASK_A1_ID = 'aaaa0001-0000-0000-0000-000000000000';
const TASK_A2_ID = 'aaaa0002-0000-0000-0000-000000000000';

const PR_URL = 'https://github.com/example/emdash/pull/100';

describe('0024_assigned_pr', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds a nullable assigned_pr_url column on tasks', async () => {
    fixture = await openFixture('pre-0024');

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, TASK_A1_ID));
    expect(row.assignedPrUrl).toBeNull();
  });

  it('leaves every pre-existing task unassigned (null)', async () => {
    fixture = await openFixture('pre-0024');

    const rows = await fixture.db.select().from(tasks);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.assignedPrUrl).toBeNull();
    }
  });

  it('accepts a reference to a synced pull request url', async () => {
    fixture = await openFixture('pre-0024');

    await fixture.db.insert(pullRequests).values({
      url: PR_URL,
      repositoryUrl: 'https://github.com/example/emdash.git',
      baseRefName: 'main',
      baseRefOid: 'b'.repeat(40),
      headRepositoryUrl: 'https://github.com/example/emdash.git',
      headRefName: 'feat/migration-testing',
      headRefOid: 'c'.repeat(40),
      identifier: '#100',
      title: 'Improve migration test tooling',
      status: 'open',
    });
    await fixture.db
      .update(tasks)
      .set({ assignedPrUrl: PR_URL })
      .where(eq(tasks.id, TASK_A2_ID));

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, TASK_A2_ID));
    expect(row.assignedPrUrl).toBe(PR_URL);
  });

  it('enforces the foreign key to pull_requests.url', async () => {
    fixture = await openFixture('pre-0024');

    await expect(
      fixture.db
        .update(tasks)
        .set({ assignedPrUrl: 'https://github.com/example/emdash/pull/does-not-exist' })
        .where(eq(tasks.id, TASK_A1_ID))
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});
