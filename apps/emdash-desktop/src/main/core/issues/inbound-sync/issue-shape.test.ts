import { describe, expect, it } from 'vitest';
import {
  classifyIssueShape,
  isMapShapedIssue,
  isSpecShapedIssue,
  isWayfinderLabeled,
  stripSpecTitlePrefix,
} from './issue-shape';

describe('isSpecShapedIssue', () => {
  it('matches a title starting with [Spec]', () => {
    expect(isSpecShapedIssue('[Spec] GitHub-derived Feature Board')).toBe(true);
  });

  it('matches the numbered [Spec #N] form', () => {
    expect(isSpecShapedIssue('[Spec #120] Sidebar project cards UI')).toBe(true);
  });

  it('matches the Spec: and Spec : forms', () => {
    expect(isSpecShapedIssue('Spec: Auto-update in-game')).toBe(true);
    expect(isSpecShapedIssue('Spec : Auto-update in-game')).toBe(true);
  });

  it('matches the [PRD], [PRD #N], PRD: and PRD : forms', () => {
    expect(isSpecShapedIssue('[PRD] Fondations UI')).toBe(true);
    expect(isSpecShapedIssue('[PRD #152] Fenêtrage côté client')).toBe(true);
    expect(isSpecShapedIssue('PRD: Combat')).toBe(true);
    expect(isSpecShapedIssue('PRD : Combat')).toBe(true);
  });

  it('tolerates leading whitespace before the prefix', () => {
    expect(isSpecShapedIssue('  [Spec] Trimmed title')).toBe(true);
  });

  it('does not match a title with [Spec] elsewhere', () => {
    expect(isSpecShapedIssue('Feature: [Spec] mentioned mid-title')).toBe(false);
  });

  it('does not match a plain title', () => {
    expect(isSpecShapedIssue('Fix the login bug')).toBe(false);
  });

  it('does not match a title that merely contains the words Spec or PRD', () => {
    expect(isSpecShapedIssue('Inspect the release pipeline')).toBe(false);
    expect(isSpecShapedIssue('Support PRD exports')).toBe(false);
  });
});

describe('stripSpecTitlePrefix', () => {
  it('strips the [Spec] prefix', () => {
    expect(stripSpecTitlePrefix('[Spec] GitHub-derived Feature Board')).toBe(
      'GitHub-derived Feature Board'
    );
  });

  it('strips the numbered [Spec #N] prefix', () => {
    expect(stripSpecTitlePrefix('[Spec #120] Sidebar project cards UI')).toBe(
      'Sidebar project cards UI'
    );
  });

  it('strips the Spec:, Spec :, [PRD], [PRD #N], PRD: and PRD : prefixes', () => {
    expect(stripSpecTitlePrefix('Spec: Auto-update in-game')).toBe('Auto-update in-game');
    expect(stripSpecTitlePrefix('Spec : Auto-update in-game')).toBe('Auto-update in-game');
    expect(stripSpecTitlePrefix('[PRD] Fondations UI')).toBe('Fondations UI');
    expect(stripSpecTitlePrefix('[PRD #152] Fenêtrage côté client')).toBe('Fenêtrage côté client');
    expect(stripSpecTitlePrefix('PRD: Combat')).toBe('Combat');
    expect(stripSpecTitlePrefix('PRD : Combat')).toBe('Combat');
  });

  it('trims a title it does not strip', () => {
    expect(stripSpecTitlePrefix('  Fix the login bug  ')).toBe('Fix the login bug');
  });

  it('keeps the title when stripping would leave nothing', () => {
    expect(stripSpecTitlePrefix('[Spec]')).toBe('[Spec]');
  });
});

describe('isMapShapedIssue', () => {
  it('matches when labelled wayfinder:map', () => {
    expect(isMapShapedIssue(['wayfinder:map', 'other'])).toBe(true);
  });

  it('does not match other wayfinder labels', () => {
    expect(isMapShapedIssue(['wayfinder:research'])).toBe(false);
  });

  it('does not match with no labels', () => {
    expect(isMapShapedIssue([])).toBe(false);
  });
});

describe('isWayfinderLabeled', () => {
  it('matches wayfinder:map', () => {
    expect(isWayfinderLabeled(['wayfinder:map'])).toBe(true);
  });

  it('matches any other wayfinder:* label', () => {
    expect(isWayfinderLabeled(['wayfinder:research', 'other'])).toBe(true);
  });

  it('does not match a label that merely contains "wayfinder"', () => {
    expect(isWayfinderLabeled(['not-wayfinder:map'])).toBe(false);
  });

  it('does not match with no labels', () => {
    expect(isWayfinderLabeled([])).toBe(false);
  });
});

describe('classifyIssueShape', () => {
  it('classifies a Spec-shaped issue as spec', () => {
    expect(classifyIssueShape({ title: '[Spec] Feature', labels: [] })).toBe('spec');
  });

  it('classifies a Map-shaped issue as map', () => {
    expect(classifyIssueShape({ title: 'Explore feature X', labels: ['wayfinder:map'] })).toBe(
      'map'
    );
  });

  it('prefers spec when an issue is both spec- and map-shaped', () => {
    expect(classifyIssueShape({ title: '[Spec] Feature', labels: ['wayfinder:map'] })).toBe('spec');
  });

  it('returns null for an issue matching neither shape', () => {
    expect(classifyIssueShape({ title: 'Fix the login bug', labels: [] })).toBeNull();
  });
});
