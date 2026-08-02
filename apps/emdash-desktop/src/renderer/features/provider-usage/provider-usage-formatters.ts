import type { ProviderUsageSnapshot, UsageWindow } from '@shared/core/provider-usage';

export function getPrimaryUsageWindow(snapshot: ProviderUsageSnapshot): UsageWindow | null {
  return snapshot.windows.find((window) => window.primary) ?? snapshot.windows[0] ?? null;
}

export function isUsageWarning(utilization: number): boolean {
  return utilization >= 90;
}

export function formatUsagePercent(utilization: number): string {
  return `${Math.round(Math.max(0, Math.min(100, utilization)))}%`;
}

export function formatResetTime(resetsAt: string | null, now = Date.now()): string {
  if (!resetsAt) return 'reset time unknown';
  const remaining = Date.parse(resetsAt) - now;
  if (!Number.isFinite(remaining)) return 'reset time unknown';
  if (remaining <= 0) return 'reset due';
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const trailingMinutes = minutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${trailingMinutes}m`;
  return `resets in ${minutes}m`;
}

export function formatUpdatedAge(lastUpdated: string, now = Date.now()): string {
  const elapsed = now - Date.parse(lastUpdated);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'updated just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}
