import { Badge } from '@renderer/lib/ui/badge';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import type { ChangesRailFilter } from '@shared/view-state';
import type { ChangesFootprint, ChangesFootprintEntry } from './acp-changes-footprint';
import { ChangesRailRow } from './changes-rail-row';

interface ChangesRailListProps {
  footprint: ChangesFootprint;
  filter: ChangesRailFilter;
  selectedPath: string | null;
  onSelect: (entry: ChangesFootprintEntry) => void;
}

function ChangesRailSection({
  label,
  entries,
  selectedPath,
  onSelect,
}: {
  label: string;
  entries: readonly ChangesFootprintEntry[];
  selectedPath: string | null;
  onSelect: (entry: ChangesFootprintEntry) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-2">
        <span className="text-xs font-medium text-foreground-muted">{label}</span>
        <Badge variant="secondary">{entries.length}</Badge>
      </div>
      <div className="flex flex-col gap-0.5 px-1 pb-2">
        {entries.map((entry) => (
          <ChangesRailRow
            key={entry.path}
            entry={entry}
            isSelected={selectedPath === entry.path}
            onSelect={() => onSelect(entry)}
          />
        ))}
      </div>
    </div>
  );
}

/** The Edited/Read section list shared by both the wide rail and the narrow drawer. */
export function ChangesRailList({
  footprint,
  filter,
  selectedPath,
  onSelect,
}: ChangesRailListProps) {
  const showEdited = filter !== 'read';
  const showRead = filter !== 'edited';
  const editedCount = showEdited ? footprint.edited.length : 0;
  const readCount = showRead ? footprint.read.length : 0;

  if (editedCount === 0 && readCount === 0) {
    return (
      <EmptyState
        label="No changes yet"
        description="Files this conversation edits or reads will show up here."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {showEdited && (
        <ChangesRailSection
          label="Edited"
          entries={footprint.edited}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      )}
      {showRead && (
        <ChangesRailSection
          label="Read"
          entries={footprint.read}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}
