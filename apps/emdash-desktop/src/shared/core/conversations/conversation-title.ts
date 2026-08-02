export function parseDefaultConversationTitleIndex(
  title: string,
  providerId: string
): number | null {
  const escapedProviderId = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = title.match(new RegExp(`^${escapedProviderId} \\(([1-9]\\d*)\\)$`, 'i'));
  if (!match) return null;

  const rawIndex = match[1];
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 1) return null;
  if (String(index) !== rawIndex) return null;
  return index;
}
