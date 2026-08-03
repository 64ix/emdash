import { describe, expect, it } from 'vitest';
import { activeProjectIdForView } from './active-project';

const params = {
  task: 'proj-task',
  project: 'proj-project',
  board: 'proj-board',
};

describe('activeProjectIdForView', () => {
  it('resolves the project from task params while on the task view', () => {
    expect(activeProjectIdForView('task', params)).toBe('proj-task');
  });

  it('resolves the project from project params while on the project view', () => {
    expect(activeProjectIdForView('project', params)).toBe('proj-project');
  });

  it('resolves the project from board params while on the board view (ticket #43)', () => {
    expect(activeProjectIdForView('board', params)).toBe('proj-board');
  });

  it('is undefined for views with no project scope', () => {
    expect(activeProjectIdForView('home', params)).toBeUndefined();
    expect(activeProjectIdForView('settings', params)).toBeUndefined();
    expect(activeProjectIdForView('library', params)).toBeUndefined();
  });

  it('is undefined when the scoped view has no projectId param yet', () => {
    expect(
      activeProjectIdForView('board', { task: undefined, project: undefined, board: undefined })
    ).toBeUndefined();
  });
});
