import type { AgentProviderId } from '@emdash/plugins/agents';
import { events } from '@main/lib/events';
import { ptyDataChannel, ptyExitChannel, ptyInputChannel } from '@shared/core/pty/ptyEvents';
import { ptyStartedChannel } from '@shared/events/appEvents';
import type { Pty, PtyExitInfo } from './pty';

export interface PtySessionMetadata {
  providerId?: AgentProviderId;
  title?: string;
  isRemote?: boolean;
}

const FLUSH_INTERVAL_MS = 16; // ~60 fps
const RING_BUFFER_CAP = 64 * 1024; // 64 KB per session

/** Result of {@link PtySessionRegistry.subscribe}. */
export interface PtySubscribeResult {
  /** Data to write to the terminal now (full snapshot or delta since sinceOffset). */
  buffer: string;
  /** Cumulative length of all data ever produced by this session incarnation. */
  totalBytes: number;
  /**
   * True when the caller's cursor could not be honored (data scrolled out of
   * the ring buffer, or the cursor predates a respawn of this session id).
   * The caller must reset its terminal before writing `buffer`.
   */
  truncated: boolean;
}

export class PtySessionRegistry {
  private ptyMap: Map<string, Pty> = new Map();
  private ptyInputSubscriptions: Map<string, () => void> = new Map();
  private ringBuffers: Map<string, string> = new Map();
  /** Cumulative data length per session — the backend end of the renderer replay cursors. */
  private totalBytes: Map<string, number> = new Map();
  private activeConsumers: Set<string> = new Set();
  private metadata: Map<string, PtySessionMetadata> = new Map();
  private lastSizes: Map<string, { cols: number; rows: number }> = new Map();
  private pendingFlushes: Map<string, () => void> = new Map();

  register(
    sessionId: string,
    pty: Pty,
    options?: { preserveBufferOnExit?: boolean; metadata?: PtySessionMetadata }
  ): void {
    const preserveBufferOnExit = options?.preserveBufferOnExit ?? false;

    // Clear any stale ring buffer and consumer from a previous PTY at this sessionId (respawn)
    this.ptyInputSubscriptions.get(sessionId)?.();
    this.ptyInputSubscriptions.delete(sessionId);
    this.pendingFlushes.delete(sessionId);
    this.ringBuffers.delete(sessionId);
    this.totalBytes.delete(sessionId);
    this.activeConsumers.delete(sessionId);
    this.metadata.delete(sessionId);
    if (options?.metadata) this.metadata.set(sessionId, options.metadata);

    this.ptyMap.set(sessionId, pty);

    let buffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (this.ptyMap.get(sessionId) !== pty) {
        buffer = '';
        flushTimer = null;
        return;
      }
      // Only deliver to IPC when a renderer consumer is attached. Hidden
      // FrontendPtys unsubscribe while off-screen; the ring buffer below keeps
      // accumulating either way, so replay for late subscribers stays intact.
      if (buffer && this.activeConsumers.has(sessionId)) {
        events.emit(ptyDataChannel, buffer, sessionId);
      }
      buffer = '';
      flushTimer = null;
    };
    this.pendingFlushes.set(sessionId, flush);

    pty.onData((data) => {
      if (this.ptyMap.get(sessionId) !== pty) return;
      buffer += data;
      this.totalBytes.set(sessionId, (this.totalBytes.get(sessionId) ?? 0) + data.length);
      if (!flushTimer) {
        flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
      // Accumulate into ring buffer for late-connecting renderers
      let rb = (this.ringBuffers.get(sessionId) ?? '') + data;
      if (rb.length > RING_BUFFER_CAP) rb = rb.slice(-RING_BUFFER_CAP);
      this.ringBuffers.set(sessionId, rb);
    });

    pty.onExit((info) => {
      const isCurrentPty = this.ptyMap.get(sessionId) === pty;
      if (!isCurrentPty) return;

      // Flush any buffered output before emitting exit
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flush();
      }
      events.emit(ptyExitChannel, info, sessionId);
      if (preserveBufferOnExit) {
        // Partial cleanup: keep ring buffer so late-connecting renderers can replay output
        this.ptyMap.delete(sessionId);
        this.ptyInputSubscriptions.get(sessionId)?.();
        this.ptyInputSubscriptions.delete(sessionId);
        this.pendingFlushes.delete(sessionId);
        this.lastSizes.delete(sessionId);
      } else {
        this.unregister(sessionId);
      }
    });

