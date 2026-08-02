import type { ProviderUsageSnapshot } from '@shared/core/provider-usage';
import { providerUsageService } from './service-instance';

export function getProviderUsage(): Promise<ProviderUsageSnapshot[]> {
  return providerUsageService.getSnapshots();
}
