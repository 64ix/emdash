import { reaction } from 'mobx';
import type { TabHandle, TabResource } from '@renderer/features/tabs/core/tab-provider';
import { toast } from '@renderer/lib/hooks/use-toast';
import { setTelemetryConversationScope } from '@renderer/utils/telemetry-scope';
import type { ConversationStore } from './conversation-manager';
import { conversationRegistry } from './stores/conversation-registry';

/**
 * Domain resource for a single open conversation tab.
 *
 * Wraps ConversationStore, wires up:
 *  - Auto-close when the conversation is deleted from the registry.
 *  - Telemetry scope and mark-seen in onActivate().
 *
 * The PTY session lifecycle (hydrate/dehydrate) is managed separately by
 * ConversationSessionManager (called from the tab provider's initialize/dispose).
 */
export class ConversationTabResource implements TabResource {
  readonly store: ConversationStore;
  private readonly _taskId: string;
  private readonly _disposers: (() => void)[];

  constructor(store: ConversationStore, taskId: string, handle: TabHandle) {
    this.store = store;
    this._taskId = taskId;
    const conversationId = store.data.id;

    this._disposers = [
      // Auto-close this tab when the conversation is deleted.
      reaction(
        () => conversationRegistry.get(taskId)?.conversations.has(conversationId) ?? false,
        (exists) => {
          if (!exists) void handle.close();
        }
      ),
    ];
  }

  dispose(): void {
    for (const d of this._disposers) d();
    // Mark conversation as seen on close (mirrors old onClose behavior).
    this.store.markSeen();
  }

  onActivate(): void {
    setTelemetryConversationScope(this.store.data.id);
    if (!this.store.seen) {
      this.store.markSeen();
    }
  }

  rename(name: string): void {
    void conversationRegistry.get(this._taskId)?.renameConversation(this.store.data.id, name);
  }

  /**
   * "Reload" — kill the TUI's PTY and start a fresh session (resume).
   * Recovery for glitched terminal display state that scrolling/redrawing
   * cannot fix.
   */
  reload(): void {
    void conversationRegistry
      .get(this._taskId)
      ?.restartConversation(this.store.data.id)
      .catch((error) => {
        toast({
          title: 'Reload failed',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
      });
  }
}
