# Glossary

## Feature Board

The kanban view (fork-only) that shows a project's tasks as cards grouped in
columns by **Workflow Stage**. Reached from the project titlebar dropdown.
Not part of the settings/options UI.

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
fixed window ago are hidden from the Feature Board. The task keeps its
stage forever.

## Awaiting Input

The state of a task on the Feature Board when at least one of its sessions
has an unseen `awaiting-input` conversation — an agent is waiting on the
user. A display state, not a position: awaiting-input cards float to the
top of their column at render time and fall back to their manual place
once handled.

## Board Rank

A task's manually chosen position within a Feature Board column. Only ever
set by an explicit user gesture (a drop); never written by the system.
Tasks without a Board Rank sort after ranked ones, in their existing order.

## Linked Issue Role

The typed slot a GitHub issue occupies on a task. A task holds at most one
issue per role: **Origin**, **Map**, **Spec**. A task may have no links at
all — it is then purely local and GitHub has no authority over it.

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
column of the Feature Board; not itself a Workflow Stage.
