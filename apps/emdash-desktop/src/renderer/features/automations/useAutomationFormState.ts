import type { AgentProviderId } from '@emdash/plugins/agents';
import { useMemo, useState } from 'react';
import { DEFAULT_CRON_STATE, toCron } from '@renderer/lib/CronPicker/cron-utils';
import { useAgents } from '@renderer/lib/stores/use-agents';
import type { Automation } from '@shared/core/automations/automation';
import type { StoredAutomationTaskConfig, TriggerConfig } from '@shared/core/automations/config';
import { getLocalTimeZone } from '@shared/core/automations/timezone';
import {
  asMounted,
  firstMountedProjectId,
  getProjectStore,
} from '../projects/stores/project-selectors';
import { useProjectGitContext } from '../tasks/create-task-modal/use-project-git-context';
import { useTaskName } from '../tasks/create-task-modal/use-task-name';
import {
  useWorkspaceConfig,
  type WorkspaceConfigInitial,
} from '../tasks/create-task-modal/use-workspace-config';
import { useInitialConversationState } from '../tasks/task-config/initial-conversation-section';
import type { BuiltinAutomationTemplate } from './automation-template';

const DEFAULT_CRON = toCron(DEFAULT_CRON_STATE);

/**
 * Derives the initial workspace config state for seeding the form from a stored automation.
 */
function workspaceInitialFromConfig(
  config: StoredAutomationTaskConfig | null | undefined
): WorkspaceConfigInitial {
  if (!config) return { mode: 'new-worktree', presetId: 'new-worktree' };
  const { git, workspace } = config.workspaceConfig;

  if (workspace.kind === 'byoi' || (workspace as { host?: string }).host === 'byoi') {
    return { mode: 'sandbox', presetId: 'sandbox' };
  }

  if (git.kind === 'create-branch') {
    return {
      mode: 'new-worktree',
      presetId: 'new-worktree',
      branchSelection: {
        createBranchAndWorktree: true,
        branchOverride: git.fromBranch,
        pushBranch: git.pushBranch,
      },
    };
  }

  if (git.kind === 'use-branch') {
    return {
      mode: 'new-worktree',
      presetId: 'new-worktree',
      branchSelection: {
        createBranchAndWorktree: false,
        branchOverride: { type: 'local', branch: git.branchName },
      },
    };
  }

  if (git.kind === 'none') {
    if (workspace.kind === 'repository-instance') {
      // v3 stored targets carry no machine-local workspace id; the id is
      // resolved at run time against the project's repository workspace.
      if (!workspace.workspaceId) return { mode: 'existing', presetId: 'repo-root' };
      return {
        mode: 'existing',
        presetId: 'use-existing',
        selectedWorkspaceId: workspace.workspaceId,
      };
    }
    // repo-root or unknown
    return { mode: 'existing', presetId: 'repo-root' };
  }

  return { mode: 'new-worktree', presetId: 'new-worktree' };
}

export type AutomationFormState = ReturnType<typeof useAutomationFormState>;

