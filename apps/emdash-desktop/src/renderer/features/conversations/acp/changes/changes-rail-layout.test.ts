import { describe, expect, it } from 'vitest';
import { CHANGES_RAIL_NARROW_BREAKPOINT_PX, isChangesRailNarrow } from './changes-rail-layout';

describe('isChangesRailNarrow', () => {
  it('treats an unmeasured (null) pane width as wide', () => {
    expect(isChangesRailNarrow(null)).toBe(false);
  });

  it('is wide at or above the breakpoint', () => {
    expect(isChangesRailNarrow(CHANGES_RAIL_NARROW_BREAKPOINT_PX)).toBe(false);
    expect(isChangesRailNarrow(CHANGES_RAIL_NARROW_BREAKPOINT_PX + 200)).toBe(false);
  });

  it('is narrow below the breakpoint', () => {
    expect(isChangesRailNarrow(CHANGES_RAIL_NARROW_BREAKPOINT_PX - 1)).toBe(true);
    expect(isChangesRailNarrow(480)).toBe(true);
  });
});
