import { useMemo } from 'react';
import { parseCsv } from '@renderer/lib/editor/csv-parser';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';

/**
 * Rendered artifact content for `ArtifactPreviewDialog` — already fetched and
 * policy-checked by the main process (`previewArtifact` RPC / ticket #21).
 * This component only ever displays bytes that already passed the
 * size/type/content policy; it never fetches, executes, or re-validates
 * anything itself.
 *
 * Markdown content is intentionally rendered as plain preformatted text, not
 * through the app's rich `MarkdownRenderer`: that renderer follows remote
 * `http(s)` image sources and (in its default "full" mode) parses embedded
 * raw HTML before sanitizing it. Either is an acceptable trust boundary for
 * markdown a user typed themselves, but not for agent-authored file content
 * previewed from chat — this dialog must never fetch a remote resource or
 * execute markup the previewed file contains.
 */
export type ArtifactPreviewArtifact =
  | { kind: 'image'; dataUrl: string; mimeType: string }
  | { kind: 'text'; content: string; contentType: 'text' | 'markdown' | 'csv' };

export type ArtifactPreviewDialogArgs = {
  /** Display name (resource-link title/name, or the file's basename). */
  name: string;
  /** Resolved absolute path, shown as a muted caption for context. */
  path: string;
  artifact: ArtifactPreviewArtifact;
};

type Props = BaseModalProps<void> & ArtifactPreviewDialogArgs;

function CsvTable({ content }: { content: string }) {
  const parsed = useMemo(() => parseCsv(content), [content]);
  const [header, ...bodyRows] = parsed.rows;
  if (parsed.rows.length === 0) {
    return <p className="text-foreground-muted text-sm">This CSV file is empty.</p>;
  }
  return (
    <div className="max-h-[65vh] overflow-auto rounded-md border border-border">
      <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
        <thead>
          <tr>
            {(header ?? []).map((cell, index) => (
              <th
                key={index}
                className="sticky top-0 border-r border-b border-border bg-background-secondary-2 px-3 py-2 font-medium last:border-r-0"
              >
                <span className="block max-w-80 truncate">{cell || `Column ${index + 1}`}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-background-secondary-1 even:bg-background-secondary-2">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="border-r border-b border-border px-3 py-1.5 last:border-r-0">
                  <span className="block max-w-80 truncate">{cell}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ArtifactPreviewDialog({ name, path, artifact }: Props) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="truncate" title={name}>
          {name}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea>
        {artifact.kind === 'image' ? (
          <img
            src={artifact.dataUrl}
            alt={name}
            className="mx-auto max-h-[65vh] max-w-full rounded object-contain"
          />
        ) : artifact.contentType === 'csv' ? (
          <CsvTable content={artifact.content} />
        ) : (
          <pre className="max-h-[65vh] overflow-auto rounded-md border border-border bg-background-secondary-1 p-3 text-xs whitespace-pre-wrap break-words">
            {artifact.content}
          </pre>
        )}
      </DialogContentArea>
      <DialogFooter className="justify-start! sm:justify-start!">
        <span className="text-foreground-muted truncate text-xs" title={path}>
          {path}
        </span>
      </DialogFooter>
    </>
  );
}
