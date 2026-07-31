import { describe, expect, it } from 'vitest';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';
import { adjacentStage, COLUMNS, STAGE_LABELS, stageOf } from './board-columns';

function makeTask(workflowStage?: WorkflowStage): Task {
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
    prs: [],
    conversations: {},
    type: 'task',
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
