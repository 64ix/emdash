import { toJS } from 'mobx';
import type { StartSessionInput } from '@renderer/lib/acp/runtime-client';
import type { Conversation } from '@shared/core/conversations/conversations';

export type AcpStartInputSource = {
  conversationId: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  workspacePath: string;
  conversation: Conversation;
};

/**
 * Builds the ACP session-start wire input from a conversation's own settings:
 * provider, model, queued initial prompts, and the auto-approve toggle. The
 * conversation-scoped `autoApprove` is copied verbatim (defaulting to false)
 * so the connection pool can key spawned processes on it per conversation.
 */
export function buildAcpStartInput(source: AcpStartInputSource): StartSessionInput {
  const { conversation } = source;
  const initialQueue =
    conversation.sessionId === undefined && conversation.initialQueue?.length
      ? toJS(conversation.initialQueue)
      : undefined;

  return {
    conversationId: source.conversationId,
    projectId: source.projectId,
    taskId: source.taskId,
    providerId: conversation.providerId,
    workspaceId: source.workspaceId,
    cwd: source.workspacePath,
    sessionId: conversation.sessionId ?? null,
    model: conversation.model ?? null,
    autoApprove: conversation.autoApprove ?? false,
    ...(initialQueue && { initialQueue }),
  };
}
