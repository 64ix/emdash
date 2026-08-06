# Sidebar Stage Groups are projections of the board's stage and rank fields

The sidebar's Stage Groups are not a second task-ordering model: they group
and order tasks by the very fields the Feature Board uses (`workflowStage`
plus `boardRank`), they hide exactly what Shipped Fade hides, and a drop in
the sidebar writes the same two fields through the same RPC
(`updateTaskBoardPosition`) with the same authority gating. We deliberately
rejected a sidebar-local ordering (an extension of `taskOrderByProject`), a
task-level "hidden" field, and auto-archiving faded tasks: the sidebar is a
projection, Hidden Tasks are sidebar view state (the task never changes),
fade remains a display rule, and archive stays the only real task-state
exit. Consequence: a stage, rank, or visibility rule changed on the board
is by definition changed in the sidebar — there is no separate sidebar
semantics to keep in sync.

## Considered Options

- **Sidebar-local ordering (`taskOrderByProject`-style)** — rejected: two
  orderings for one reality; a rank drop in the sidebar would contradict
  the board's view.
- **Task-level `hidden` field** — rejected: hiding has no effect outside
  the sidebar, so view state (the sidebar snapshot) is its honest home.
- **Auto-archive at fade** — rejected: a silent task-state change; archive
  stays a deliberate act, and faded tasks remain reachable in the project
  view's task list.
