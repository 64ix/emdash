import { observer } from 'mobx-react-lite';
import { useCallback, useRef } from 'react';
import { cn } from '@renderer/utils/utils';
import type {
  ChangesFootprint,
  ChangesFootprintEntry,
  EditedChangesFootprintEntry,
} from './acp-changes-footprint';
import { ChangesRailContent } from './changes-rail-content';
import {
  CHANGES_RAIL_MAX_WIDTH,
  CHANGES_RAIL_MIN_WIDTH,
  type ChangesRailViewStore,
} from './changes-rail-store';

const RESIZE_KEYBOARD_STEP_PX = 16;

export interface ChangesRailProps {
  store: ChangesRailViewStore;
  footprint: ChangesFootprint;
  onSelectEntry: (entry: ChangesFootprintEntry) => void;
  onOpenFile: (entry: ChangesFootprintEntry) => void;
  onOpenDiff: (entry: EditedChangesFootprintEntry) => void;
}

/**
 * Wide-layout Changes rail: an inline sidebar next to the transcript, with a
 * draggable/keyboard-resizable left edge. Persists only `isOpen`/`width`/
 * `filter`/`selectedPath` via `ChangesRailViewStore` — content is the
 * `ChangesFootprint` projection, recomputed elsewhere.
 */
export const ChangesRail = observer(function ChangesRail({
  store,
  footprint,
  onSelectEntry,
  onOpenFile,
  onOpenDiff,
}: ChangesRailProps) {
  const startRef = useRef<{ pointerX: number; width: number } | null>(null);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      // The rail sits on the right edge of the panel — dragging the handle
      // left (toward the transcript) widens the rail.
      const delta = start.pointerX - event.clientX;
      store.setWidth(start.width + delta);
    },
    [store]
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent) => {
      startRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      void event;
    },
    [handlePointerMove]
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      startRef.current = { pointerX: event.clientX, width: store.width };
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [handlePointerMove, handlePointerUp, store.width]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        store.setWidth(store.width + RESIZE_KEYBOARD_STEP_PX);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        store.setWidth(store.width - RESIZE_KEYBOARD_STEP_PX);
      }
    },
    [store]
  );

  if (!store.isOpen) return null;

  return (
    <div
      className="relative flex h-full shrink-0 border-l border-border bg-background-secondary-1"
      style={{ width: store.width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Changes rail"
        aria-valuenow={store.width}
        aria-valuemin={CHANGES_RAIL_MIN_WIDTH}
        aria-valuemax={CHANGES_RAIL_MAX_WIDTH}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        className={cn(
          'absolute inset-y-0 left-0 w-1 -translate-x-1/2 cursor-col-resize',
          'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring'
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChangesRailContent
          footprint={footprint}
          filter={store.filter}
          onFilterChange={(filter) => store.setFilter(filter)}
          selectedPath={store.selectedPath}
          onSelectEntry={(entry) => {
            store.setSelectedPath(entry.path);
            onSelectEntry(entry);
          }}
          onOpenFile={(entry) => {
            store.setSelectedPath(entry.path);
            onOpenFile(entry);
          }}
          onOpenDiff={(entry) => {
            store.setSelectedPath(entry.path);
            onOpenDiff(entry);
          }}
          onClose={() => store.setOpen(false)}
        />
      </div>
    </div>
  );
});
