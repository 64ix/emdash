export type ProviderUsageActivityWorkspace = {
  location: 'local' | 'remote' | null;
  type: 'local' | 'project-ssh' | 'byoi' | null;
  legacyProvider: string | null;
};

export function isLocalProviderUsageActivity(
  workspace: ProviderUsageActivityWorkspace | undefined
): boolean {
  if (!workspace) return false;
  if (workspace.location === 'remote') return false;
  if (workspace.type === 'project-ssh') return false;
  return workspace.legacyProvider !== 'ssh';
}
