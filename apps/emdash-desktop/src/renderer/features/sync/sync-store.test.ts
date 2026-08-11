/**
 * SyncStore tests (spec #130, ticket #137): the widget store is a thin
 * `useSyncExternalStore` surface fed by the `sync:status` event and the sync
 * RPC namespace. These tests pin the store contract the widget renders from:
 * event updates, bootstrap via `getSyncStatus`, and `syncNow` adopting the
 * returned status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '@shared/core/sync/status';

const mocks = vi.hoisted(() => ({
  getSyncStatus: vi.fn(),
  syncNow: vi.fn(),
  onEvent: vi.fn((_channel: { name?: string }, _handler: unknown) => () => {}),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    sync: {
      getSyncStatus: mocks.getSyncStatus,
      syncNow: mocks.syncNow,
    },
  },
  events: { on: mocks.onEvent },
}));

const UP_TO_DATE: SyncStatus = {
  state: 'up-to-date',
  paired: true,
  lastSyncAt: 1_800_000_000_000,
  lastError: null,
  pendingCount: 0,
};

const OFFLINE: SyncStatus = {
  state: 'offline-with-pending',
  paired: true,
  lastSyncAt: 1_700_000_000_000,
  lastError: 'Could not reach the sync relay.',
  pendingCount: 3,
};

// The store is a module singleton; each test loads a fresh instance so the
// lazy `start()` runs once per test.
import type { syncStore as SyncStoreInstance } from './sync-store';

async function loadStore(): Promise<typeof SyncStoreInstance> {
  vi.resetModules();
  const { syncStore } = await import('./sync-store');
  return syncStore;
}

function statusHandler(): ((status: SyncStatus) => void) | undefined {
  const channel = { name: 'sync:status' };
  return mocks.onEvent.mock.calls.find(([c]) => c?.name === channel.name)?.[1] as
    | ((status: SyncStatus) => void)
    | undefined;
}

describe('syncStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSyncStatus.mockResolvedValue(UP_TO_DATE);
    mocks.syncNow.mockResolvedValue(UP_TO_DATE);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('starts idle until a status arrives', async () => {
    const store = await loadStore();
    expect(store.getSnapshot()).toEqual({
      state: 'idle',
      paired: false,
      lastSyncAt: null,
      lastError: null,
      pendingCount: 0,
    });
  });

  it('bootstraps from getSyncStatus on first subscription', async () => {
    const store = await loadStore();
    const unsubscribe = store.subscribe(() => undefined);
    // The store starts lazily on first subscriber; flush the RPC round-trip.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.getSyncStatus).toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual(UP_TO_DATE);
    unsubscribe();
  });

  it('adopts statuses pushed through the sync:status event', async () => {
    const store = await loadStore();
    const unsubscribe = store.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handler = statusHandler();
    expect(handler).toBeTypeOf('function');

    handler?.(OFFLINE);
    expect(store.getSnapshot()).toEqual(OFFLINE);
    unsubscribe();
  });

  it('syncNow delegates to rpc and adopts the returned status', async () => {
    const store = await loadStore();
    const unsubscribe = store.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    mocks.syncNow.mockResolvedValue(OFFLINE);
    await store.syncNow();

    expect(mocks.syncNow).toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual(OFFLINE);
    unsubscribe();
  });

  it('notifies subscribers on status changes', async () => {
    const store = await loadStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener.mockClear();

    const handler = statusHandler();
    handler?.(OFFLINE);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual(OFFLINE);
    unsubscribe();
  });
});
