import type { ConversationConfig, TriggerConfig, StoredAutomationTaskConfig } from './config';

/**
 * Machine-local origin of an automation row: 'local' when created on this
 * machine, 'imported' when it arrived via multi-machine sync (fresh imports
 * default to disabled). Like `enabled`, never transported in the sync payload.
 */
export type AutomationSource = 'local' | 'imported';

export type Automation = {
  id: string;
  projectId?: string;
  name: string;
  triggerConfig?: TriggerConfig;
  conversationConfig?: ConversationConfig;
  taskConfig?: StoredAutomationTaskConfig;
  enabled: boolean;
  source: AutomationSource;
  createdAt: number;
  updatedAt: number;
};

export type CreateAutomationParams = {
  name: string;
  triggerConfig: TriggerConfig;
  conversationConfig: ConversationConfig;
  taskConfig?: StoredAutomationTaskConfig;
  projectId: string;
  enabled?: boolean;
};

export type UpdateAutomationSettingsPatch = {
  projectId?: string;
  triggerConfig?: TriggerConfig;
  conversationConfig?: ConversationConfig;
  taskConfig?: StoredAutomationTaskConfig | null;
};
