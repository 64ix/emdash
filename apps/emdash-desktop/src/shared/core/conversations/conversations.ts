import type { AgentProviderId } from '@emdash/plugins/agents';
import type { AgentStatus } from '@shared/core/agents/agentEvents';

export const MAX_CONVERSATION_TITLE_LENGTH = 100;

export type ConversationType = 'pty' | 'acp';

/**
 * Machine-local origin of a conversation row: 'local' when created on this
 * machine, 'imported' when it arrived via multi-machine sync (set by the sync
 * engine at import; never transported in the sync payload, like `sessionId`).
 * An imported conversation has no session on this machine until one is
 * created, so the list marks it "not resumable on this device".
 */
export type ConversationSource = 'local' | 'imported';

export type InitialQueuePrompt = {
  text: string;
  hiddenContext?: string;
};

export type Conversation = {
  id: string;
  projectId: string;
  taskId: string;
  providerId: AgentProviderId;
  title: string;
  lastInteractedAt: string | null;
  /** Machine-local origin; 'imported' marks rows that arrived via sync. */
  source?: ConversationSource;
  resume?: boolean;
  autoApprove?: boolean;
  /**
   * The agent-facing session identifier. Null / absent means the conversation has never spawned.
   * For providers that accept a supplied id (most PTY), this is set to conversation.id before
   * first spawn and may later be overwritten by the agent's own native id (e.g. Droid UUID).
   * For ACP, set to the id returned by newSession/loadSession.
   * Resume with this id when sessionId !== conversation.id; treat as fresh otherwise.
   */
  sessionId?: string;
  /** Model to pass to the agent CLI. Absent or empty string means use the CLI default. */
  model?: string;
  /** Initial queued prompts to deliver on first ACP spawn. Only present before sessionId is set. */
  initialQueue?: InitialQueuePrompt[];
  isInitialConversation: boolean | null;
  agentStatus?: AgentStatus | null;
  agentStatusSeen?: boolean;
  /** Transport type: 'pty' (default) uses the terminal/PTY path; 'acp' uses the Agent Client Protocol. */
  type?: ConversationType;
};

export type RenameConversationParams = {
  conversationId: string;
  newTitle: string;
};

export type CreateConversationParams = {
  id: string;
  projectId: string;
  taskId: string;
  provider: AgentProviderId;
  title: string;
  autoApprove?: boolean;
  /** Model to pass to the agent CLI. Absent or empty string means use the CLI default. */
  model?: string;
  isInitialConversation?: boolean;
  initialSize?: { cols: number; rows: number };
  initialPrompt?: string;
  initialQueue?: InitialQueuePrompt[];
  /** Transport type: 'pty' (default) uses the terminal/PTY path; 'acp' uses the Agent Client Protocol. */
  type?: ConversationType;
};
