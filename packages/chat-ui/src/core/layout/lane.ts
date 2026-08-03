/**
 * lane — the pure lane-selection and lane-width rules for the transcript layout.
 *
 * `Transcript units can declare prose or artifact presentation intent without
 * renderer-specific global width overrides` (spec #18, ticket #27). A UnitDef
 * declares its intent once via the static `lane` field (see `core/units.ts`);
 * these two pure functions are the ONLY place that turns that declaration into
 * an exact pixel width. ChatRoot / UnitRow call them instead of branching on
 * `unit.kind` inline, so the rule stays unit-testable and renderers never see
 * or set their own CSS width.
 */

import type { Lane, RenderUnit, UnitDef } from '@core/units';

export type { Lane };

/**
 * Upper bound (px) for the artifact lane on wide viewports.
 *
 * Chosen to read comfortably wider than the ~672px prose column (roughly
 * 1.4x) while still leaving generous side margins on a 1440px panel. This is
 * a design decision for ticket #27; later tickets (diff previews, tool
 * inspectors) can override it per-call via `LaneWidthInputs.maxArtifactWidth`
 * if a different agreed width is needed.
 */
export const ARTIFACT_LANE_MAX_WIDTH = 960;

export type LaneWidthInputs = {
  /** The existing readable prose column width (px), already capped. */
  proseWidth: number;
  /**
   * Total width (px) available inside the scroll container before the prose
   * cap is applied — the true upper bound an artifact lane may use without
   * causing page-level horizontal overflow. Always `>= proseWidth`: both are
   * derived from the same measured flow width, and only the prose column
   * additionally caps at the content column's max-width.
   */
  availableWidth: number;
  /** Override the default wide-lane cap (px). Mainly for tests. */
  maxArtifactWidth?: number;
};

/**
 * Resolve the effective row width (px) for `lane` given the current column
 * geometry.
 *
 * Pure and side-effect free — the sole seam the transcript layout uses to
 * turn a declared lane into an exact width. Given the stated precondition
 * (`availableWidth >= proseWidth`), the result is always in
 * `[proseWidth, availableWidth]`, so callers get a hard guarantee against
 * page-level horizontal overflow: `prose` never shrinks and `artifact` never
 * grows past the panel.
 */
export function computeLaneWidth(lane: Lane, inputs: LaneWidthInputs): number {
  if (lane === 'prose') return inputs.proseWidth;
  const maxArtifactWidth = inputs.maxArtifactWidth ?? ARTIFACT_LANE_MAX_WIDTH;
  return Math.max(inputs.proseWidth, Math.min(maxArtifactWidth, inputs.availableWidth));
}

/**
 * Resolve the declared lane for a UnitDef. Defaults to `'prose'` when the def
 * is missing `lane` (or missing entirely — an unregistered `unit.kind`).
 */
export function resolveLane<D, V extends Record<string, number>>(
  def: Pick<UnitDef<D, V>, 'lane'> | undefined
): Lane {
  return def?.lane ?? 'prose';
}

/**
 * Convenience wrapper: resolve a RenderUnit's lane via its UNIT_REGISTRY def.
 * `registry` is passed in (rather than imported) so this stays a pure
 * function of its arguments — callers usually pass `UNIT_REGISTRY`.
 */
export function resolveUnitLane(
  unit: Pick<RenderUnit, 'kind'>,
  registry: Record<string, Pick<UnitDef<unknown, Record<string, number>>, 'lane'> | undefined>
): Lane {
  return resolveLane(registry[unit.kind]);
}
