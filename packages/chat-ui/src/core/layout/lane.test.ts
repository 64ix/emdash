import { describe, expect, it } from 'vitest';
import type { UnitDef } from '@core/units';
import { ARTIFACT_LANE_MAX_WIDTH, computeLaneWidth, resolveLane, resolveUnitLane } from './lane';

type Def = Pick<UnitDef<unknown, Record<string, number>>, 'lane'>;

describe('resolveLane', () => {
  it('defaults to prose when the def is undefined', () => {
    expect(resolveLane(undefined)).toBe('prose');
  });

  it('defaults to prose when the def omits lane', () => {
    const def: Def = {};
    expect(resolveLane(def)).toBe('prose');
  });

  it('returns the declared lane when set', () => {
    const def: Def = { lane: 'artifact' };
    expect(resolveLane(def)).toBe('artifact');
  });
});

describe('resolveUnitLane', () => {
  const registry: Record<string, Def> = {
    diff: { lane: 'artifact' },
    message: {},
    tool: { lane: 'prose' },
  };

  it('resolves a registered artifact kind', () => {
    expect(resolveUnitLane({ kind: 'diff' }, registry)).toBe('artifact');
  });

  it('resolves a registered prose kind', () => {
    expect(resolveUnitLane({ kind: 'message' }, registry)).toBe('prose');
    expect(resolveUnitLane({ kind: 'tool' }, registry)).toBe('prose');
  });

  it('falls back to prose for an unregistered kind', () => {
    expect(resolveUnitLane({ kind: 'nonexistent' }, registry)).toBe('prose');
  });
});

describe('computeLaneWidth', () => {
  // Representative (proseWidth, availableWidth) pairs at the AC's three
  // breakpoints. proseWidth = min(672, availableWidth) by construction — both
  // are derived from the same measured flow width, one capped at the 42rem
  // content column, one not (see chat-root.css.ts CONTAINER_WIDTH).
  const AT_1440 = { proseWidth: 672, availableWidth: 1408 };
  const AT_800 = { proseWidth: 672, availableWidth: 768 };
  const AT_480 = { proseWidth: 448, availableWidth: 448 };

  it('prose lane always returns proseWidth, independent of availableWidth', () => {
    for (const inputs of [AT_1440, AT_800, AT_480]) {
      expect(computeLaneWidth('prose', inputs)).toBe(inputs.proseWidth);
    }
  });

  it('artifact lane widens to the cap on a wide (1440px) panel', () => {
    expect(computeLaneWidth('artifact', AT_1440)).toBe(ARTIFACT_LANE_MAX_WIDTH);
  });

  it('artifact lane widens up to (but not past) available width on an 800px panel', () => {
    const width = computeLaneWidth('artifact', AT_800);
    expect(width).toBe(AT_800.availableWidth);
    expect(width).toBeGreaterThan(AT_800.proseWidth);
    expect(width).toBeLessThan(ARTIFACT_LANE_MAX_WIDTH);
  });

  it('artifact lane collapses back to the prose width on a narrow (480px) panel', () => {
    expect(computeLaneWidth('artifact', AT_480)).toBe(AT_480.proseWidth);
  });

  it('never returns a width narrower than proseWidth, even with a tiny custom cap', () => {
    const width = computeLaneWidth('artifact', { ...AT_1440, maxArtifactWidth: 100 });
    expect(width).toBe(AT_1440.proseWidth);
  });

  it('never exceeds availableWidth across all three breakpoints', () => {
    for (const inputs of [AT_1440, AT_800, AT_480]) {
      expect(computeLaneWidth('artifact', inputs)).toBeLessThanOrEqual(inputs.availableWidth);
    }
  });

  it('honors a custom maxArtifactWidth override', () => {
    expect(computeLaneWidth('artifact', { ...AT_1440, maxArtifactWidth: 800 })).toBe(800);
  });
});
