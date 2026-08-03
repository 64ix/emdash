import { describe, expect, it } from 'vitest';
import {
  CHANGES_RAIL_DEFAULT_WIDTH,
  CHANGES_RAIL_MAX_WIDTH,
  CHANGES_RAIL_MIN_WIDTH,
  ChangesRailViewStore,
} from './changes-rail-store';

describe('ChangesRailViewStore', () => {
  it('defaults to closed, the default width, the "all" filter, and no selection', () => {
    const store = new ChangesRailViewStore();
    expect(store.snapshot).toEqual({
      isOpen: false,
      width: CHANGES_RAIL_DEFAULT_WIDTH,
      filter: 'all',
      selectedPath: null,
    });
  });

  it('toggles and sets open state', () => {
    const store = new ChangesRailViewStore();
    store.setOpen(true);
    expect(store.isOpen).toBe(true);
    store.toggleOpen();
    expect(store.isOpen).toBe(false);
    store.toggleOpen();
    expect(store.isOpen).toBe(true);
  });

  it('clamps width to the min/max bounds', () => {
    const store = new ChangesRailViewStore();
    store.setWidth(10);
    expect(store.width).toBe(CHANGES_RAIL_MIN_WIDTH);
    store.setWidth(10000);
    expect(store.width).toBe(CHANGES_RAIL_MAX_WIDTH);
    store.setWidth(400);
    expect(store.width).toBe(400);
  });

  it('sets the filter and selected path', () => {
    const store = new ChangesRailViewStore();
    store.setFilter('edited');
    expect(store.filter).toBe('edited');
    store.setSelectedPath('src/a.ts');
    expect(store.selectedPath).toBe('src/a.ts');
    store.setSelectedPath(null);
    expect(store.selectedPath).toBeNull();
  });

  it('round-trips through snapshot/restoreSnapshot', () => {
    const store = new ChangesRailViewStore();
    store.setOpen(true);
    store.setWidth(480);
    store.setFilter('read');
    store.setSelectedPath('src/b.ts');
    const snapshot = store.snapshot;

    const restored = new ChangesRailViewStore();
    restored.restoreSnapshot(snapshot);
    expect(restored.snapshot).toEqual(snapshot);
  });

  it('restoreSnapshot only applies fields present in the (partial) snapshot', () => {
    const store = new ChangesRailViewStore();
    store.setOpen(true);
    store.setWidth(400);
    store.restoreSnapshot({ filter: 'edited' });
    expect(store.isOpen).toBe(true);
    expect(store.width).toBe(400);
    expect(store.filter).toBe('edited');
  });

  it('falls back to the default width when restoring a non-finite width', () => {
    const store = new ChangesRailViewStore();
    store.restoreSnapshot({ width: Number.NaN });
    expect(store.width).toBe(CHANGES_RAIL_DEFAULT_WIDTH);
  });
});
