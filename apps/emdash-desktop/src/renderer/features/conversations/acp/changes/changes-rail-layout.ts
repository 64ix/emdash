/**
 * Below this panel width, the Changes rail cannot coexist with a readable
 * transcript column — it becomes a drawer overlay instead of an inline
 * sidebar. `null` (not yet measured) is treated as wide, so the rail does
 * not flash into drawer mode before the pane's first ResizeObserver tick.
 */
export const CHANGES_RAIL_NARROW_BREAKPOINT_PX = 760;

export function isChangesRailNarrow(paneWidth: number | null): boolean {
  return paneWidth !== null && paneWidth < CHANGES_RAIL_NARROW_BREAKPOINT_PX;
}
