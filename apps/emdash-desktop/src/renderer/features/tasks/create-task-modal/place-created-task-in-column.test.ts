import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import {
  placeCreatedTaskInColumn,
  type RegistrationAwareTaskStore,
} from './place-created-task-in-column';

function makeFakeStore(
  overrides: Partial<{ state: RegistrationAwareTaskStore['state']; phase: string | null }> = {}
): RegistrationAwareTaskStore & { updateBoardPosition: ReturnType<typeof vi.fn> } {
  return observable({
    state: 'unregistered' as RegistrationAwareTaskStore['state'],
    phase: 'creating' as string | null,
    ...overrides,
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
  });
}

describe('placeCreatedTaskInColumn', () => {
  it('does nothing while the task is still unregistered', async () => {
    const store = makeFakeStore();
    placeCreatedTaskInColumn({ tasks: new Map([['t1', store]]) }, 't1', 'idea');

    await Promise.resolve();
    expect(store.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('writes the column stage with no rank once the task registers', async () => {
    const store = makeFakeStore();
    placeCreatedTaskInColumn({ tasks: new Map([['t1', store]]) }, 't1', 'idea');

    runInAction(() => {
      store.state = 'unprovisioned';
    });
    await Promise.resolve();

    expect(store.updateBoardPosition).toHaveBeenCalledTimes(1);
    expect(store.updateBoardPosition).toHaveBeenCalledWith('idea', null);
  });

  it('places into implementing when that is the eligible column', async () => {
    const store = makeFakeStore();
    placeCreatedTaskInColumn({ tasks: new Map([['t1', store]]) }, 't1', 'implementing');

    runInAction(() => {
      store.state = 'provisioned';
    });
    await Promise.resolve();

    expect(store.updateBoardPosition).toHaveBeenCalledWith('implementing', null);
  });

  it('bails out without writing anything on a permanent creation failure', async () => {
    const store = makeFakeStore();
    placeCreatedTaskInColumn({ tasks: new Map([['t1', store]]) }, 't1', 'idea');

    runInAction(() => {
      store.phase = 'create-error';
    });
    await Promise.resolve();

    expect(store.updateBoardPosition).not.toHaveBeenCalled();
  });

  it('does nothing when the task id is not (yet) in the manager', () => {
    expect(() =>
      placeCreatedTaskInColumn({ tasks: new Map() }, 'missing', 'idea')
    ).not.toThrow();
  });
});
