import type { Result } from '@emdash/shared';

export type PermissionResolutionEntry =
  | { status: 'resolving' }
  | { status: 'error'; message: string };

export type PermissionResolveFn = (
  requestId: string,
  optionId: string
) => Promise<Result<void, unknown>>;

export type PermissionResolutionCallbacks = {
  /**
   * Whether `requestId` is still present in the live pending-permissions list.
   * Consulted only when `resolveFn` fails, so a stale failure for a request
   * already superseded by the turn ending, an agent-initiated cancellation, or
   * a resolution that raced this one, never resurrects a decision surface for
   * a request the user can no longer act on.
   */
  isPending: (requestId: string) => boolean;
  /** Invoked synchronously whenever tracked resolution state changes, so the host can bump its own observable and re-render. */
  onChange: () => void;
};

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Failed to resolve the permission request. You can try again.';
}

/**
 * Tracks in-flight/error state for ACP permission-request resolution, keyed
 * by `requestId` — never by "whatever is currently at the front of the
 * queue" — so a slow or failed decision on one request can never be
 * misattributed to a different request that becomes current while the first
 * is still in flight (ticket #32's race guardrails: turn ending, agent
 * cancellation, a second request arriving, and the same request resolved
 * twice). Framework-free (no MobX import) so it is unit-testable without
 * constructing the full `AcpChatStore`/session graph — see
 * `acp-chat-stop-controller.ts` for the sibling pattern this mirrors.
 */
export class PermissionResolutionController {
  private readonly entries = new Map<string, PermissionResolutionEntry>();
  private readonly lastOptionId = new Map<string, string>();

  constructor(
    private readonly resolveFn: PermissionResolveFn,
    private readonly callbacks: PermissionResolutionCallbacks
  ) {}

  stateFor(requestId: string): PermissionResolutionEntry | undefined {
    return this.entries.get(requestId);
  }

  isResolving(requestId: string): boolean {
    return this.entries.get(requestId)?.status === 'resolving';
  }

  /**
   * Resolve `requestId` with `optionId`. A second call for the *same*
   * requestId while one is already in flight is a no-op — the duplicate-
   * decision guard the runtime's own invalid-state check (see
   * `packages/runtime/.../session/cell.ts#resolvePermission`) backs up as
   * defense in depth. A concurrent call for a *different* requestId proceeds
   * independently; requests are never cross-attributed.
   */
  resolve(requestId: string, optionId: string): void {
    if (this.isResolving(requestId)) return;
    this.lastOptionId.set(requestId, optionId);
    this._run(requestId, optionId);
  }

  /** Retry the last-attempted option for a request currently tracked in the `error` state. No-op if there is nothing to retry. */
  retry(requestId: string): void {
    if (this.isResolving(requestId)) return;
    const optionId = this.lastOptionId.get(requestId);
    if (optionId === undefined) return;
    this._run(requestId, optionId);
  }

  /**
   * Drop tracked state for any requestId no longer present in
   * `activeRequestIds` — the turn ended, the agent cancelled the request, or
   * it settled through this same controller. Call whenever the underlying
   * pending-permissions list changes so state never lingers for a request
   * the UI can no longer show.
   */
  prune(activeRequestIds: ReadonlySet<string>): void {
    for (const requestId of [...this.entries.keys()]) {
      if (!activeRequestIds.has(requestId)) {
        this.entries.delete(requestId);
        this.lastOptionId.delete(requestId);
      }
    }
  }

  private _run(requestId: string, optionId: string): void {
    this.entries.set(requestId, { status: 'resolving' });
    this.callbacks.onChange();
    void this.resolveFn(requestId, optionId)
      .then((result) => {
        if (result.success) {
          this.entries.delete(requestId);
          return;
        }
        this._recordFailure(requestId, result.error);
      })
      .catch((error: unknown) => {
        this._recordFailure(requestId, error);
      })
      .finally(() => {
        this.callbacks.onChange();
      });
  }

  private _recordFailure(requestId: string, error: unknown): void {
    if (!this.callbacks.isPending(requestId)) {
      // Superseded before the response arrived — nothing left to retry or
      // report on; drop it silently instead of resurrecting a stale banner.
      this.entries.delete(requestId);
      return;
    }
    this.entries.set(requestId, { status: 'error', message: describeError(error) });
  }
}
