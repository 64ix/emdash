import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

describe('0022 pull_requests.merged_at migration', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds the merged_at column to pull_requests', async () => {
    fixture = await openFixture('pre-0022');

    const columns = fixture.sqlite.prepare(`PRAGMA table_info(pull_requests)`).all() as {
      name: string;
    }[];

    expect(columns.map((c) => c.name)).toContain('merged_at');
  });

  it('leaves existing pull_requests rows with a null merged_at', async () => {
    fixture = await openFixture('pre-0022');

    fixture.sqlite
      .prepare(
        `INSERT INTO pull_requests (
           url, repository_url, base_ref_name, base_ref_oid,
           head_repository_url, head_ref_name, head_ref_oid, title, status
         )
         VALUES (
           'https://github.com/acme/repo/pull/1', 'https://github.com/acme/repo', 'main', 'base-oid',
           'https://github.com/acme/repo', 'feature/1', 'head-oid', 'Test PR', 'merged'
         )`
      )
      .run();

    const row = fixture.sqlite
      .prepare(`SELECT merged_at FROM pull_requests WHERE url = ?`)
      .get('https://github.com/acme/repo/pull/1') as { merged_at: string | null };

    expect(row.merged_at).toBeNull();
  });
});
