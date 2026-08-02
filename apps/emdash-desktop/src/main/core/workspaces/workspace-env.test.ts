import { describe, expect, it } from 'vitest';
import { getTaskEnvVars } from './workspace-env';

describe('getTaskEnvVars', () => {
  it('exposes EMDASH_TASK_ID so agent sessions can read the task they run in', () => {
    const env = getTaskEnvVars({
      taskId: 'task-abc-123',
      taskName: 'My Feature',
      taskPath: '/tmp/worktree',
      projectPath: '/tmp/project',
    });

    expect(env.EMDASH_TASK_ID).toBe('task-abc-123');
  });

  it('slugifies the task name but keeps the raw task id verbatim', () => {
    const env = getTaskEnvVars({
      taskId: 'TASK-ID-Should-Not-Slugify',
      taskName: 'Some Weird Name!!',
      taskPath: '/tmp/worktree',
      projectPath: '/tmp/project',
    });

    expect(env.EMDASH_TASK_ID).toBe('TASK-ID-Should-Not-Slugify');
    expect(env.EMDASH_TASK_NAME).toBe('some-weird-name');
  });
});
