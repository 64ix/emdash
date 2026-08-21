import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { rpc } from '@renderer/lib/ipc';

const FeatureFlagContext = createContext<Record<string, boolean>>({});

export function FeatureFlagProvider({ children }: { children: ReactNode }) {
  const { data: flags = {} } = useQuery({
    queryKey: ['feature-flags'],
    queryFn: () => rpc.telemetry.getFeatureFlags(),
    staleTime: Infinity,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && Object.keys(data).length > 0) return false;
      // Flags are evaluated asynchronously after boot and never arrive when
      // telemetry is disabled — back off and give up instead of polling at
      // 2 s for the app's entire lifetime.
      const attempt = query.state.dataUpdateCount;
      return attempt >= 10 ? false : Math.min(2_000 * 2 ** Math.max(attempt - 1, 0), 30_000);
    },
  });
  return <FeatureFlagContext value={flags}>{children}</FeatureFlagContext>;
}

export function useFeatureFlags(): Record<string, boolean> {
  return useContext(FeatureFlagContext);
}