    const off = events.on(
      ptyInputChannel,
      (data) => {
        pty.write(data);
      },
      sessionId
    );

    this.ptyInputSubscriptions.set(sessionId, off);
    events.emit(ptyStartedChannel, { id: sessionId });
  }

  unregister(sessionId: string, options: { pty?: Pty; exitInfo?: PtyExitInfo } = {}): void {
    if (options.pty !== undefined && this.ptyMap.get(sessionId) !== options.pty) return;
    this.pendingFlushes.get(sessionId)?.();
    if (options.exitInfo !== undefined) {
      events.emit(ptyExitChannel, options.exitInfo, sessionId);
    }
    this.ptyMap.delete(sessionId);
    this.ptyInputSubscriptions.get(sessionId)?.();
    this.ptyInputSubscriptions.delete(sessionId);
    this.pendingFlushes.delete(sessionId);
    this.ringBuffers.delete(sessionId);
    this.totalBytes.delete(sessionId);
    this.activeConsumers.delete(sessionId);
    this.metadata.delete(sessionId);
    this.lastSizes.delete(sessionId);
  }

  get(sessionId: string): Pty | undefined {
    return this.ptyMap.get(sessionId);
  }

  /**
   * Atomically snapshot the ring buffer and register a consumer for future
   * IPC delivery. Non-destructive — the ring buffer is kept intact.
   * Safe: runs in one synchronous tick — no PTY data can arrive between
   * snapshot and consumer registration.
   *
   * With `sinceOffset` (renderer replay cursor, in cumulative data-length
   * units as reported by a previous call's `totalBytes`), only the delta after
   * that cursor is returned. If the cursor can no longer be honored — its data
   * scrolled out of the 64 KB ring buffer, or the session was respawned and
   * the cursor predates the current incarnation — `truncated` is true and the
   * full snapshot is returned instead; the caller must reset its terminal.
   */
  subscribe(sessionId: string, sinceOffset?: number): PtySubscribeResult {
    const buf = this.ringBuffers.get(sessionId) ?? '';
    const total = this.totalBytes.get(sessionId) ?? 0;
    const startOffset = total - buf.length;

    let buffer = buf;
    let truncated = false;
    if (sinceOffset !== undefined) {
      if (sinceOffset >= startOffset && sinceOffset <= total) {
        // Cursor still fully retained — deliver only what the caller missed.
        buffer = buf.slice(sinceOffset - startOffset);
      } else {
        // Gap (scrolled out or stale incarnation) — force a full replay.
        truncated = true;
      }
    }

    this.activeConsumers.add(sessionId);
    return { buffer, totalBytes: total, truncated };
  }

  /**
   * Remove the consumer registration for a session.
   * Called when the renderer disposes its FrontendPty.
   */
  unsubscribe(sessionId: string): void {
    this.activeConsumers.delete(sessionId);
  }

  getMetadata(sessionId: string): PtySessionMetadata | undefined {
    return this.metadata.get(sessionId);
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const pty = this.ptyMap.get(sessionId);
    if (!pty) return false;
    this.lastSizes.set(sessionId, { cols, rows });
    pty.resize(cols, rows);
    return true;
  }

  getLastSize(sessionId: string): { cols: number; rows: number } | undefined {
    return this.lastSizes.get(sessionId);
  }

  /** Active PTYs with local OS PID; SSH entries have `pid: undefined`. */
  listActiveSessions(): Array<{
    sessionId: string;
    pid: number | undefined;
    metadata?: PtySessionMetadata;
  }> {
    const out: Array<{
      sessionId: string;
      pid: number | undefined;
      metadata?: PtySessionMetadata;
    }> = [];
    for (const [sessionId, pty] of this.ptyMap) {
      out.push({
        sessionId,
        pid: pty.getPid?.(),
        metadata: this.metadata.get(sessionId),
      });
    }
    return out;
  }
}

export const ptySessionRegistry = new PtySessionRegistry();
