import React, { useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Input } from '@renderer/lib/ui/input';
import type { RemoteProjectSettings } from '@shared/core/app-settings';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

const MS_PER_SECOND = 1000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 600_000;

const INTERVAL_FIELDS: {
  field: keyof RemoteProjectSettings;
  label: string;
  description: string;
  defaultSeconds: number;
}[] = [
  {
    field: 'gitStatusPollIntervalMs',
    label: 'Git status poll interval',
    description: 'How often remote git status is refreshed.',
    defaultSeconds: 10,
  },
  {
    field: 'untrackedStatusPollIntervalMs',
    label: 'Untracked status poll interval',
    description: 'How often remote untracked files are scanned.',
    defaultSeconds: 30,
  },
  {
    field: 'headPollIntervalMs',
    label: 'Head poll interval',
    description: 'How often the remote current branch is refreshed.',
    defaultSeconds: 10,
  },
  {
    field: 'refsPollIntervalMs',
    label: 'Refs poll interval',
    description: 'How often remote branches and refs are refreshed.',
    defaultSeconds: 15,
  },
  {
    field: 'remotesPollIntervalMs',
    label: 'Remotes poll interval',
    description: 'How often remote remotes are refreshed.',
    defaultSeconds: 60,
  },
];

const RemoteProjectSettingsCard: React.FC = () => {
  const {
    value: remoteProject,
    update,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('remoteProject');

  const busy = loading || saving;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-normal text-foreground">Remote project polling</h3>
        <p className="text-xs text-foreground-passive">
          How often SSH projects are polled for git changes. Higher intervals reduce load on the
          remote host and apply to newly opened SSH connections.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {INTERVAL_FIELDS.map(({ field, label, description, defaultSeconds }) => (
          <IntervalRow
            key={field}
            label={label}
            description={description}
            defaultValueSeconds={defaultSeconds}
            valueMs={remoteProject?.[field]}
            isOverridden={isFieldOverridden(field)}
            disabled={busy}
            onCommit={(seconds) => update({ [field]: seconds * MS_PER_SECOND })}
            onReset={() => resetField(field)}
          />
        ))}
      </div>
    </div>
  );
};

function IntervalRow({
  label,
  description,
  defaultValueSeconds,
  valueMs,
  isOverridden,
  disabled,
  onCommit,
  onReset,
}: {
  label: string;
  description: string;
  defaultValueSeconds: number;
  valueMs: number | undefined;
  isOverridden: boolean;
  disabled: boolean;
  onCommit: (seconds: number) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const seconds = valueMs === undefined ? defaultValueSeconds : Math.round(valueMs / MS_PER_SECOND);

  const commit = () => {
    const raw = draft ?? String(seconds);
    const next = Math.round(Number(raw));
    if (!Number.isFinite(next)) {
      setDraft(null);
      return;
    }
    const clamped = Math.min(
      MAX_INTERVAL_MS / MS_PER_SECOND,
      Math.max(MIN_INTERVAL_MS / MS_PER_SECOND, next)
    );
    setDraft(null);
    if (clamped !== seconds) onCommit(clamped);
  };

  return (
    <SettingRow
      title={label}
      description={description}
      control={
        <>
          <ResetToDefaultButton
            visible={isOverridden}
            defaultLabel={`${defaultValueSeconds}s`}
            onReset={onReset}
            disabled={disabled}
          />
          <Input
            type="number"
            aria-label={label}
            disabled={disabled}
            min={MIN_INTERVAL_MS / MS_PER_SECOND}
            max={MAX_INTERVAL_MS / MS_PER_SECOND}
            step={1}
            className="w-24 text-right"
            value={draft ?? seconds}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
            }}
          />
          <span className="text-xs text-foreground-passive">s</span>
        </>
      }
    />
  );
}

export default RemoteProjectSettingsCard;
