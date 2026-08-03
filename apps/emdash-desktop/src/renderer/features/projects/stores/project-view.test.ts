import { describe, expect, it } from 'vitest';
import type { ProjectViewSnapshot } from '@shared/view-state';
import { ProjectViewStore } from './project-view';

describe('TaskViewStore range selection', () => {
  it('keeps the non-shift click as the range anchor', () => {
    const store = new ProjectViewStore().taskView;
    const ids = ['1', '2', '3', '4', '5'];

    store.toggleSelect('1');
    store.selectRange(ids, '5');
    store.selectRange(ids, '3');

    expect([...store.selectedIds]).toEqual(['1', '2', '3']);
    expect(store.lastSelectedId).toBe('1');
  });
});

describe('ProjectViewStore snapshots', () => {
  it('persists and restores the task sort option', () => {
    const store = new ProjectViewStore();
    store.taskView.setSortBy('pr-status');

    expect(store.snapshot.taskSortBy).toBe('pr-status');

    const restored = new ProjectViewStore();
    restored.restoreSnapshot(store.snapshot);

    expect(restored.taskView.sortBy).toBe('pr-status');
  });

  it('keeps the default task sort for an unknown persisted value', () => {
    const store = new ProjectViewStore();
    const snapshot = JSON.parse('{"taskSortBy":"future-sort"}') as Partial<ProjectViewSnapshot>;

    store.restoreSnapshot(snapshot);

    expect(store.taskView.sortBy).toBe('updated-at');
  });
});

describe('ProjectViewStore work-mode persistence (ticket #44)', () => {
  it('has no universal Board default for a project with no snapshot at all', () => {
    // A brand-new project never calls restoreSnapshot. Board must never be
    // the starting point for it, or for any project, without an explicit
    // user choice.
    expect(new ProjectViewStore().activeView).toBe('tasks');
  });

  it('persists and restores an explicit Board selection', () => {
    const store = new ProjectViewStore();
    store.setProjectView('board');

    expect(store.snapshot.activeView).toBe('board');

    const restored = new ProjectViewStore();
    restored.restoreSnapshot(store.snapshot);

    expect(restored.activeView).toBe('board');
  });

  it('loads a snapshot written before Board existed and keeps its previous default', () => {
    // Snapshots predating Board only ever carried these three values — never
    // 'board' — and must go on being honored exactly as before.
    const legacySnapshot: Partial<ProjectViewSnapshot> = {
      activeView: 'pull-request',
      taskViewTab: 'active',
    };

    const store = new ProjectViewStore();
    store.restoreSnapshot(legacySnapshot);

    expect(store.activeView).toBe('pull-request');
  });

  it('keeps the default work mode for a snapshot missing activeView entirely', () => {
    const store = new ProjectViewStore();
    store.restoreSnapshot({ taskViewTab: 'archived' });

    expect(store.activeView).toBe('tasks');
  });

  it('ignores an unknown future activeView value instead of throwing', () => {
    const store = new ProjectViewStore();
    const snapshot = JSON.parse('{"activeView":"timeline"}') as Partial<ProjectViewSnapshot>;

    expect(() => store.restoreSnapshot(snapshot)).not.toThrow();
    expect(store.activeView).toBe('tasks');
  });
});
