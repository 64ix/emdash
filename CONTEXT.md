# Glossary

## Feature Board

The kanban view (fork-only) that shows a project's tasks as cards grouped in
columns by **Workflow Stage**. Project-scoped: every entry point resolves an
explicit project, never an implicit or last-used one. Reached from the
project's Board row in the left sidebar (shown before its task rows while
the project is expanded), the command palette's Open Feature Board command,
or a task's Workflow Stage chip in its titlebar. Not part of the
settings/options UI.

Navigation into the Feature Board may carry an optional focused task. The
board resolves it against the project's own displayable tasks (the same set
its columns already show), scrolls that card into view, highlights it, and
opens the Task Detail Panel for it. An id that doesn't resolve there
(invalid, archived, or simply absent) is a no-op — the board still renders
normally.

## Workflow Stage

The position of a task in the feature delivery pipeline:
`idea → exploring → spec → implementing → review → shipped`, plus the
out-of-flow **Triage** stage. `exploring` is optional — a task may go
straight from `idea` to `spec`. Nullable — a task with no stage is
**Unstaged** and appears in the leading Unstaged column of the Feature
Board.

Stage authority is hybrid: GitHub is authoritative for every stage it can
prove (`exploring` = open Map, `spec` = open Spec issue, `review` = open
PR referencing the Spec, `shipped` = that PR merged); the agent or user
declares the rest (`idea`, `implementing`). A GitHub fact always wins over
a manual placement.

## Triage

The out-of-flow stage where a card lands when its GitHub facts contradict
or disappear (PR closed without merge, Spec closed mid-flight). GitHub
pushes cards in; only the user or an agent moves a card back out.

## Shipped Fade

A display rule, not a stage: `shipped` cards whose PR merged more than a
fixed window ago are hidden from the Feature Board and from the sidebar's
Shipped Stage Group. The task keeps its stage forever and is never
archived or otherwise altered. The Shipped column (and group) disclose the
window so older cards never appear to vanish arbitrarily. A faded task
remains reachable in the project view's task list, where it can be
archived or restored.

## Awaiting Input

The state of a task on the Feature Board when at least one of its sessions
has an unseen `awaiting-input` conversation — an agent is waiting on the
user. A display state, not a position: awaiting-input cards float to the
top of their Feature Board column (and of their sidebar Stage Group) at
render time and fall back to their manual place once handled.

## Board Rank

A task's manually chosen position within a Feature Board column or sidebar
Stage Group. Only ever set by an explicit user gesture (a drop, in the
board or the sidebar); never written by the system. Tasks without a Board
Rank sort after ranked ones, in their existing order.

## Ghost Card

