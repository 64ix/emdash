import { describe, expect, it } from 'vitest';
import { automationSourceBadgeLabel } from './automation-source-badge';

describe('automationSourceBadgeLabel', () => {
  it('returns null for locally created automations, enabled or not', () => {
    expect(automationSourceBadgeLabel('local', true)).toBeNull();
    expect(automationSourceBadgeLabel('local', false)).toBeNull();
  });

  it('labels a fresh import as "Imported, disabled"', () => {
    expect(automationSourceBadgeLabel('imported', false)).toBe('Imported, disabled');
  });

  it('labels an enabled import as "Imported"', () => {
    expect(automationSourceBadgeLabel('imported', true)).toBe('Imported');
  });
});
