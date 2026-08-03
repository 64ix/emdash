import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import {
  placeCreatedTaskInColumn,
  type RegistrationAwareTaskStore,
} from './place-created-task-in-column';

function makeFakeStore(
  overrides: Partial<{ state: RegistrationAwareTaskStore['state']; phase: string | null }> = {}
): RegistrationAwareTaskStore & { updateBoardPosition: ReturnType<typeof vi.fn> } {
  // `state`/`phase` are backed by `observable.box` so `when()` below can react
  // to their mutation. `updateBoardPosition` deliberately never passes through
  // `observable()` at all (a plain object literal, not a MobX-observable one):
  // MobX's Proxy-based observable objects auto-wrap *any* function-valued
  // property assigned on them (including via a later `Object.assign`) into a
  // new action-wrapper function, which breaks vitest's spy identity check
  // (`expect(...).toHaveBeenCalled()` on the wrapper, not the original `vi.fn()`).
  const stateBox = observable.box<RegistrationAwareTaskStore['state']>(
    overrides.state ?? 'unregistered'
  );
  const phaseBox = observable.box<string | null>(overrides.phase ?? 'creating');
  return {
    get state() {
      return stateBox.get();
    },
    set state(value) {
      stateBox.set(value);
    },
    get phase() {
      return phaseBox.get();
    },
    set phase(value) {
      phaseBox.set(value);
    },
    updateBoardPosition: vi.fn().mockResolvedValue(undefined),
  };
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
    expect(() => placeCreatedTaskInColumn({ tasks: new Map() }, 'missing', 'idea')).not.toThrow();
  });
});
