# Board stages are derived from observable facts — agents get no transition tool

The Feature Board's workflow stages are computed from observable facts, never
declared: GitHub facts for what it can prove (open Map issue → `exploring`,
open Spec issue → `spec`, open PR referencing the Spec → `review`, merged PR
→ `shipped`, contradicted/vanished facts → `triage`) and emdash-internal facts
for the rest (provisioned worktree / active implementation session →
`implementing`). We deliberately rejected exposing an MCP transition tool to
agent sessions (the "Nimbalist" model): every stage here is backed by a fact
that exists in the world, so a declaration channel would only add a second,
divergeable source of truth, a server surface to maintain, and a per-provider
MCP dependency. The one gap — associating a freshly published Spec/Map issue
with its task — is closed on GitHub itself: agents write an
`Emdash-Task: <task-id>` marker line (task id injected as an env var) into the
issue body, which the inbound sync reads; orphan Spec/Map issues surface as
link suggestions in the UI. This also means the whole board state is
re-derivable from GitHub plus local runtime state after data loss, and works
with any agent that can run `gh`, MCP-capable or not.

## Considered Options

- **MCP transition/link tool per session** — rejected: same session→task
  binding problem as the marker, strictly more surface, provider-dependent.
- **Pure doc convention (`gh` label updates)** — rejected alone: cannot
  represent stages GitHub has no fact for.
- **Inference from agent-hook events only** — kept as a default-setter
  (`task:provisioned` → `implementing`), not as the general mechanism.
