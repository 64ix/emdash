import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateTaskBoardPosition } from './updateTaskBoardPosition';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  selectLimit: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.selectLimit,
        }),
      }),
    }),
    update: () => ({
      set: mocks.updateSet,
    }),
  },
}));

vi.mock('@main/lib/telemetry', () => ({
  telemetryService: {
    capture: mocks.capture,
  },
}));

function mockRow(overrides: { workflowStage?: string | null; boardRank?: string | null } = {}) {
  mocks.selectLimit.mockResolvedValueOnce([
    {
      id: 'task-1',
      projectId: 'project-1',
      workflowStage: overrides.workflowStage ?? null,
      boardRank: overrides.boardRank ?? null,
    },
  ]);
}

describe('updateTaskBoardPosition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.updateWhere.mockResolvedValue(undefined);
  });

  it('writes stage and rank atomically in a single update', async () => {
    mockRow({ workflowStage: null, boardRank: null });

    await updateTaskBoardPosition('task-1', 'spec', 'm');

    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ workflowStage: 'spec', boardRank: 'm' })
    );
  });

  it('captures a board_card_moved telemetry event describing the move', async () => {
    mockRow({ workflowStage: 'idea', boardRank: null });

    await updateTaskBoardPosition('task-1', 'spec', 'm');

    expect(mocks.capture).toHaveBeenCalledWith('board_card_moved', {
      from_stage: 'idea',
      to_stage: 'spec',
      reordered: false,
      project_id: 'project-1',
      task_id: 'task-1',
    });
  });

  it('reorders within a column without touching the workflow stage', async () => {
    mockRow({ workflowStage: 'spec', boardRank: 'a' });

    await updateTaskBoardPosition('task-1', 'spec', 'b');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ workflowStage: 'spec', boardRank: 'b' })
    );
    expect(mocks.capture).toHaveBeenCalledWith(
      'board_card_moved',
      expect.objectContaining({ from_stage: 'spec', to_stage: 'spec', reordered: true })
    );
  });

  it('clears the workflow stage on a drop into the Unstaged column', async () => {
    mockRow({ workflowStage: 'spec', boardRank: 'a' });

    await updateTaskBoardPosition('task-1', null, 'b');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ workflowStage: null, boardRank: 'b' })
    );
    expect(mocks.capture).toHaveBeenCalledWith(
      'board_card_moved',
      expect.objectContaining({ from_stage: 'spec', to_stage: null })
    );
  });

  it('throws when the task does not exist', async () => {
    mocks.selectLimit.mockResolvedValueOnce([]);

    await expect(updateTaskBoardPosition('missing-task', 'spec', 'm')).rejects.toThrow(
      'Task not found: missing-task'
    );
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('is a no-op when neither the stage nor the rank changes', async () => {
    mockRow({ workflowStage: 'spec', boardRank: 'm' });

    await updateTaskBoardPosition('task-1', 'spec', 'm');

    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
