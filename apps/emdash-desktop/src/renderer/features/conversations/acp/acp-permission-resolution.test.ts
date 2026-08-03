import { err, ok, type Result } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { PermissionResolutionController } from './acp-permission-resolution';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('PermissionResolutionController', () => {
  it('tracks resolving state and clears it once the request succeeds', async () => {
    const { promise, resolve } = deferred<Result<void, unknown>>();
    const resolveFn = vi.fn(() => promise);
    const onChange = vi.fn();
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => true,
      onChange,
    });

    controller.resolve('req-1', 'allow-once');
    expect(controller.stateFor('req-1')).toEqual({ status: 'resolving' });
    expect(onChange).toHaveBeenCalledTimes(1);

    resolve(ok());
    await promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stateFor('req-1')).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('guards against a duplicate decision for the same request while resolving', () => {
    const resolveFn = vi.fn(() => new Promise<Result<void, unknown>>(() => {}));
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => true,
      onChange: () => {},
    });

    controller.resolve('req-1', 'allow-once');
    controller.resolve('req-1', 'reject-once'); // second click before the first settles
    controller.resolve('req-1', 'allow-always');

    expect(resolveFn).toHaveBeenCalledTimes(1);
    expect(resolveFn).toHaveBeenCalledWith('req-1', 'allow-once');
  });

  it('surfaces a retryable error when the request is still pending after a failure', async () => {
    const resolveFn = vi.fn(() => Promise.resolve(err(new Error('transport hiccup'))));
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => true,
      onChange: () => {},
    });

    controller.resolve('req-1', 'allow-once');
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stateFor('req-1')).toEqual({
      status: 'error',
      message: 'transport hiccup',
    });
  });

  it('suppresses a stale failure once the request is no longer pending (turn ended / agent cancellation)', async () => {
    const resolveFn = vi.fn(() => Promise.resolve(err(new Error('invalid state'))));
    // Simulate the request having already disappeared from the live queue by
    // the time the response arrives.
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => false,
      onChange: () => {},
    });

    controller.resolve('req-1', 'allow-once');
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stateFor('req-1')).toBeUndefined();
  });

  it('retry re-attempts the last-chosen option for the same request', async () => {
    let call = 0;
    const resolveFn = vi.fn((): Promise<Result<void, unknown>> => {
      call += 1;
      return Promise.resolve(call === 1 ? err(new Error('network down')) : ok());
    });
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => true,
      onChange: () => {},
    });

    controller.resolve('req-1', 'reject-once');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.stateFor('req-1')?.status).toBe('error');

    controller.retry('req-1');
    expect(resolveFn).toHaveBeenLastCalledWith('req-1', 'reject-once');
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stateFor('req-1')).toBeUndefined();
    expect(resolveFn).toHaveBeenCalledTimes(2);
  });

  it('retry is a no-op when there is nothing tracked to retry', () => {
    const resolveFn = vi.fn(() => Promise.resolve(ok<void>()));
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => true,
      onChange: () => {},
    });

    controller.retry('never-attempted');

    expect(resolveFn).not.toHaveBeenCalled();
  });

  it('resolves two different, concurrently in-flight requests independently, without cross-attribution', async () => {
    const first = deferred<Result<void, unknown>>();
    const second = deferred<Result<void, unknown>>();
    const resolveFn = vi.fn((requestId: string) =>
      requestId === 'req-1' ? first.promise : second.promise
    );
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => true,
      onChange: () => {},
    });

    controller.resolve('req-1', 'allow-once');
    controller.resolve('req-2', 'reject-once'); // a second, unrelated request arrives mid-flight

    expect(controller.stateFor('req-1')).toEqual({ status: 'resolving' });
    expect(controller.stateFor('req-2')).toEqual({ status: 'resolving' });

    // req-2 fails while req-1 is still pending — must not affect req-1's state.
    second.resolve(err(new Error('req-2 failed')));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stateFor('req-1')).toEqual({ status: 'resolving' });
    expect(controller.stateFor('req-2')).toEqual({ status: 'error', message: 'req-2 failed' });

    // req-1 then succeeds — must not disturb req-2's still-tracked error.
    first.resolve(ok());
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stateFor('req-1')).toBeUndefined();
    expect(controller.stateFor('req-2')).toEqual({ status: 'error', message: 'req-2 failed' });
  });

  it('prune removes only the requests no longer active, leaving others untouched', async () => {
    const resolveFn = vi.fn(() => Promise.resolve(err(new Error('boom'))));
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => true,
      onChange: () => {},
    });

    controller.resolve('req-1', 'allow-once');
    controller.resolve('req-2', 'allow-once');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.stateFor('req-1')?.status).toBe('error');
    expect(controller.stateFor('req-2')?.status).toBe('error');

    controller.prune(new Set(['req-2']));

    expect(controller.stateFor('req-1')).toBeUndefined();
    expect(controller.stateFor('req-2')?.status).toBe('error');

    // A pruned request's retry state is gone too — retry must not resurrect it.
    controller.retry('req-1');
    expect(resolveFn).toHaveBeenCalledTimes(2); // only the two initial resolve() calls
  });

  it('describes a rejection with no message using a safe fallback', async () => {
    const resolveFn = vi.fn(() => Promise.reject(new Error('')));
    const controller = new PermissionResolutionController(resolveFn, {
      isPending: () => true,
      onChange: () => {},
    });

    controller.resolve('req-1', 'allow-once');
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stateFor('req-1')).toEqual({
      status: 'error',
      message: 'Failed to resolve the permission request. You can try again.',
    });
  });
});
