import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { tasks } from '@main/db/schema';

const TASK_A1_ID = 'aaaa0001-0000-0000-0000-000000000000'; // pre-migration: grilled
const TASK_A2_ID = 'aaaa0002-0000-0000-0000-000000000000'; // pre-migration: tickets
const TASK_A3_ID = 'aaaa0003-0000-0000-0000-000000000000'; // pre-migration: pr
const TASK_B1_ID = 'bbbb0001-0000-0000-0000-000000000000'; // pre-migration: unstaged (null)

describe('0023_workflow_stage_migration', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('rewrites grilled -> idea', async () => {
    fixture = await openFixture('pre-0023');

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, TASK_A1_ID));
    expect(row.workflowStage).toBe('idea');
  });

  it('rewrites tickets -> spec', async () => {
    fixture = await openFixture('pre-0023');

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, TASK_A2_ID));
    expect(row.workflowStage).toBe('spec');
  });

  it('rewrites pr -> review', async () => {
    fixture = await openFixture('pre-0023');

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, TASK_A3_ID));
    expect(row.workflowStage).toBe('review');
  });

  it('leaves Unstaged (null) tasks unchanged', async () => {
    fixture = await openFixture('pre-0023');

    const [row] = await fixture.db.select().from(tasks).where(eq(tasks.id, TASK_B1_ID));
    expect(row.workflowStage).toBeNull();
  });
});
