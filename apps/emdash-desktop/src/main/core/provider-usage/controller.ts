import { createRPCController } from '@shared/lib/ipc/rpc';
import { getProviderUsage } from './get-provider-usage';
import { refreshProviderUsage } from './refresh-provider-usage';

export const providerUsageController = createRPCController({
  getProviderUsage,
  refreshProviderUsage,
});
