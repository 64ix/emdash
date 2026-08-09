import { useEffect } from 'react';
import { events } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { syncJoinSecretChannel } from '@shared/events/syncEvents';

/**
 * Renderer side of the `emdash://join?secret=…` deep link (spec #130, ticket
 * #135): the main process forwards the received secret via
 * `syncJoinSecretChannel`; this handler opens the Devices settings tab and
 * pre-fills the join modal. Joining only happens after the user confirms in
 * the modal — a deep link never auto-joins.
 */
export function SyncDeepLinkHandler() {
  const { navigate } = useNavigate();

  useEffect(() => {
    return events.on(syncJoinSecretChannel, ({ secret }) => {
      navigate('settings', { tab: 'devices' });
      showModal('joinSyncSpaceModal', { initialSecret: secret });
    });
  }, [navigate]);

  return null;
}
