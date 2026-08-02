import type { Result } from '@emdash/shared';
import type {
  ProviderUsageError,
  ProviderUsageProvider,
  ProviderUsageSnapshot,
} from '@shared/core/provider-usage';

export interface ProviderUsageAdapter {
  readonly provider: ProviderUsageProvider;
  isAvailable(): Promise<Result<boolean, ProviderUsageError>>;
  read(): Promise<Result<ProviderUsageSnapshot, ProviderUsageError>>;
}
