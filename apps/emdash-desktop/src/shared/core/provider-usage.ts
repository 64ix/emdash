export type ProviderUsageProvider = 'claude' | 'codex';

export type UsageWindow = {
  id: string;
  label: string;
  utilization: number;
  resetsAt: string | null;
  primary: boolean;
};

export type ProviderUsageError = {
  code: 'authentication' | 'network' | 'malformed-data' | 'unreadable-data';
  message: string;
};

export type ProviderUsageSnapshot = {
  provider: ProviderUsageProvider;
  windows: UsageWindow[];
  lastUpdated: string;
  error?: ProviderUsageError;
};

export type ProviderUsageVisibility = Record<ProviderUsageProvider, boolean>;
