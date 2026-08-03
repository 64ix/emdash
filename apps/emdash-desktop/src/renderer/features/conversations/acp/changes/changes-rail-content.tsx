import { XIcon } from 'lucide-react';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type { ChangesRailFilter } from '@shared/view-state';
import type {
  ChangesFootprint,
  ChangesFootprintEntry,
  EditedChangesFootprintEntry,
} from './acp-changes-footprint';
import { ChangesRailList } from './changes-rail-list';

const FILTERS: Array<{ value: ChangesRailFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'edited', label: 'Edited' },
  { value: 'read', label: 'Read' },
];

export interface ChangesRailContentProps {
  footprint: ChangesFootprint;
  filter: ChangesRailFilter;
  onFilterChange: (filter: ChangesRailFilter) => void;
  selectedPath: string | null;
  onSelectEntry: (entry: ChangesFootprintEntry) => void;
  onOpenFile: (entry: ChangesFootprintEntry) => void;
  onOpenDiff: (entry: EditedChangesFootprintEntry) => void;
  onClose?: () => void;
}

/**
 * Shared Changes rail content — the header, filter tabs, and Edited/Read
 * list — rendered identically by the wide inline rail and the narrow drawer.
 */
export function ChangesRailContent({
  footprint,
  filter,
  onFilterChange,
  selectedPath,
  onSelectEntry,
  onOpenFile,
  onOpenDiff,
  onClose,
}: ChangesRailContentProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <span className="text-sm font-medium text-foreground">Changes</span>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close Changes"
            onClick={onClose}
            className="text-foreground-muted hover:text-foreground"
          >
            <XIcon className="size-4" />
          </Button>
        )}
      </div>
      <div
        role="tablist"
        aria-label="Filter changes"
        className="flex items-center gap-1 px-2 py-1.5"
      >
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={filter === option.value}
            onClick={() => onFilterChange(option.value)}
            className={cn(
              'rounded-md px-2 py-1 text-xs font-medium text-foreground-muted hover:bg-background-1 hover:text-foreground',
              filter === option.value && 'bg-background-2 text-foreground'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <ChangesRailList
        footprint={footprint}
        filter={filter}
        selectedPath={selectedPath}
        onSelect={onSelectEntry}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    </div>
  );
}
