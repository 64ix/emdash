import type { LinkSuggestion } from '@shared/core/issues/link-suggestion';
import { defineEvent } from '@shared/lib/ipc/events';

/**
 * Emitted after an inbound issues-sync pass changes the cached link
 * suggestions for a project's GitHub repository (a fresh suggestion appeared,
 * one was accepted, or one was dismissed). Not emitted when a sync pass finds
 * no change — see the "Idempotent pass" criterion on ticket #8.
 */
export const linkSuggestionsUpdatedChannel = defineEvent<{
  projectId: string;
  repositoryUrl: string;
  suggestions: LinkSuggestion[];
}>('issues:link-suggestions-updated');
