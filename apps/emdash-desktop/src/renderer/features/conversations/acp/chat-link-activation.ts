/**
 * chat-link-activation.ts — the single async entry point every chat-authored
 * link click (Markdown prose links and resource-link rows alike) is wired
 * through from `AcpChatPanel`'s `ChatCommands.onActivateLink`.
 *
 * This is intentionally the *only* place that turns a `ChatLinkAction` (see
 * `chat-link-classification.ts`) into an effect: open the existing task
 * editor, hand off to the existing external-link confirmation flow, or
 * report an explicit blocked target with a copy action. There is no raw
 * anchor/window.open fallback anywhere in this path.
 */

import { openFileInTaskEditor } from '@renderer/features/tasks/stores/open-file-in-file-editor';
import { getWorkspaceForTask } from '@renderer/features/tasks/stores/task-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { classifyChatLink, type ChatLinkBlockReason } from './chat-link-classification';

export type ChatLinkActivationSource = 'prose-link' | 'resource-link';

export type ChatLinkActivationArg = {
  href: string;
  itemId: string;
  source: ChatLinkActivationSource;
};

export type ChatLinkTaskContext = {
  projectId: string;
  taskId: string;
};

/**
 * Classifies `arg.href` and performs exactly one typed action. Fire-and-forget
 * from the caller's perspective (mirrors the other `ChatCommands` callbacks,
 * which are synchronous void handlers); errors within the async work are
 * reported via the same toast path used for blocked targets, never thrown
 * back into the caller.
 *
 * `performActivation` can reject (e.g. a thrown/rejected RPC call inside
 * `openFileInTaskEditor`) — without a `.catch` here that would surface only
 * as an unhandled promise rejection, silently dropping the failure instead of
 * telling the user their click did nothing.
 */
export function activateChatLink(
  arg: ChatLinkActivationArg,
  context: ChatLinkTaskContext | null
): void {
  void performActivation(arg, context).catch(() => {
    reportActivationFailure(arg.href);
  });
}

async function performActivation(
  arg: ChatLinkActivationArg,
  context: ChatLinkTaskContext | null
): Promise<void> {
  const workspaceRoot = context
    ? (getWorkspaceForTask(context.projectId, context.taskId)?.path ?? null)
    : null;
  const action = classifyChatLink(arg.href, { workspaceRoot });

  switch (action.kind) {
    case 'workspace-file': {
      // Unreachable when `context` is null: classifyChatLink only returns
      // `workspace-file` when a non-null workspaceRoot was supplied above,
      // which itself requires a non-null `context`.
      if (!context) return;
      await openFileInTaskEditor(context.projectId, context.taskId, action.path);
      return;
    }
    case 'external-http':
      confirmOpenExternalLink(action.url);
      return;
    case 'blocked':
      reportBlockedChatLink(action.reason, action.target);
      return;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function reportActivationFailure(href: string): void {
  toast({
    title: 'Could not open link',
    description: href,
    variant: 'destructive',
    action: {
      label: 'Copy',
      onClick: () => {
        void rpc.app.clipboardWriteText(href);
      },
    },
  });
}

function reportBlockedChatLink(reason: ChatLinkBlockReason, target: string): void {
  toast({
    title: blockedChatLinkTitle(reason),
    description: target,
    variant: 'destructive',
    action: {
      label: 'Copy',
      onClick: () => {
        void rpc.app.clipboardWriteText(target);
      },
    },
  });
}

export function blockedChatLinkTitle(reason: ChatLinkBlockReason): string {
  switch (reason) {
    case 'outside-workspace':
      return 'File is outside the workspace';
    case 'unsupported-scheme':
    case 'suspicious-authority':
      return 'Link blocked';
    case 'malformed':
      return 'Link could not be opened';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
