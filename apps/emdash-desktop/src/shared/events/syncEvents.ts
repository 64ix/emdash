import type { SyncStatus } from '@shared/core/sync/status';
import { defineEvent } from '@shared/lib/ipc/events';

/**
 * Main → renderer: an `emdash://join?secret=…` deep link was received while
 * the app was running. The renderer surfaces the secret into the pairing flow
 * (Devices settings tab, join modal pre-filled) — it never joins automatically.
 */
export const syncJoinSecretChannel = defineEvent<{ secret: string }>('sync:join-secret');

/**
 * Main → renderer: the sync service snapshot changed (spec #130, ticket #137).
 * Emitted after every state transition (launch sync, manual sync, offline
 * detection, reconnect, errors); the sidebar status widget store consumes it.
 */
export const syncStatusChannel = defineEvent<SyncStatus>('sync:status');