export function useAutomationFormState(
  seed?: Automation,
  initialTemplate?: BuiltinAutomationTemplate
) {
  const seedTrigger = seed?.triggerConfig;
  const seedConversationConfig = seed?.conversationConfig;
  const seedConfig = seed?.taskConfig;
  const seedPrompt =
    seedConversationConfig?.prompt ?? initialTemplate?.defaultConversationConfig.initialPrompt;
  const { data: agents } = useAgents();

  const [name, setName] = useState(seed?.name ?? initialTemplate?.name ?? '');
  const [projectId, setProjectId] = useState<string | undefined>(
    seed?.projectId ?? firstMountedProjectId()
  );
  const [cronExpr, setCronExpr] = useState<string>(
    seedTrigger?.expr ?? initialTemplate?.defaultTrigger.expr ?? DEFAULT_CRON
  );
  const [cronTz] = useState<string>(seedTrigger?.tz ?? getLocalTimeZone());

  const effectiveProjectId =
    projectId && asMounted(getProjectStore(projectId)) ? projectId : firstMountedProjectId();

  const seedProvider = agents?.some((agent) => agent.id === seedConversationConfig?.provider)
    ? (seedConversationConfig?.provider as AgentProviderId)
    : undefined;

  const seedModel = seedConversationConfig?.model ?? undefined;

  const initialConversation = useInitialConversationState(effectiveProjectId, seedProvider, false, {
    resetPromptOnProjectChange: false,
  });

  const [promptSeeded, setPromptSeeded] = useState(false);
  if (!promptSeeded && seedPrompt) {
    setPromptSeeded(true);
    initialConversation.setPrompt(seedPrompt);
  }

  const [modelSeeded, setModelSeeded] = useState(false);
  if (!modelSeeded && seedModel) {
    setModelSeeded(true);
    initialConversation.setModel(seedModel);
  }

  const seedType = seedConversationConfig?.type;
  const [chatUiSeeded, setChatUiSeeded] = useState(false);
  if (!chatUiSeeded && seedType === 'acp') {
    setChatUiSeeded(true);
    initialConversation.setUseChatUi(true);
  }

  const { defaultBranch, isUnborn, currentBranch, repositoryWorkspaceId } =
    useProjectGitContext(effectiveProjectId);

  // Derive initial workspace config state from stored automation (for edit mode).
  const wsInitial = useMemo(() => workspaceInitialFromConfig(seedConfig), [seedConfig]);

  const taskName = useTaskName({
    generatedName: seedConfig?.taskConfig.name,
    resetKey: effectiveProjectId,
  });

  const workspaceConfig = useWorkspaceConfig({
    projectId: effectiveProjectId,
    defaultBranch,
    isUnborn,
    currentBranch,
    repositoryWorkspaceId,
    pr: null, // automations don't link PRs
    taskName: taskName.effectiveTaskName || name,
    linkedIssue: null,
    createBranchAndWorktreeDefault: wsInitial.mode === 'new-worktree',
    resetKey: effectiveProjectId,
    initial: wsInitial,
  });

  const prompt = initialConversation.prompt;
  const provider = initialConversation.provider;
  const model = initialConversation.model;

  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !!provider &&
    !!effectiveProjectId &&
    workspaceConfig.isValid;

  function buildTaskConfig(): StoredAutomationTaskConfig | null {
    // v3: repository-instance targets are stored WITHOUT the machine-local
    // workspace id. A config synced to another machine must not carry this
    // machine's workspace reference; the run resolves it against the mounted
    // project's own repository workspace at execution time.
    const wsConfig = workspaceConfig.resolvedConfig;

    const patchedConfig =
      wsConfig.workspace.kind === 'repository-instance'
        ? { ...wsConfig, workspace: { kind: 'repository-instance' as const } }
        : wsConfig;

    const result: StoredAutomationTaskConfig = {
      version: '1',
      taskConfig: {
        version: '1',
        name: taskName.effectiveTaskName?.trim() || name.trim(),
        linkedIssue: seedConfig?.taskConfig.linkedIssue,
        initialStatus: seedConfig?.taskConfig.initialStatus,
      },
      workspaceConfig: patchedConfig,
    };

    // Strip MobX Proxy wrappers (e.g. fromBranch coming from getGitRepositoryStore)
    // before the value crosses the Electron contextBridge. The structured clone
    // algorithm rejects Proxy objects with a DataCloneError.
    return JSON.parse(JSON.stringify(result)) as StoredAutomationTaskConfig;
  }

  const triggerConfig: TriggerConfig = { expr: cronExpr.trim(), tz: cronTz };

  function applyTemplate(template: BuiltinAutomationTemplate) {
    setName(template.name);
    setCronExpr(template.defaultTrigger.expr);
    initialConversation.setPrompt(template.defaultConversationConfig.initialPrompt);
  }

  return {
    name,
    setName,
    projectId,
    setProjectId,
    effectiveProjectId,
    cronExpr,
    setCronExpr,
    cronTz,
    initialConversation,
    workspaceConfig,
    isUnborn,
    currentBranch,
    prompt,
    provider,
    model,
    canSave,
    triggerConfig,
    applyTemplate,
    buildTaskConfig,
  };
}
