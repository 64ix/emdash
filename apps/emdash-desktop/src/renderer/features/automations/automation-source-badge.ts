import type { Automation } from '@shared/core/automations/automation';

/**
 * Badge label for an automation row's machine-local origin. Imported
 * automations arrive disabled (the receiving machine opts in explicitly), so
 * a fresh import reads as "Imported, disabled" until the user enables it.
 */
export function automationSourceBadgeLabel(
  source: Automation['source'],
  enabled: boolean
): string | null {
  if (source !== 'imported') return null;
  return enabled ? 'Imported' : 'Imported, disabled';
}
