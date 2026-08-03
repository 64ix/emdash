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
import type { ArtifactPreviewArtifact } from '@renderer/lib/components/artifact-preview-dialog';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import type { ArtifactPreviewDenialReason, ArtifactPreviewResult } from '@shared/core/fs/artifact-preview';
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
  const workspace = context ? getWorkspaceForTask(context.projectId, context.taskId) : undefined;
  const action = classifyChatLink(arg.href, { workspaceRoot: workspace?.path ?? null });

  switch (action.kind) {
    case 'workspace-file': {
      // Unreachable when `context` is null: classifyChatLink only returns
      // `workspace-file` when a non-null workspaceRoot was supplied above,
      // which itself requires a non-null `context`.
      if (!context) return;
      await openFileInTaskEditor(context.projectId, context.taskId, action.path);
      return;
    }
    case 'local-artifact': {
      // Unreachable when `context`/`workspace` is null — see the comment on
      // the `workspace-file` case above; the same argument applies here.
      if (!context || !workspace) return;
      await requestArtifactPreview(
        action.path,
        { projectId: context.projectId, workspaceId: workspace.workspaceId },
        false
      );
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

// ── Local artifact preview (ticket #21) ──────────────────────────────────────
//
// The renderer's classification of `action.path` as a `local-artifact`
// candidate is a UX hint only. Every call below still goes through the
// main-process `previewArtifact` RPC, which independently re-resolves and
// re-validates the path from scratch (trusted-root check, symlink-safe
// containment, size cap, and a magic-byte/binary-content sniff) before ever
// returning bytes — see `previewLocalArtifact` in the main process.

type ArtifactPreviewWorkspace = { projectId: string; workspaceId: string };

async function requestArtifactPreview(
  path: string,
  workspace: ArtifactPreviewWorkspace,
  confirmed: boolean
): Promise<void> {
  const result = await rpc.workspace.files.previewArtifact(
    workspace.projectId,
    workspace.workspaceId,
    path,
    confirmed
  );
  if (!result.success) {
    reportArtifactPreviewFailure(path);
    return;
  }
  handleArtifactPreviewResult(result.data, path, workspace);
}

function handleArtifactPreviewResult(
  preview: ArtifactPreviewResult,
  requestedPath: string,
  workspace: ArtifactPreviewWorkspace
): void {
  switch (preview.status) {
    case 'ok':
      showArtifactPreviewDialog(preview);
      return;
    case 'needs-confirmation':
      confirmArtifactPreview(preview.resolvedPath, workspace);
      return;
    case 'denied':
      reportArtifactPreviewDenial(preview.reason, preview.resolvedPath ?? requestedPath);
      return;
    default: {
      const exhaustive: never = preview;
      return exhaustive;
    }
  }
}

function confirmArtifactPreview(resolvedPath: string, workspace: ArtifactPreviewWorkspace): void {
  showModal('confirmActionModal', {
    title: 'Preview file outside the workspace?',
    description: resolvedPath,
    confirmLabel: 'Preview',
    variant: 'default',
    onSuccess: () => {
      // Not awaited from the modal callback's perspective — guard against an
      // unhandled rejection the same way `activateChatLink` guards its own
      // top-level entry point.
      void requestArtifactPreview(resolvedPath, workspace, true).catch(() => {
        reportArtifactPreviewFailure(resolvedPath);
      });
    },
  });
}

function showArtifactPreviewDialog(preview: Extract<ArtifactPreviewResult, { status: 'ok' }>): void {
  const artifact: ArtifactPreviewArtifact =
    preview.kind === 'image'
      ? { kind: 'image', dataUrl: preview.dataUrl, mimeType: preview.mimeType }
      : { kind: 'text', content: preview.content, contentType: preview.contentType };
  showModal('artifactPreviewModal', {
    name: basenameOfPath(preview.resolvedPath),
    path: preview.resolvedPath,
    artifact,
  });
}

function basenameOfPath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function reportArtifactPreviewFailure(path: string): void {
  toast({
    title: 'Could not preview file',
    description: path,
    variant: 'destructive',
    action: {
      label: 'Copy',
      onClick: () => {
        void rpc.app.clipboardWriteText(path);
      },
    },
  });
}

function reportArtifactPreviewDenial(reason: ArtifactPreviewDenialReason, target: string): void {
  toast({
    title: artifactPreviewDenialTitle(reason),
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

export function artifactPreviewDenialTitle(reason: ArtifactPreviewDenialReason): string {
  switch (reason) {
    case 'invalid-path':
      return 'File could not be opened';
    case 'traversal':
    case 'symlink-escape':
      return 'File is outside the workspace';
    case 'missing':
      return 'File not found';
    case 'directory':
      return 'That path is a folder, not a file';
    case 'oversized':
      return 'File is too large to preview';
    case 'type-mismatch':
      return "File content doesn't match its extension";
    case 'unsupported-content':
      return 'This file type cannot be previewed';
    default: {
      const exhaustive: never = reason;
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
