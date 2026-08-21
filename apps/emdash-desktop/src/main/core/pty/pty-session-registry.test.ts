import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ptyDataChannel, ptyExitChannel } from '@shared/core/pty/ptyEvents';
import { ptyStartedChannel } from '@shared/events/appEvents';
import type { Pty, PtyExitInfo } from './pty';
import { PtySessionRegistry } from './pty-session-registry';

vi.mock('@main/lib/events', () => ({
  events: {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}));

const { events } = await import('@main/lib/events');

function fakePty(): Pty & {
  emitData(data: string): void;
  emitExit(info: PtyExitInfo): void;
} {
  const dataHandlers: Array<(data: string) => void> = [];
  const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((handler) => dataHandlers.push(handler)),
    onExit: vi.fn((handler) => exitHandlers.push(handler)),
    emitData(data: string) {
      for (const handler of dataHandlers) handler(data);
    },
    emitExit(info: PtyExitInfo) {
      for (const handler of exitHandlers) handler(info);
    },
  };
}

describe('PtySessionRegistry', () => {
  beforeEach(() => {
    vi.mocked(events.emit).mockClear();
    vi.mocked(events.on).mockClear();
  });

  it('ignores stale data and exit cleanup from a replaced PTY', () => {
    const registry = new PtySessionRegistry();
    const first = fakePty();
    const second = fakePty();

    registry.register('session-1', first);
    registry.register('session-1', second);

    first.emitData('old output');
    first.emitExit({ exitCode: 0 });

    expect(registry.get('session-1')).toBe(second);
    expect(events.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pty:data' }),
      'old output',
      'session-1'
    );

    second.emitExit({ exitCode: 0 });

    expect(registry.get('session-1')).toBeUndefined();
  });

  it('does not flush buffered output from an old PTY after replacement', async () => {
    vi.useFakeTimers();
    try {
      const registry = new PtySessionRegistry();
      const first = fakePty();
      const second = fakePty();

      registry.register('session-1', first);
      first.emitData('old buffered output');
      registry.register('session-1', second);
      vi.mocked(events.emit).mockClear();

      await vi.advanceTimersByTimeAsync(16);

      expect(events.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'pty:data' }),
        'old buffered output',
        'session-1'
      );
      expect(registry.get('session-1')).toBe(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes buffered output to an active consumer when unregistering before the flush timer fires', () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();

    registry.register('session-1', pty);
    registry.subscribe('session-1');
    pty.emitData('final output');
    registry.unregister('session-1');

    expect(events.emit).toHaveBeenCalledWith(ptyDataChannel, 'final output', 'session-1');
  });

  it('does not emit pty:data without an active consumer but keeps the data for replay', async () => {
    vi.useFakeTimers();
    try {
      const registry = new PtySessionRegistry();
      const pty = fakePty();

      registry.register('session-1', pty);
      pty.emitData('hidden output');
      await vi.advanceTimersByTimeAsync(16);

      // No consumer attached: nothing is emitted over IPC...
      expect(events.emit).not.toHaveBeenCalledWith(ptyDataChannel, 'hidden output', 'session-1');

      // ...but a late subscriber still replays it from the ring buffer.
      const result = registry.subscribe('session-1');
      expect(result).toEqual({ buffer: 'hidden output', totalBytes: 13, truncated: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits pty:data to active consumers while they are subscribed', async () => {
    vi.useFakeTimers();
    try {
      const registry = new PtySessionRegistry();
      const pty = fakePty();

      registry.register('session-1', pty);
      registry.subscribe('session-1');
      pty.emitData('visible output');
      await vi.advanceTimersByTimeAsync(16);

      expect(events.emit).toHaveBeenCalledWith(ptyDataChannel, 'visible output', 'session-1');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('subscribe with sinceOffset', () => {
    it('returns the full buffer and cursor when no offset is given', () => {
      const registry = new PtySessionRegistry();
      const pty = fakePty();

      registry.register('session-1', pty);
      pty.emitData('hello');

      expect(registry.subscribe('session-1')).toEqual({
        buffer: 'hello',
        totalBytes: 5,
        truncated: false,
      });
    });

    it('returns only the delta after the requested offset', () => {
      const registry = new PtySessionRegistry();
      const pty = fakePty();

      registry.register('session-1', pty);
      pty.emitData('hello ');
      const first = registry.subscribe('session-1');
      expect(first).toEqual({ buffer: 'hello ', totalBytes: 6, truncated: false });

      pty.emitData('world');
      const second = registry.subscribe('session-1', first.totalBytes);
      expect(second).toEqual({ buffer: 'world', totalBytes: 11, truncated: false });
    });

    it('flags truncation when the offset scrolled out of the ring buffer', () => {
      const registry = new PtySessionRegistry();
      const pty = fakePty();

      registry.register('session-1', pty);
      // Overflow the 64 KB ring buffer so early data is dropped.
      pty.emitData('x'.repeat(70 * 1024));

      const result = registry.subscribe('session-1', 0);
      expect(result.truncated).toBe(true);
      expect(result.buffer.length).toBe(64 * 1024);
      expect(result.totalBytes).toBe(70 * 1024);
    });

    it('flags truncation when the offset predates a respawn of the session', () => {
      const registry = new PtySessionRegistry();
      const pty = fakePty();

      registry.register('session-1', pty);
      pty.emitData('first incarnation');
      registry.unregister('session-1');

      // Respawn resets the stream history for this session id.
      const respawned = fakePty();
      registry.register('session-1', respawned);
      respawned.emitData('second');

      const result = registry.subscribe('session-1', 17);
      expect(result.truncated).toBe(true);
      expect(result.buffer).toBe('second');
      expect(result.totalBytes).toBe(6);
    });

    it('accepts a cursor equal to totalBytes (nothing missed)', () => {
      const registry = new PtySessionRegistry();
      const pty = fakePty();

      registry.register('session-1', pty);
      pty.emitData('all seen');
      const first = registry.subscribe('session-1');
      registry.unsubscribe('session-1');

      const result = registry.subscribe('session-1', first.totalBytes);
      expect(result).toEqual({ buffer: '', totalBytes: 8, truncated: false });
    });
  });

  it('emits exit when unregistering the current PTY with exit info', () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();
    const exitInfo = { exitCode: 0 };

    registry.register('session-1', pty);
    registry.unregister('session-1', { pty, exitInfo });

    expect(events.emit).toHaveBeenCalledWith(ptyExitChannel, exitInfo, 'session-1');
  });

  it('does not emit exit or unregister when unregister is called for a stale PTY', () => {
    const registry = new PtySessionRegistry();
    const first = fakePty();
    const second = fakePty();
    const exitInfo = { exitCode: 0 };

    registry.register('session-1', first);
    registry.register('session-1', second);
    vi.mocked(events.emit).mockClear();

    registry.unregister('session-1', { pty: first, exitInfo });

    expect(registry.get('session-1')).toBe(second);
    expect(events.emit).not.toHaveBeenCalledWith(ptyExitChannel, exitInfo, 'session-1');
  });

  it('records resize dimensions before forwarding to the current PTY', () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();

    registry.register('session-1', pty);
    const resized = registry.resize('session-1', 120, 50);

    expect(resized).toBe(true);
    expect(pty.resize).toHaveBeenCalledWith(120, 50);
    expect(registry.getLastSize('session-1')).toEqual({ cols: 120, rows: 50 });
  });

  it('clears last observed size when preserving output after exit', () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();

    registry.register('session-1', pty, { preserveBufferOnExit: true });
    registry.resize('session-1', 120, 50);
    pty.emitExit({ exitCode: 0 });

    expect(registry.get('session-1')).toBeUndefined();
    expect(registry.getLastSize('session-1')).toBeUndefined();
  });

  it('emits a start event for every registered PTY', () => {
    const registry = new PtySessionRegistry();

    registry.register('session-1', fakePty());
    registry.register('session-1', fakePty());
    registry.register('session-2', fakePty());

    expect(events.emit).toHaveBeenCalledWith(ptyStartedChannel, { id: 'session-1' });
    expect(events.emit).toHaveBeenCalledWith(ptyStartedChannel, { id: 'session-2' });
    expect(
      vi
        .mocked(events.emit)
        .mock.calls.filter(
          ([channel, event]) =>
            channel === ptyStartedChannel &&
            typeof event === 'object' &&
            event !== null &&
            'id' in event &&
            event.id === 'session-1'
        )
    ).toHaveLength(2);
  });
});
