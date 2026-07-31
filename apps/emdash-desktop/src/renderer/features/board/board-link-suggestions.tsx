import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getTaskManagerStore } from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData } from '@renderer/features/tasks/stores/task-store';
import { events, rpc } from '@renderer/lib/ipc';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { linkSuggestionsUpdatedChannel } from '@shared/core/issues/issueEvents';
import type { LinkSuggestion } from '@shared/core/issues/link-suggestion';
import { linkedIssueRoleLabels } from '@shared/core/linked-issue';
import type { Task } from '@shared/core/tasks/tasks';

/**
 * "Attach to a task?" surface for orphan Spec/Map-shaped GitHub issues (no
 * Task Marker, no task linking them yet — see ticket #8 and CONTEXT.md
 * "Task Marker"). Modest by design: a compact list above the board columns,
 * refreshed on every inbound issues sync pass.
 */
export const BoardLinkSuggestions = observer(function BoardLinkSuggestions({
  projectId,
}: {
  projectId: string;
}) {
  const [suggestions, setSuggestions] = useState<LinkSuggestion[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<Record<string, string>>({});
  const manager = getTaskManagerStore(projectId);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void rpc.issues.getLinkSuggestions(projectId).then((result) => {
        if (!cancelled) setSuggestions(result);
      });
    };
    refresh();

    const unsubscribe = events.on(linkSuggestionsUpdatedChannel, (payload) => {
      if (payload.projectId === projectId) refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);

  if (suggestions.length === 0) return null;

  const taskOptions: Task[] = manager
    ? [...manager.tasks.values()]
        .map((store) => registeredTaskData(store))
        .filter((task): task is Task => !!task && !task.archivedAt && task.type === 'task')
    : [];

  const handleAccept = async (suggestion: LinkSuggestion) => {
    const taskId = selectedTaskId[suggestion.id];
    if (!taskId) return;
    await rpc.issues.acceptLinkSuggestion(projectId, taskId, suggestion);
    setSuggestions((current) => current.filter((s) => s.id !== suggestion.id));
  };

  const handleDismiss = async (suggestion: LinkSuggestion) => {
    await rpc.issues.dismissLinkSuggestion(projectId, suggestion);
    setSuggestions((current) => current.filter((s) => s.id !== suggestion.id));
  };

  return (
    <div className="border-b border-border px-4 py-2">
      <div className="mb-1.5 text-xs font-medium text-foreground-muted">Link suggestions</div>
      <div className="flex flex-col gap-1.5">
        {suggestions.map((suggestion) => (
          <div key={suggestion.id} className="flex items-center gap-2 text-xs">
            <Badge variant="outline">{linkedIssueRoleLabels[suggestion.role]}</Badge>
            <span className="flex-1 truncate" title={suggestion.issue.title}>
              {suggestion.issue.title}
            </span>
            <select
              className="h-6 rounded border border-border bg-background px-1 text-xs text-foreground"
              value={selectedTaskId[suggestion.id] ?? ''}
              onChange={(e) =>
                setSelectedTaskId((current) => ({ ...current, [suggestion.id]: e.target.value }))
              }
              aria-label={`Attach "${suggestion.issue.title}" to a task`}
            >
              <option value="">Attach to task…</option>
              {taskOptions.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.name}
                </option>
              ))}
            </select>
            <Button
              size="xs"
              variant="outline"
              disabled={!selectedTaskId[suggestion.id]}
              onClick={() => void handleAccept(suggestion)}
            >
              Attach
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void handleDismiss(suggestion)}>
              Dismiss
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
});
