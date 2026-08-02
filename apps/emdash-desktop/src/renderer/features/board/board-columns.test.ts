import { describe, expect, it } from 'vitest';
import { SHIPPED_FADE_WINDOW_MS } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';
import { isBoardDisplayable, isTaskShippedFaded, STAGE_LABELS } from './board-columns';
import { COLUMNS, stageOf } from './board-ordering';

function makeTask(
  workflowStage?: WorkflowStage,
  prs: PullRequest[] = [],
  overrides: Partial<Task> = {}
): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    name: 'Example task',
    status: 'todo',
    workflowStage,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    prs,
    conversations: {},
    type: 'task',
    ...overrides,
  };
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRepositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'feature',
    headRefOid: 'head',
    identifier: '#1',
    title: 'Test PR',
    description: null,
    status: 'merged',
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus: null,
    mergeStateStatus: null,
    reviewDecision: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergedAt: null,
    author: null,
    labels: [],
    assignees: [],
    checks: [],
    ...overrides,
  };
}

describe('COLUMNS', () => {
  it('orders the leading Unstaged bucket before the new pipeline, with Triage trailing', () => {
    expect(COLUMNS).toEqual([
      'unstaged',
      'idea',
      'exploring',
      'spec',
      'implementing',
      'review',
      'shipped',
      'triage',
    ]);
  });

  it('has a label for every column matching the glossary vocabulary', () => {
    for (const column of COLUMNS) {
      expect(STAGE_LABELS[column]).toBeTruthy();
    }
    expect(STAGE_LABELS.unstaged).toBe('Unstaged');
    expect(STAGE_LABELS.idea).toBe('Idea');
    expect(STAGE_LABELS.exploring).toBe('Exploring');
    expect(STAGE_LABELS.spec).toBe('Spec');
    expect(STAGE_LABELS.implementing).toBe('Implementing');
    expect(STAGE_LABELS.review).toBe('Review');
    expect(STAGE_LABELS.shipped).toBe('Shipped');
    expect(STAGE_LABELS.triage).toBe('Triage');
  });
});

describe('stageOf', () => {
  it('returns "unstaged" for a task with no workflow stage', () => {
    expect(stageOf(makeTask(undefined))).toBe('unstaged');
  });

  it('returns the task workflow stage when set', () => {
    expect(stageOf(makeTask('spec'))).toBe('spec');
    expect(stageOf(makeTask('triage'))).toBe('triage');
  });
});

describe('isTaskShippedFaded', () => {
  const now = new Date('2026-07-31T00:00:00.000Z').getTime();

  it('is false for a non-shipped task, regardless of merged PRs', () => {
    const oldMergedAt = new Date(now - SHIPPED_FADE_WINDOW_MS - 1000).toISOString();
    const task = makeTask('review', [makePr({ status: 'merged', mergedAt: oldMergedAt })]);
    expect(isTaskShippedFaded(task, now)).toBe(false);
  });

  it('is false for a shipped task with no merged PR loaded yet', () => {
    expect(isTaskShippedFaded(makeTask('shipped', []), now)).toBe(false);
  });

  it('is false for a shipped task merged within the fade window', () => {
    const recentMergedAt = new Date(now - (SHIPPED_FADE_WINDOW_MS - 1000)).toISOString();
    const task = makeTask('shipped', [makePr({ status: 'merged', mergedAt: recentMergedAt })]);
    expect(isTaskShippedFaded(task, now)).toBe(false);
  });

  it('is true for a shipped task merged more than the fade window ago', () => {
    const oldMergedAt = new Date(now - (SHIPPED_FADE_WINDOW_MS + 1000)).toISOString();
    const task = makeTask('shipped', [makePr({ status: 'merged', mergedAt: oldMergedAt })]);
    expect(isTaskShippedFaded(task, now)).toBe(true);
  });

  it('uses the most recently merged PR when a task has more than one', () => {
    const oldMergedAt = new Date(now - (SHIPPED_FADE_WINDOW_MS + 1000)).toISOString();
    const recentMergedAt = new Date(now - 1000).toISOString();
    const task = makeTask('shipped', [
      makePr({
        url: 'https://github.com/acme/repo/pull/1',
        status: 'merged',
        mergedAt: oldMergedAt,
      }),
      makePr({
        url: 'https://github.com/acme/repo/pull/2',
        status: 'merged',
        mergedAt: recentMergedAt,
      }),
    ]);
    expect(isTaskShippedFaded(task, now)).toBe(false);
  });
});

describe('isBoardDisplayable', () => {
  const now = new Date('2026-07-31T00:00:00.000Z').getTime();

  it('is true for a plain, non-archived task', () => {
    expect(isBoardDisplayable(makeTask('spec'))).toBe(true);
  });

  it('is false for an archived task', () => {
    const task = makeTask('spec', [], { archivedAt: '2026-01-02T00:00:00.000Z' });
    expect(isBoardDisplayable(task)).toBe(false);
  });

  it('is false for a non-task row (e.g. an automation run)', () => {
    const task = makeTask('spec', [], { type: 'automation-run' });
    expect(isBoardDisplayable(task)).toBe(false);
  });

  it('is false for a shipped task faded out past the Shipped Fade window', () => {
    const oldMergedAt = new Date(now - (SHIPPED_FADE_WINDOW_MS + 1000)).toISOString();
    const task = makeTask('shipped', [makePr({ status: 'merged', mergedAt: oldMergedAt })]);
    expect(isBoardDisplayable(task, now)).toBe(false);
  });

  it('is true for a shipped task still inside the Shipped Fade window', () => {
    const recentMergedAt = new Date(now - (SHIPPED_FADE_WINDOW_MS - 1000)).toISOString();
    const task = makeTask('shipped', [makePr({ status: 'merged', mergedAt: recentMergedAt })]);
    expect(isBoardDisplayable(task, now)).toBe(true);
  });
});
