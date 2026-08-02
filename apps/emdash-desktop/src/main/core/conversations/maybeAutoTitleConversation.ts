import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { conversations } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { parseDefaultConversationTitleIndex } from '@shared/core/conversations/conversation-title';
import { conversationChangedChannel } from '@shared/core/conversations/conversationEvents';
import { conversationEvents } from './conversation-events';

const CONVERSATION_TITLE_TARGET_LENGTH = 48;
const ELLIPSIS = '…';

type AutoTitleDb = Pick<typeof db, 'select' | 'update'>;

export type AutoTitleResult = {
  applied: boolean;
  title?: string;
};

export function deriveConversationTitle(prompt: string): string | null {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return null;

  const normalized = firstLine.trim().replace(/\s+/g, ' ');
  if (!normalized || /^\/\S+$/.test(normalized)) return null;
  if (normalized.length <= CONVERSATION_TITLE_TARGET_LENGTH) return normalized;

  const contentLimit = CONVERSATION_TITLE_TARGET_LENGTH - ELLIPSIS.length;
  const boundary = normalized.lastIndexOf(' ', contentLimit);
  const excerpt = normalized.slice(0, boundary > 0 ? boundary : contentLimit).trimEnd();
  return excerpt ? `${excerpt}${ELLIPSIS}` : null;
}

/**
 * Applies a prompt-derived title only while the stored title is still the provider placeholder.
 * Failures are deliberately best-effort: cosmetic titling must never block a conversation run.
 */
export async function maybeAutoTitleConversation(
  conversationId: string,
  prompt: string,
  database: AutoTitleDb = db
): Promise<AutoTitleResult> {
  const title = deriveConversationTitle(prompt);
  if (!title) return { applied: false };

  try {
    const [existing] = await database
      .select({
        title: conversations.title,
        providerId: conversations.provider,
        projectId: conversations.projectId,
        taskId: conversations.taskId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (
      !existing?.providerId ||
      parseDefaultConversationTitleIndex(existing.title, existing.providerId) === null
    ) {
      return { applied: false, title: existing?.title };
    }

    const updated = await database
      .update(conversations)
      .set({ title })
      .where(and(eq(conversations.id, conversationId), eq(conversations.title, existing.title)))
      .returning({ id: conversations.id });

    if (updated.length === 0) return { applied: false };

    conversationEvents._emit(
      'conversation:renamed',
      conversationId,
      existing.projectId,
      existing.taskId,
      title
    );
    events.emit(conversationChangedChannel, {
      conversationId,
      projectId: existing.projectId,
      taskId: existing.taskId,
      changes: { title },
    });

    return { applied: true, title };
  } catch (error) {
    log.warn('Conversation auto-title failed', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { applied: false };
  }
}
