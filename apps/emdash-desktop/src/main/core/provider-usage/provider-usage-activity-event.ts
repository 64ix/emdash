import type { AgentEvent } from '@shared/core/agents/agentEvents';
import type { ProviderUsageProvider } from '@shared/core/provider-usage';

export function providerUsageProviderForActivityEvent(
  event: Pick<AgentEvent, 'type' | 'providerId'>
): ProviderUsageProvider | null {
  if (event.type !== 'start' && event.type !== 'stop') return null;
  return event.providerId === 'claude' || event.providerId === 'codex' ? event.providerId : null;
}
