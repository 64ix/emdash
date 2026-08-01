import { err, type Result } from '@emdash/shared';
import { projectManager } from '@main/core/projects/project-manager';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import type { LinkSuggestion } from '@shared/core/issues/link-suggestion';
import type { CreateTaskError, CreateTaskSuccess } from '@shared/core/tasks/tasks';
import type {
  ConnectionStatus,
  ConnectionStatusMap,
  IssueContextResult,
  IssueListResult,
  IssueProviderType,
} from '@shared/issue-providers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  adoptGhostCard,
  getGhostCardsForProject,
  rejectGhostCard,
} from './inbound-sync/ghost-card-service';
import { issuesSyncScheduler } from './inbound-sync/issues-sync-scheduler';
import {
  acceptLinkSuggestion,
  adoptLinkSuggestion,
  dismissLinkSuggestion,
  getLinkSuggestionsForProject,
} from './inbound-sync/link-suggestions-service';
import type {
  IssueContextOpts,
  IssueProvider,
  IssueQueryOpts,
  IssueSearchOpts,
} from './issue-provider';
import { getAllIssueProviders, getIssueProvider } from './registry';

const DEFAULT_CAPABILITIES = {
  requiresProjectPath: false,
  requiresRepositoryUrl: false,
  supportsIssueContext: false,
} as const;

const CONNECTION_CHECK_TIMEOUT_MS = 8_000;

function timeoutStatus(provider: IssueProvider): ConnectionStatus {
  return {
    connected: false,
    error: `Connection check timed out after ${CONNECTION_CHECK_TIMEOUT_MS}ms.`,
    capabilities: provider.capabilities,
  };
}

function failureStatus(provider: IssueProvider, error: unknown): ConnectionStatus {
  const message = error instanceof Error ? error.message : 'Connection check failed.';
  return {
    connected: false,
    error: message,
    capabilities: provider.capabilities,
  };
}

async function checkProviderConfigured(provider: IssueProvider): Promise<boolean> {
  if (!provider.isConfigured) {
    return (await checkProviderConnection(provider)).connected;
  }

  try {
    return await provider.isConfigured();
  } catch {
    return false;
  }
}

async function checkProviderConnection(provider: IssueProvider): Promise<ConnectionStatus> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<ConnectionStatus>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(timeoutStatus(provider));
    }, CONNECTION_CHECK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([provider.checkConnection(), timeoutPromise]);
  } catch (error) {
    return failureStatus(provider, error);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function withResolvedRemote<T extends IssueQueryOpts>(opts: T): Promise<T> {
  if (!opts.projectId) return opts;
  const project = projectManager.getProject(opts.projectId);
  if (!project) return opts;

  const remote = await project.gitRepository.getBaseRemote().catch(() => undefined);
  const selectedRemote = opts.remote?.trim() || remote;
  const providedRepositoryUrl = opts.repositoryUrl?.trim();

  const remoteRepositoryUrl =
    !providedRepositoryUrl && selectedRemote
      ? (await project.gitRepository.getRemotes().catch(() => [])).find(
          (candidate) => candidate.name === selectedRemote
        )?.url
      : undefined;
  const repositoryUrl = providedRepositoryUrl ?? remoteRepositoryUrl;

  return { ...opts, remote: selectedRemote, repositoryUrl };
}

export const issueController = createRPCController({
  checkConnection: async (provider: IssueProviderType) => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return {
        connected: false,
        error: `Unknown provider: ${provider}`,
        capabilities: DEFAULT_CAPABILITIES,
      };
    }

    return checkProviderConnection(issueProvider);
  },

  checkAllConnections: async (): Promise<ConnectionStatusMap> => {
    const providers = getAllIssueProviders();

    const settled = await Promise.all(
      providers.map(async (provider) => {
        const status = await checkProviderConnection(provider);
        return [provider.type, status] as const;
      })
    );

    return Object.fromEntries(settled) as ConnectionStatusMap;
  },

  checkConfiguredConnections: async (): Promise<Record<IssueProviderType, boolean>> => {
    const providers = getAllIssueProviders();

    const settled = await Promise.all(
      providers.map(async (provider) => {
        const configured = await checkProviderConfigured(provider);
        return [provider.type, configured] as const;
      })
    );

    return Object.fromEntries(settled) as Record<IssueProviderType, boolean>;
  },

  listIssues: async (
    provider: IssueProviderType,
    opts: IssueQueryOpts
  ): Promise<IssueListResult> => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return err({ type: 'generic', message: `Unknown provider: ${provider}` });
    }

    return issueProvider.listIssues(await withResolvedRemote(opts));
  },

  searchIssues: async (
    provider: IssueProviderType,
    opts: IssueSearchOpts
  ): Promise<IssueListResult> => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return err({ type: 'generic', message: `Unknown provider: ${provider}` });
    }

    return issueProvider.searchIssues(await withResolvedRemote(opts));
  },

  getIssueContext: async (
    provider: IssueProviderType,
    opts: IssueContextOpts
  ): Promise<IssueContextResult> => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return err({ type: 'generic', message: `Unknown provider: ${provider}` });
    }

    if (!issueProvider.getIssueContext) {
      return err({ type: 'generic', message: `${provider} does not support issue context.` });
    }

    return issueProvider.getIssueContext(await withResolvedRemote(opts));
  },

  // ── Inbound issues sync (ticket #8) ──────────────────────────────────────

  getLinkSuggestions: async (projectId: string): Promise<LinkSuggestion[]> => {
    return getLinkSuggestionsForProject(projectId);
  },

  acceptLinkSuggestion: async (
    projectId: string,
    taskId: string,
    suggestion: LinkSuggestion
  ): Promise<void> => {
    return acceptLinkSuggestion(projectId, taskId, suggestion);
  },

  /** Adopts a suggestion into a task of its own, for an issue no existing task covers. */
  adoptLinkSuggestion: async (
    projectId: string,
    suggestion: LinkSuggestion
  ): Promise<Result<CreateTaskSuccess, CreateTaskError>> => {
    return adoptLinkSuggestion(projectId, suggestion);
  },

  dismissLinkSuggestion: async (projectId: string, suggestion: LinkSuggestion): Promise<void> => {
    return dismissLinkSuggestion(projectId, suggestion);
  },

  /** Triggers an inbound issues sync pass on demand — used when the renderer opens the Feature Board. */
  syncIssuesNow: async (projectId: string): Promise<void> => {
    return issuesSyncScheduler.syncNow(projectId);
  },

  // ── Ghost Cards (ticket #9) ───────────────────────────────────────────────

  getGhostCards: async (projectId: string): Promise<GhostCard[]> => {
    return getGhostCardsForProject(projectId);
  },

  adoptGhostCard: async (
    projectId: string,
    ghostCard: GhostCard
  ): Promise<Result<CreateTaskSuccess, CreateTaskError>> => {
    return adoptGhostCard(projectId, ghostCard);
  },

  rejectGhostCard: async (projectId: string, ghostCard: GhostCard): Promise<void> => {
    return rejectGhostCard(projectId, ghostCard);
  },
});
