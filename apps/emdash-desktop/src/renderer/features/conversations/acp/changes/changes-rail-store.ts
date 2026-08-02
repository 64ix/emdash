import { makeObservable, observable, action } from 'mobx';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import type { ChangesRailFilter, ChangesRailSnapshot } from '@shared/view-state';

export const CHANGES_RAIL_DEFAULT_WIDTH = 320;
export const CHANGES_RAIL_MIN_WIDTH = 240;
export const CHANGES_RAIL_MAX_WIDTH = 560;

/**
 * View-state store for the ACP chat's task-scoped Changes rail.
 *
 * Holds only UI preferences (open state, width, filter, selection) — the
 * rail's actual contents are the `ChangesFootprint` projection computed by
 * `buildChangesFootprint`, never stored here. One instance lives for the
 * lifetime of a task's `WorkspaceViewModel`, same as `terminalTabs`/`editorView`.
 */
export class ChangesRailViewStore implements Snapshottable<ChangesRailSnapshot> {
  isOpen = false;
  width = CHANGES_RAIL_DEFAULT_WIDTH;
  filter: ChangesRailFilter = 'all';
  selectedPath: string | null = null;

  constructor() {
    makeObservable(this, {
      isOpen: observable,
      width: observable,
      filter: observable,
      selectedPath: observable,
      setOpen: action,
      toggleOpen: action,
      setWidth: action,
      setFilter: action,
      setSelectedPath: action,
      restoreSnapshot: action,
    });
  }

  get snapshot(): ChangesRailSnapshot {
    return {
      isOpen: this.isOpen,
      width: this.width,
      filter: this.filter,
      selectedPath: this.selectedPath,
    };
  }

  restoreSnapshot(snapshot: Partial<ChangesRailSnapshot>): void {
    if (snapshot.isOpen !== undefined) this.isOpen = snapshot.isOpen;
    if (snapshot.width !== undefined) this.width = clampWidth(snapshot.width);
    if (snapshot.filter !== undefined) this.filter = snapshot.filter;
    if (snapshot.selectedPath !== undefined) this.selectedPath = snapshot.selectedPath;
  }

  setOpen(open: boolean): void {
    this.isOpen = open;
  }

  toggleOpen(): void {
    this.isOpen = !this.isOpen;
  }

  setWidth(width: number): void {
    this.width = clampWidth(width);
  }

  setFilter(filter: ChangesRailFilter): void {
    this.filter = filter;
  }

  setSelectedPath(path: string | null): void {
    this.selectedPath = path;
  }
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return CHANGES_RAIL_DEFAULT_WIDTH;
  return Math.min(CHANGES_RAIL_MAX_WIDTH, Math.max(CHANGES_RAIL_MIN_WIDTH, Math.round(width)));
}
