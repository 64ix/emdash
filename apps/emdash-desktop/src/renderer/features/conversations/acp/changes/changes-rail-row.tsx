import { Eye, FileText, GitCompare, History } from 'lucide-react';
import { GitChangeStatusIcon } from '@renderer/features/tasks/diff-view/changes-panel/components/changes-list-item';
import { splitPath } from '@renderer/features/tasks/utils';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type { ChangesFootprintEntry } from './acp-changes-footprint';
import { changesProvenanceLabel, changesProvenanceTooltip } from './changes-provenance';

interface ChangesRailRowProps {
  entry: ChangesFootprintEntry;
  isSelected: boolean;
  /**
   * Primary action: jumps to the entry's transcript provenance when one
   * exists, or falls back to the default open action otherwise — the caller
   * decides which (see `changesProvenanceJumpTarget`), this component never
   * does its own navigation.
   */
  onSelect: () => void;
  /** Explicit "Open file" action — always available, independent of `onSelect`. */
  onOpenFile: () => void;
  /** Explicit "Open diff" action — only meaningful for an edited entry. */
  onOpenDiff?: () => void;
}

/**
 * One Changes rail entry — a semantic, focusable button, never a clickable
 * `div`. Ticket #35 layers three explicit actions onto it without merging
 * them: the row body jumps to transcript provenance (or falls back to
 * opening the file/diff when there is none), while "Open file"/"Open diff"
 * stay reachable as separate hover/focus-revealed buttons regardless of
 * which action the row body performs — see `changes-rail-actions.ts`.
 */
export function ChangesRailRow({
  entry,
  isSelected,
  onSelect,
  onOpenFile,
  onOpenDiff,
}: ChangesRailRowProps) {
  const { filename, directory } = splitPath(entry.path);
  const provenanceLabel = changesProvenanceLabel(entry);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isSelected ? 'true' : undefined}
      title={changesProvenanceTooltip(entry)}
      className={cn(
        'group/item flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left hover:bg-background-1',
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
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/item:opacity-100 group-hover/item:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Open ${filename} in the editor`}
          title="Open file"
          onClick={(event) => {
            event.stopPropagation();
            onOpenFile();
          }}
          className="text-foreground-muted hover:text-foreground"
        >
          <FileText className="size-3" />
        </Button>
        {entry.kind === 'edited' && onOpenDiff && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Open diff for ${filename}`}
            title="Open diff"
            onClick={(event) => {
              event.stopPropagation();
              onOpenDiff();
            }}
            className="text-foreground-muted hover:text-foreground"
          >
            <GitCompare className="size-3" />
          </Button>
        )}
      </span>
      {provenanceLabel && (
        <History className="size-3 shrink-0 text-foreground-muted" aria-hidden="true" />
      )}
      {entry.kind === 'edited' ? (
        <GitChangeStatusIcon status={entry.status} className="size-3.5 shrink-0" />
      ) : (
        <Eye className="size-3.5 shrink-0 text-foreground-muted" aria-hidden="true" />
      )}
    </button>
  );
}
