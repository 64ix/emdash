/**
 * Pure decision logic for preserving the visible reading position across
 * `ChatView.loadOlder()` (prepending an older history page).
 *
 * Extracted from ChatRoot.tsx's `doLoadOlder()` so the anchor math can be
 * unit-tested without a DOM or a Solid root (mirrors `state/geometry.ts`).
 *
 * The seam: capture the itemId + pixel offset visible at the top of the
 * viewport *before* the prepend, then — once the virtualizer and transcript
 * have absorbed the older turns and every unit's index has shifted — resolve
 * that same itemId's *new* index to recompute scrollTop. Item ids are stable
 * across a prepend; row indices are not.
 *
 * This "itemId -> scrollTop" shape is also the seam later transcript
 * navigation features (search, outline, durable reading position) are
 * expected to reuse for their own stable jumps into a virtualized list.
 */

export type LoadOlderAnchor = {
  /** Stable itemId of the render unit visible at the top of the viewport. */
  itemId: string;
  /** scrollTop minus that unit's content-relative top (may be negative). */
  offset: number;
};

/**
 * Minimal read surface the anchor helpers need from a `UnitsView` (or any
 * indexable unit list) — only `itemId` is read, so this stays decoupled from
 * `state/flatten.ts`'s full `RenderUnit` shape.
 */
export type ItemIdLookup = {
  readonly length: number;
  at(index: number): { itemId: string } | undefined;
};

/** Minimal row-geometry surface the anchor helpers need from the Virtualizer. */
export type UnitGeometry = {
  /** Row index whose span contains the given content-relative offset. */
  findIndex(offset: number): number;
  /** Content-relative pixel top of the row at `index`. */
  top(index: number): number;
};

/**
 * Capture the unit + offset visible at `scrollTop`. Returns undefined when
 * there is no addressable unit (e.g. an empty transcript) — callers should
 * skip anchor restoration in that case.
 */
export function captureLoadOlderAnchor(
  scrollTop: number,
  padTop: number,
  units: ItemIdLookup,
  geometry: UnitGeometry
): LoadOlderAnchor | undefined {
  const idx = geometry.findIndex(Math.max(0, scrollTop - padTop));
  const itemId = units.at(idx)?.itemId;
  if (itemId === undefined) return undefined;
  return { itemId, offset: scrollTop - (geometry.top(idx) + padTop) };
}

/**
 * Resolve a captured anchor to a new scrollTop after older turns have been
 * prepended (unit indices shift, but the anchored itemId stays stable).
 * Returns undefined when the anchored item can no longer be found (should
 * not happen for a pure prepend, but guards against unexpected structural
 * changes racing the load).
 */
export function resolveLoadOlderAnchor(
  anchor: LoadOlderAnchor,
  padTop: number,
  units: ItemIdLookup,
  geometry: UnitGeometry
): number | undefined {
  let idx = -1;
  for (let i = 0; i < units.length; i++) {
    if (units.at(i)?.itemId === anchor.itemId) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return undefined;
  return geometry.top(idx) + padTop + anchor.offset;
}
