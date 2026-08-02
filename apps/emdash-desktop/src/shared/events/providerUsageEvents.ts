import type { ProviderUsageSnapshot } from '@shared/core/provider-usage';
import { defineEvent } from '@shared/lib/ipc/events';

export const providerUsageUpdatedChannel =
  defineEvent<ProviderUsageSnapshot[]>('provider-usage:updated');
