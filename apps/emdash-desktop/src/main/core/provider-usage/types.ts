import type { Result } from '@emdash/shared';
import type {
  ProviderUsageError,
  ProviderUsageProvider,
  ProviderUsageSnapshot,
} from '@shared/core/provider-usage';

export interface ProviderUsageAdapter {
  readonly provider: ProviderUsageProvider;
  isAvailable(): Promise<boolean>;
  read(): Promise<Result<ProviderUsageSnapshot, ProviderUsageError>>;
}
