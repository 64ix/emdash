import { err, ok, type Result } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { createStopController } from './acp-chat-stop-controller';

/**
 * These tests exercise the seam between "user activation" (calling
 * `controller.stop()`, which is exactly what AcpChatStore.stop() and — via
 * transcriptCommands.onStop in acp-chat-panel.tsx — the active-message Stop
 * button in the transcript both call) and "the runtime cancellation seam"
 * (the injected `cancelTurn`, which stands in for
 * `AcpLiveSession.cancelTurn()` → the ACP session's `cancelTurn` RPC).
 */

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Flushes the microtask queue (the `.then().catch().finally()` chain needs a few hops). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createStopController', () => {
  it('calls cancelTurn and reports busy while the request is in flight', async () => {
    const gate = deferred<Result<void, unknown>>();
    const cancelTurn = vi.fn(() => gate.promise);
    const onBusyChange = vi.fn();
    const onError = vi.fn();
    const controller = createStopController(cancelTurn, { onBusyChange, onError });

    expect(controller.isCancelling).toBe(false);

    controller.stop();

    expect(cancelTurn).toHaveBeenCalledTimes(1);
    expect(controller.isCancelling).toBe(true);
    expect(onBusyChange).toHaveBeenNthCalledWith(1, true);

    gate.resolve(ok());
    await flush();

    expect(controller.isCancelling).toBe(false);
    expect(onBusyChange).toHaveBeenNthCalledWith(2, false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('sends only one cancellation request when activated repeatedly before settling', async () => {
    const gate = deferred<Result<void, unknown>>();
    const cancelTurn = vi.fn(() => gate.promise);
    const controller = createStopController(cancelTurn, {
      onBusyChange: () => {},
      onError: () => {},
    });

    // Simulate rapid repeated activation: double-click, and the composer's
    // Stop button + the transcript row's Stop action both firing.
    controller.stop();
    controller.stop();
    controller.stop();

    expect(cancelTurn).toHaveBeenCalledTimes(1);

    gate.resolve(ok());
    await flush();

    expect(controller.isCancelling).toBe(false);
  });

  it('surfaces a failure Result as retryable: stop() works again after settling', async () => {
    const onError = vi.fn();
    const cancelTurn = vi
      .fn<() => Promise<Result<void, unknown>>>()
      .mockResolvedValueOnce(err(new Error('agent unreachable')))
      .mockResolvedValueOnce(ok());
    const onBusyChange = vi.fn();
    const controller = createStopController(cancelTurn, { onBusyChange, onError });

    controller.stop();
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    // The busy flag must have reset so the control is retryable, not stuck disabled.
    expect(controller.isCancelling).toBe(false);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);

    // Retry: a second activation must reach the runtime cancellation seam again.
    controller.stop();
    expect(cancelTurn).toHaveBeenCalledTimes(2);
    await flush();

    expect(controller.isCancelling).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('surfaces a thrown/rejected cancelTurn the same way as a failure Result', async () => {
    const onError = vi.fn();
    const cancelTurn = vi.fn(() => Promise.reject(new Error('transport closed')));
    const controller = createStopController(cancelTurn, { onBusyChange: () => {}, onError });

    controller.stop();
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.isCancelling).toBe(false);
  });

  it('is idempotent and safe when the turn already ended before the request lands', async () => {
    // Mirrors the ACP session machine's `Cancel` transition when there is no
    // active turn: it resolves a success Result rather than an error, so a
    // stop() that races the turn's natural completion settles quietly.
    const onError = vi.fn();
    const cancelTurn = vi.fn(() => Promise.resolve(ok<void>()));
    const controller = createStopController(cancelTurn, { onBusyChange: () => {}, onError });

    expect(() => controller.stop()).not.toThrow();
    await flush();

    expect(cancelTurn).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(controller.isCancelling).toBe(false);
  });

  it('does not throw when the host has no active session (cancelTurn optional-chains to undefined)', async () => {
    // Exact shape used by AcpChatStore: `() => this.session?.cancelTurn() ?? Promise.resolve(ok())`.
    type SessionLike = { cancelTurn(): Promise<Result<void, unknown>> };
    const getSession = (): SessionLike | null => null;
    const onError = vi.fn();
    const controller = createStopController(
      () => getSession()?.cancelTurn() ?? Promise.resolve(ok<void>()),
      { onBusyChange: () => {}, onError }
    );

    expect(() => controller.stop()).not.toThrow();
    await flush();

    expect(onError).not.toHaveBeenCalled();
    expect(controller.isCancelling).toBe(false);
  });
});
