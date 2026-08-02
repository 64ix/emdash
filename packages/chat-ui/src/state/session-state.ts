/**
 * Session-level chat state — permissions, plan, pending prompt, terminal
 * outputs, and the Stop/cancel busy flag.
 *
 * Extracted from chat-state.ts (rather than kept inline) so it can be
 * imported without pulling in `createParseCaches`/`parse.ts`, which requires
 * a DOM at module-load time. This lets unit tests exercise the session-state
 * primitives directly from the `node` test project — same reasoning as
 * `view-state.ts`.
 */

import { createMemo, createSignal } from 'solid-js';
import type { AcpPermissionRequest, ChatImageAttachment, PlanState } from '../model';

export type ChatSessionState = {
  readonly state: ChatSessionSnapshot;
  setPermissions(permissions: readonly AcpPermissionRequest[]): void;
  setPlan(plan: PlanState | null): void;
  setPendingPrompt(prompt: PendingPrompt | null): void;
  setTerminalOutput(terminalId: string, text: string | null): void;
  setTerminalOutputs(outputs: ReadonlyMap<string, string>): void;
  /**
   * Marks whether a Stop/cancel request for the active turn is currently in
   * flight. Driven by the host (see AcpChatStore.stop) so the transcript's
   * active-message Stop affordance can disable itself and communicate a busy
   * state while cancellation is pending, independent of `turnStatus`.
   */
  setStopPending(pending: boolean): void;
};

export type ChatSessionSnapshot = {
  readonly permissions: readonly AcpPermissionRequest[];
  readonly plan: PlanState | null;
  readonly pendingToolCallIds: Set<string>;
  readonly pendingPrompt: PendingPrompt | null;
  /** True while a Stop/cancel request for the active turn is in flight. */
  readonly stopPending: boolean;
  terminalOutputText(terminalId: string): string | null;
};

export type PendingPrompt = {
  id: string;
  text: string;
  attachments?: ChatImageAttachment[];
};

export function createSessionState(): ChatSessionState {
  const [permissions, setPermissions] = createSignal<readonly AcpPermissionRequest[]>([]);
  const [plan, setPlan] = createSignal<PlanState | null>(null);
  const [pendingPrompt, setPendingPrompt] = createSignal<PendingPrompt | null>(null);
  const [stopPending, setStopPending] = createSignal(false);
  const [terminalOutputs, setTerminalOutputs] = createSignal<ReadonlyMap<string, string>>(
    new Map()
  );
  const pendingToolCallIds = createMemo(() => {
    const ids = new Set<string>();
    for (const request of permissions()) {
      ids.add(request.toolCall.toolCallId);
    }
    return ids;
  });

  const state: ChatSessionSnapshot = {
    get permissions() {
      return permissions();
    },
    get plan() {
      return plan();
    },
    get pendingToolCallIds() {
      return pendingToolCallIds();
    },
    get pendingPrompt() {
      return pendingPrompt();
    },
    get stopPending() {
      return stopPending();
    },
    terminalOutputText(terminalId) {
      return terminalOutputs().get(terminalId) ?? null;
    },
  };

  return {
    state,
    setPermissions: (next) => setPermissions([...next]),
    setPlan,
    setPendingPrompt,
    setStopPending,
    setTerminalOutput(terminalId, text) {
      setTerminalOutputs((previous) => {
        const next = new Map(previous);
        if (text === null) {
          next.delete(terminalId);
        } else {
          next.set(terminalId, text);
        }
        return next;
      });
    },
    setTerminalOutputs: (next) => setTerminalOutputs(new Map(next)),
  };
}
