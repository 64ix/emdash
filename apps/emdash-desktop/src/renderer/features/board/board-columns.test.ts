import { describe, expect, it } from 'vitest';
import { SHIPPED_FADE_WINDOW_MS } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';
import { adjacentStage, COLUMNS, isTaskShippedFaded, STAGE_LABELS, stageOf } from './board-columns';

function makeTask(workflowStage?: WorkflowStage, prs: PullRequest[] = []): Task {
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

describe('adjacentStage', () => {
  it('walks the pipeline forward one column at a time', () => {
    expect(adjacentStage('unstaged', 1)).toBe('idea');
    expect(adjacentStage('idea', 1)).toBe('exploring');
    expect(adjacentStage('exploring', 1)).toBe('spec');
    expect(adjacentStage('spec', 1)).toBe('implementing');
    expect(adjacentStage('implementing', 1)).toBe('review');
    expect(adjacentStage('review', 1)).toBe('shipped');
    expect(adjacentStage('shipped', 1)).toBe('triage');
  });

  it('walks the pipeline backward one column at a time', () => {
    expect(adjacentStage('triage', -1)).toBe('shipped');
    expect(adjacentStage('shipped', -1)).toBe('review');
    expect(adjacentStage('idea', -1)).toBe('unstaged');
  });

  it('returns null past the leading edge (Unstaged)', () => {
    expect(adjacentStage('unstaged', -1)).toBeNull();
  });

  it('returns null past the trailing edge (Triage)', () => {
    expect(adjacentStage('triage', 1)).toBeNull();
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
