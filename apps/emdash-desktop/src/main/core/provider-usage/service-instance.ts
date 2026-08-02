import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { appSettingsService } from '@main/core/settings/settings-service';
import { events } from '@main/lib/events';
import { providerUsageUpdatedChannel } from '@shared/events/providerUsageEvents';
import { ClaudeUsageAdapter } from './claude-adapter';
import { CodexUsageAdapter } from './codex-adapter';
import { isLocalProviderUsageTask } from './provider-usage-activity';
import { ProviderUsageService } from './provider-usage-service';

let unsubscribeActivity: (() => void) | null = null;

export const providerUsageService = new ProviderUsageService({
  adapters: [new ClaudeUsageAdapter(), new CodexUsageAdapter()],
  emit: (snapshots) => events.emit(providerUsageUpdatedChannel, snapshots),
});

export async function initializeProviderUsageService(): Promise<void> {
  const settings = await appSettingsService.get('interface');
  providerUsageService.initialize({
    claude: settings.showClaudeUsageGauge,
    codex: settings.showCodexUsageGauge,
  });
  unsubscribeActivity?.();
  unsubscribeActivity = agentHookService.on('agent:event', (event) => {
    if (event.type === 'start' && (event.providerId === 'claude' || event.providerId === 'codex')) {
      const provider = event.providerId;
      void isLocalProviderUsageTask(event.taskId)
        .then((isLocal) => {
          if (isLocal) void providerUsageService.recordActivity(provider);
        })
        .catch(() => undefined);
    }
  });
}

export function disposeProviderUsageService(): void {
  unsubscribeActivity?.();
  unsubscribeActivity = null;
  providerUsageService.dispose();
}
