/**
 * Session-state unit tests — focused on `stopPending`, the reactive flag the
 * transcript's active-message Stop control reads (via TurnStateContext) to
 * disable itself and communicate a busy state while a cancellation request
 * is in flight (see AcpChatStore.stop / acp-chat-stop-controller.ts).
 *
 * createSessionState only uses solid-js signals/memos (no DOM-dependent parse
 * caches), so it is safe to call directly from the `node` test project — see
 * chat-state.test.ts for the same reasoning applied to createViewState.
 */

import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createSessionState, type ChatSessionState } from './session-state';

/**
 * createSessionState creates a `createMemo` (pendingToolCallIds), which warns
 * if created outside a reactive root. Production code always calls it inside
 * createChatState's `createRoot` — mirror that here and dispose after each
 * assertion so the computation is cleaned up like it would be in the app.
 */
function withSessionState(run: (session: ChatSessionState) => void): void {
  createRoot((dispose) => {
    run(createSessionState());
    dispose();
  });
}

describe('createSessionState — stopPending', () => {
  it('defaults to not-pending', () => {
    withSessionState((session) => {
      expect(session.state.stopPending).toBe(false);
    });
  });

  it('setStopPending(true) is reflected on the reactive snapshot', () => {
    withSessionState((session) => {
      session.setStopPending(true);
      expect(session.state.stopPending).toBe(true);
    });
  });

  it('setStopPending(false) clears it again once the request settles', () => {
    withSessionState((session) => {
      session.setStopPending(true);
      session.setStopPending(false);
      expect(session.state.stopPending).toBe(false);
    });
  });

  it('does not affect unrelated session snapshot fields', () => {
    withSessionState((session) => {
      session.setStopPending(true);
      expect(session.state.permissions).toEqual([]);
      expect(session.state.plan).toBeNull();
      expect(session.state.pendingPrompt).toBeNull();
    });
  });
});
