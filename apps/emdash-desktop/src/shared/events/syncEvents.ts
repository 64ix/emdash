import { defineEvent } from '@shared/lib/ipc/events';

/**
 * Main → renderer: an `emdash://join?secret=…` deep link was received while
 * the app was running. The renderer surfaces the secret into the pairing flow
 * (Devices settings tab, join modal pre-filled) — it never joins automatically.
 */
export const syncJoinSecretChannel = defineEvent<{ secret: string }>('sync:join-secret');