A lightweight candidate card on the Feature Board for a root GitHub issue
(not a Spec, not a sub-issue, not `wayfinder:*`) that no task references
yet. Not a task: adopting it creates a real task with the issue as its
Origin; rejecting it hides it. Nothing is persisted without adoption.
Sourced from the [Issue Tracker Repository](#issue-tracker-repository) only.

## Link Suggestion

An orphan Spec- or Map-shaped GitHub issue — no [Task Marker](#task-marker),
no task linking it — surfaced in the board's Inbox (a compact, count-bearing
summary above the Feature Board that expands on demand) with three answers:
**attach** it to an existing task, **adopt** it into a task of its own (the
issue came from elsewhere and no task covers it), or **dismiss** it. Adoption
sets the issue in its suggested [Linked Issue Role](#linked-issue-role), never
as Origin, and lands the card in the stage that fact implies. Sourced from the
[Issue Tracker Repository](#issue-tracker-repository) only.

## Issue Tracker Repository

The single GitHub repository a project reads inbound issues from: the one
behind its configured base remote, the same one the issue picker lists from.
Ghost Cards and link suggestions come from there and nowhere else — in a fork
checkout the `upstream` remote's issues belong to somebody else. Pull requests
are the exception: they are synced across every remote, since a fork's PRs can
legitimately live on either.

## Linked Issue Role

The typed slot a GitHub issue occupies on a task. A task holds at most one
issue per role: **Origin**, **Map**, **Spec**. A task may have no links at
all — it is then purely local and GitHub has no authority over it.

## Task Marker

The `Emdash-Task: <task-id>` line an agent writes into the body of an
issue it publishes (Spec, Map) for the task it is working in. The inbound
sync reads the marker and sets the corresponding Linked Issue Role
automatically. Orphan Spec/Map issues without a marker surface as
link suggestions instead.

## Origin Issue

The issue a task's idea came from (a bug report, a request, an idea filed
on GitHub). Optional — absent when the idea originates with the user.

## Map

The `wayfinder:map` issue tracking a feature's exploration, when the
feature goes through Wayfinder. Optional.

## Spec

The `[Spec] <feature>` issue for a task. The anchor link: once a task has
a Spec, everything downstream (tickets, PR, shipped) is derived from
GitHub by walking from the Spec. A PR is never a stored link — it is
always derived from the Spec.

## Unstaged

The state of a task whose Workflow Stage is unset. Displayed as the first
column of the Feature Board, and as ungrouped rows at the top of the
project's sidebar task list (below the Board row, above the Stage Groups);
not itself a Workflow Stage.

## Stage Group

A collapsible sidebar folder containing a project's tasks that share a
Workflow Stage, replacing the project's flat task list. Only non-empty
stages appear, in Feature Board column order, and each group orders its
tasks like its board column (Board Rank first, then unranked, Awaiting
Input elevated at render time). Unstaged tasks are not in a group — they
sit as ungrouped rows above the groups. A group shows only visible tasks:
Shipped Fade hides `shipped` cards past the window, and Hidden Tasks are
absent. A drop inside the sidebar writes the same stage and Board Rank
fields as the board — the sidebar never changes a stage the board would
not honor (ADR 0006).

## Hidden Task

A task the user hid from the sidebar with the context menu's "Hide from
sidebar" action — any task, any stage. Sidebar view state, not task state:
the task is unchanged everywhere else (still a Feature Board card, still in
the project view's task list and search) and is unhidden from the project
view's task list. Distinct from Unstaged (a stage state), from Shipped Fade
(automatic, time-based, applies to the board too), and from archiving (a
task-level state change).

## Task Detail Panel

The side panel that opens on the right of the Feature Board when a card is
clicked, splitting the view: the board stays fully interactive on the left
(including drag-and-drop), the clicked task's details on the right. Fixed
width, not resizable. Clicking a different card switches its content;
re-clicking the shown card does nothing. Escape and a close button dismiss
it, and the card behind it stays highlighted while it is open. Ephemeral
view state — it does not survive leaving the Feature Board, adds no
view-registry entry, and writes nothing to the database; a task that stops
being displayable (archived, faded by Shipped Fade) closes the panel rather
than showing stale or missing data. Clicking a Ghost Card opens the same
panel in ghost mode with the issue's details and an Adopt action.

The panel's Conversations section lists one row per Conversation on the
task — provider icon, display title, live agent status and last-active
time — with rename, delete and (for ACP Conversations) transcript export.
A Conversation Awaiting Input is elevated to the top of the section at
render time only, never persisted (ADR 0002's rule, applied to
Conversations); the rest are ordered by most-recent activity. Clicking a
row provisions the workspace first when the task has never been
provisioned, then opens the task view with that Conversation active.
Navigation out of the panel into the task view may carry an optional
focused conversation, the direct mirror of the board's own optional
focused task above; an id that no longer resolves (the Conversation was
deleted) is a no-op — the task view still opens, with nothing focused.
Not shown in ghost mode — a Ghost Card is not a task and has no
Conversations.

## Context Usage

The per-conversation measure of how full one agent session's context
window is (tokens used vs. context size, optionally cost). Scoped to a
single conversation and shown in its chat composer. Not to be confused
with **Provider Usage** — how much of the account's quota is consumed at
the provider.

## Provider Usage

The account-level utilization of a provider's rolling rate limits (Claude,
Codex, …) for the account logged in on the local machine. Made of one or
more **Usage Windows**. Independent of any task or conversation — it
reflects everything the account consumed, inside or outside emdash.

## Usage Window

One rolling rate-limit window within a provider's Provider Usage: an
identity (e.g. Claude 5-hour session, 7-day weekly, 7-day Opus; Codex
primary/secondary), a utilization percentage, and a reset time. The
5-hour (or primary) window is the **primary window** — the one the Usage
Gauge displays.

## Usage Gauge

The compact per-provider indicator at the bottom of the left sidebar
showing the primary Usage Window's utilization. Clicking it opens a
detail popover with every Usage Window and its reset time. A gauge
appears only when usage data is obtainable for that provider on the local
machine, and each gauge can be hidden in settings.
