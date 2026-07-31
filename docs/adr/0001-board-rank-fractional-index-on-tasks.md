# Manual board order lives on tasks as a fractional-index rank

The Feature Board needs a persisted manual order for cards within a column
(drag-and-drop reordering). We store it as a nullable text column
`board_rank` on `tasks` using fractional indexing, rather than an ordered
JSON list in view-state. One drop is one single-row UPDATE with no rewrite
of neighbouring rows, there is no reconciliation when tasks are created or
archived outside the board, and the change follows the existing
schema → operation → RPC → optimistic-store pipeline that
`workflow_stage` established. The cost is a Drizzle migration; view-state
was rejected because a display-state list drifts from the task table and
the order is semantically a property of the task.
