import type { Result } from '@emdash/shared';

export type StopControllerCallbacks = {
  /**
   * Invoked synchronously whenever the in-flight state changes, so the host
   * can mirror it into `ChatState.session.setStopPending` (drives the
   * transcript's active-message Stop busy/disabled state) and any other
   * observable the host exposes (e.g. composer state).
   */
  onBusyChange: (busy: boolean) => void;
  /**
   * Invoked when the underlying cancellation request rejects, or resolves as
   * a failure Result. The host is expected to surface this (e.g. a toast);
   * the control remains retryable afterwards since `isCancelling` resets
   * before this fires.
   */
  onError: (error: unknown) => void;
};

export type StopController = {
  /** True while a cancellation request is in flight. */
  readonly isCancelling: boolean;
  /**
   * Request cancellation of the active turn. Both the composer's Stop button
   * and the active-message Stop action in the transcript call this same
   * path, so activation from either surface is single-flight together.
   *
   * No-ops while a previous request is still in flight, so repeated
   * activation (double clicks, composer + transcript row clicked in the same
   * tick, etc.) sends at most one cancellation request. Idempotent and
   * race-safe if the turn has already settled by the time the request
   * reaches the runtime: the ACP session state machine treats `Cancel` with
   * no active turn as a no-op success rather than an error (see
   * `packages/runtime/src/acp-agents/machine/machine.ts`), so this settles
   * quietly without surfacing a spurious failure.
   */
  stop(): void;
};

/**
 * Wraps an ACP `cancelTurn` call with a single-flight guard and busy-state
 * notification. Framework-free (no MobX/Solid import) so it is unit-testable
 * without constructing the full `AcpChatStore`.
 */
export function createStopController(
  cancelTurn: () => Promise<Result<void, unknown>>,
  callbacks: StopControllerCallbacks
): StopController {
  let cancelling = false;

  return {
    get isCancelling() {
      return cancelling;
    },
    stop(): void {
      if (cancelling) return;
      cancelling = true;
      callbacks.onBusyChange(true);

      void cancelTurn()
        .then((result) => {
          if (!result.success) callbacks.onError(result.error);
        })
        .catch((error: unknown) => {
          callbacks.onError(error);
        })
        .finally(() => {
          cancelling = false;
          callbacks.onBusyChange(false);
        });
    },
  };
}
