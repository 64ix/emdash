import { Eye } from 'lucide-react';
import { GitChangeStatusIcon } from '@renderer/features/tasks/diff-view/changes-panel/components/changes-list-item';
import { splitPath } from '@renderer/features/tasks/utils';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { cn } from '@renderer/utils/utils';
import type { ChangesFootprintEntry } from './acp-changes-footprint';

interface ChangesRailRowProps {
  entry: ChangesFootprintEntry;
  isSelected: boolean;
  onSelect: () => void;
}

/** One Changes rail entry — a semantic, focusable button, never a clickable `div`. */
export function ChangesRailRow({ entry, isSelected, onSelect }: ChangesRailRowProps) {
  const { filename, directory } = splitPath(entry.path);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isSelected ? 'true' : undefined}
      title={entry.path}
      className={cn(
        'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-background-1',
        isSelected && 'bg-background-2 hover:bg-background-2'
      )}
    >
      <FileIcon filename={filename} size={12} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="max-w-full shrink-0 truncate text-sm">{filename}</span>
        {directory && (
          <span className="min-w-0 shrink truncate text-xs text-foreground-muted">{directory}</span>
        )}
      </span>
      {entry.kind === 'edited' ? (
        <GitChangeStatusIcon status={entry.status} className="size-3.5 shrink-0" />
      ) : (
        <Eye className="size-3.5 shrink-0 text-foreground-muted" aria-hidden="true" />
      )}
    </button>
  );
}
