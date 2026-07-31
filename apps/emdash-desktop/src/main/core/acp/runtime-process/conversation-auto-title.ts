import type { AcpApiContract } from '@emdash/core/acp';
import type { ContractClient } from '@emdash/wire/api';
import { maybeAutoTitleConversation } from '@main/core/conversations/maybeAutoTitleConversation';

type AcpRuntimeClient = ContractClient<AcpApiContract>;

/** Captures prompt intent before dispatch so provider failures cannot shift the title to a later prompt. */
export function withConversationAutoTitle(client: AcpRuntimeClient): AcpRuntimeClient {
  return {
    ...client,
    startSession: async (input, meta) => {
      const prompt = input.input.initialQueue?.[0]?.text;
      if (prompt) {
        await maybeAutoTitleConversation(input.input.conversationId, prompt);
      }
      return client.startSession(input, meta);
    },
    sendPrompt: async (input, meta) => {
      await maybeAutoTitleConversation(input.conversationId, input.prompt.text);
      return client.sendPrompt(input, meta);
    },
    queuePrompt: async (input, meta) => {
      await maybeAutoTitleConversation(input.conversationId, input.prompt.text);
      return client.queuePrompt(input, meta);
    },
  };
}
