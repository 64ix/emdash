import React from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Switch } from '@renderer/lib/ui/switch';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

const InterfaceSettingsCard: React.FC = () => {
  const {
    value: interfaceSettings,
    update,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('interface');

  const hideContextBar = interfaceSettings?.hideContextBar ?? false;
  const showClaudeUsageGauge = interfaceSettings?.showClaudeUsageGauge ?? true;
  const showCodexUsageGauge = interfaceSettings?.showCodexUsageGauge ?? true;

  return (
    <div className="flex flex-col gap-4">
      <SettingRow
        title="Claude usage gauge"
        description="Show local Claude account rate-limit usage in the left sidebar."
        control={
          <Switch
            checked={showClaudeUsageGauge}
            disabled={loading || saving}
            onCheckedChange={(checked) => update({ showClaudeUsageGauge: checked })}
          />
        }
      />
      <SettingRow
        title="Codex usage gauge"
        description="Show rate-limit usage from local Codex session files in the left sidebar."
        control={
          <Switch
            checked={showCodexUsageGauge}
            disabled={loading || saving}
            onCheckedChange={(checked) => update({ showCodexUsageGauge: checked })}
          />
        }
      />
      <SettingRow
        title="Context bar"
        description="Hide the on-screen context trigger. The keyboard shortcut still works."
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('hideContextBar')}
              defaultLabel="shown"
              onReset={() => resetField('hideContextBar')}
              disabled={loading || saving}
            />
            <Switch
              checked={hideContextBar}
              disabled={loading || saving}
              onCheckedChange={(checked) => update({ hideContextBar: checked })}
            />
          </>
        }
      />
    </div>
  );
};

export default InterfaceSettingsCard;
