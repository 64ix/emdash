import type { ProviderUsageProvider, ProviderUsageSnapshot } from '@shared/core/provider-usage';
import { providerUsageService } from './service-instance';

export function refreshProviderUsage(
  provider: ProviderUsageProvider
): Promise<ProviderUsageSnapshot | null> {
  return providerUsageService.refresh(provider);
}
