import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

// ---------------------------------------------------------------------------
// Linked issue schema — a single linked issue's metadata, captured at link time
// ---------------------------------------------------------------------------

/**
 * The Zod schema for a single linked issue's metadata. Used both as the flat
 * legacy shape once stored directly in `tasks.linked_issue` and as the payload
 * for each {@link LinkedIssueRole} in {@link LinkedIssueRoles}.
 */
export const linkedIssueSchema = z.object({
  provider: z.enum([
    'github',
    'linear',
    'jira',
    'gitlab',
    'plane',
    'plain',
    'forgejo',
    'featurebase',
    'asana',
    'monday',
    'notion',
    'trello',
  ]),
  url: z.string(),
  title: z.string(),
  identifier: z.string(),
  displayIdentifier: z.string().nullable().optional(),
  description: z.string().optional(),
  context: z.string().optional(),
  branchName: z.string().optional(),
  status: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  project: z.string().optional(),
  updatedAt: z.string().optional(),
  fetchedAt: z.string().optional(),
});

/** The TypeScript type for a single linked issue's metadata. */
export type LinkedIssue = z.infer<typeof linkedIssueSchema>;

// ---------------------------------------------------------------------------
// Linked issue roles — the typed slot a linked issue occupies on a task
// ---------------------------------------------------------------------------

/**
 * The typed slot a GitHub issue occupies on a task. A task holds at most one
 * issue per role: Origin (where the idea came from), Map (wayfinder
 * exploration issue), Spec (the anchor everything downstream derives from).
 */
export const linkedIssueRoleSchema = z.enum(['origin', 'map', 'spec']);

/** The TypeScript type for a linked issue role. */
export type LinkedIssueRole = z.infer<typeof linkedIssueRoleSchema>;

/** Human-readable labels for each role, matching the domain vocabulary in CONTEXT.md. */
export const linkedIssueRoleLabels: Record<LinkedIssueRole, string> = {
  origin: 'Origin',
  map: 'Map',
  spec: 'Spec',
};

/** Most-advanced-first: Spec, else Map, else Origin. Used to pick the single link shown as a badge. */
export const linkedIssueRolesByPriority: readonly LinkedIssueRole[] = ['spec', 'map', 'origin'];

const v1Schema = z.object({
  version: z.literal('1'),
  origin: linkedIssueSchema.optional(),
  map: linkedIssueSchema.optional(),
  spec: linkedIssueSchema.optional(),
});

/**
 * Versioned schema for the role-keyed linked issues stored in `tasks.linked_issue`.
 *
 * v0 (unversioned): a single flat linked issue (pre-dates typed roles).
 * v1: role-keyed container — at most one issue per {@link LinkedIssueRole}. The
 * legacy single link migrates to the Origin role.
 */
export const linkedIssueRoles = defineVersionedSchema()
  .unversioned(linkedIssueSchema)
  .version('1', v1Schema, (prev) => ({ version: '1' as const, origin: prev }))
  .build();

/** The Zod schema for the latest (role-keyed) linked issue links shape. */
export const linkedIssueRolesSchema = linkedIssueRoles.schema;

/** The TypeScript type for a task's role-keyed linked issues. */
export type LinkedIssueRoles = typeof linkedIssueRoles.Type;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a role container with only the Origin role set — used when a task is created from an issue. */
export function linkedIssueRolesFromOrigin(
  issue: LinkedIssue | null | undefined
): LinkedIssueRoles | null {
  return issue ? { version: '1', origin: issue } : null;
}

/**
 * Returns the next role container after setting (or clearing, with `issue: null`)
 * a single role. Returns `undefined` when the result would have no roles set at
 * all — callers should treat that as "no linked issues" (write `null` to storage).
 */
export function setLinkedIssueRole(
  roles: LinkedIssueRoles | null | undefined,
  role: LinkedIssueRole,
  issue: LinkedIssue | null
): LinkedIssueRoles | undefined {
  const next: LinkedIssueRoles = {
    ...roles,
    version: '1',
    [role]: issue ?? undefined,
  };
  const hasAnyLink = linkedIssueRoleSchema.options.some((r) => Boolean(next[r]));
  return hasAnyLink ? next : undefined;
}

/** The single most-advanced link across a task's roles: Spec, else Map, else Origin. */
export function mostAdvancedLinkedIssue(
  roles: LinkedIssueRoles | null | undefined
): { role: LinkedIssueRole; issue: LinkedIssue } | null {
  if (!roles) return null;
  for (const role of linkedIssueRolesByPriority) {
    const issue = roles[role];
    if (issue) return { role, issue };
  }
  return null;
}

export function linkedIssueDisplayIdentifier(
  issue: Pick<LinkedIssue, 'identifier' | 'displayIdentifier'>
): string | null {
  return issue.displayIdentifier === null ? null : (issue.displayIdentifier ?? issue.identifier);
}

export function linkedIssueMentionName(
  issue: Pick<LinkedIssue, 'identifier' | 'displayIdentifier' | 'title'>
): string {
  return linkedIssueDisplayIdentifier(issue) ?? (issue.title || 'Linked issue');
}
