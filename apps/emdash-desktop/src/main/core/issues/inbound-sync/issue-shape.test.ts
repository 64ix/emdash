import { describe, expect, it } from 'vitest';
import { classifyIssueShape, isMapShapedIssue, isSpecShapedIssue } from './issue-shape';

describe('isSpecShapedIssue', () => {
  it('matches a title starting with [Spec]', () => {
    expect(isSpecShapedIssue('[Spec] GitHub-derived Feature Board')).toBe(true);
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
