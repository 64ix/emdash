/**
 * Sync allowlist (spec #130, ticket #133): per-table configuration for the
 * portable row set the engine moves between the local SQLite database and the
 * relay. Everything outside these tables is machine-specific and never synced.
 *
 * Payload columns are the raw SQL column names; the engine reads and writes
 * them with raw SQL only, so versioned-JSON columns (`rawJsonColumns`) travel
 * as exact strings and are applied verbatim — never re-serialized through the
 * ORM's `toDriver` (round-tripping a future-version blob through the latest
 * version's serializer destroys it; callers would read null).
 */

export type SyncMode = 'continuous' | 'initial-only';

export interface SyncTableConfig {
  /** Wire/relay table name. Physical table name, except `kv:prompt-library`. */
  table: string;
  /** Primary key columns in physical order. */
  keyColumns: string[];
  mode: SyncMode;
  /** Columns transported in the body (raw SQL names; `sync_ts` never included). */
  payloadColumns: string[];
  /** Versioned-JSON columns: transported as raw strings, applied verbatim. */
  rawJsonColumns: string[];
  /** kv-style table: body carries a single `value` column (the raw stored string). */
  kvStyle?: boolean;
  /** Whether a row with this pk is portable (kv/app_settings key filtering). */
  isPortablePk?: (pk: string) => boolean;
  /**
   * Sanitize the outgoing columns (strip machine-specific fields from nested
   * JSON blobs) before the body is encoded.
   */
  pushTransform?: (
    pk: string,
    columns: Record<string, string | null>
  ) => Record<string, string | null>;
  /**
   * Rehydrate machine-specific state at import using the pre-import local row
   * (raw SQL values keyed by column name, `null` when the row does not exist).
   */
  importTransform?: (
    pk: string,
    columns: Record<string, string | null>,
    localRow: Record<string, unknown> | null
  ) => Record<string, string | null>;
  /** Columns written on INSERT only (never on conflict-update). */
  importInsertColumns?: Record<string, string | null>;
  /**
   * Machine-local reference columns: never written at import. Fresh imports
   * leave them NULL (the receiving machine regenerates its own), and an
   * existing local row keeps its own value when a remote version wins LWW.
   */
  importPreserveLocalColumns?: string[];
  /** Columns nulled at import when the referenced row is absent locally. */
  importNullIfMissingFk?: Array<{ column: string; table: string; columnRef: string }>;
  /**
   * In-scope FK parents: a child upsert whose parent row is absent locally is
   * skipped (version recorded, cursor advances) instead of aborting the pull
   * batch with a foreign-key violation. This happens when a parent tombstone
   * reached this machine before a child edit that was pushed by a machine
   * that had not yet applied the tombstone — the child cannot exist without
   * the parent, so the edit is dropped and the machines converge on the
   * deletion. Out-of-scope parents (pull_requests, ssh_connections) use
   * `importNullIfMissingFk` instead: the row survives with a nulled column.
   */
  importSkipIfMissingParent?: Array<{ column: string; table: string; columnRef: string }>;
}

/** app_settings keys that stay machine-local (never pushed, never applied). */
export const EXCLUDED_APP_SETTINGS_KEYS = ['localProject', 'providerConfigs'] as const;

/** Machine-specific app_settings fields, keyed by settings key. */
export const APP_SETTINGS_LOCAL_FIELDS: Record<string, string[]> = {
  terminal: ['defaultShell'],
  notifications: ['customSoundPath'],
};

/** Machine-specific base project settings fields. */
export const PROJECT_SETTINGS_LOCAL_FIELDS = ['worktreeDirectory', 'workspaceProvider'];

export const projectsTable: SyncTableConfig = {
  table: 'projects',
  keyColumns: ['id'],
  mode: 'continuous',
  payloadColumns: [
    'id',
    'name',
    'workspace_provider',
    'base_ref',
    'ssh_connection_id',
    'repository_workspace_id',
    'created_at',
    'updated_at',
  ],
  rawJsonColumns: [],
  // `path` is never in the payload (machine-local), so the local path is
  // preserved on update and NULL on fresh import. `repository_workspace_id`
  // and `ssh_connection_id` are machine-local references: carried in the
  // payload for observability but never applied at import — a fresh import
  // gets NULL (the receiving machine regenerates its own workspace/SSH
  // reference), and a local row keeps its own. A dangling `ssh_connection_id`
  // is nulled on fresh import (out-of-scope table), else the FK would abort
  // the apply batch.
  importPreserveLocalColumns: ['repository_workspace_id', 'ssh_connection_id'],
  importNullIfMissingFk: [
    { column: 'ssh_connection_id', table: 'ssh_connections', columnRef: 'id' },
  ],
};

export const projectRemotesTable: SyncTableConfig = {
  table: 'project_remotes',
  keyColumns: ['project_id', 'remote_name'],
  // Carried once with the project's creation/attach payload as the
  // auto-attach hint; afterwards each machine maintains its own remotes from
  // live git (a delete-sweep write war between machines must not happen).
  mode: 'initial-only',
  payloadColumns: ['project_id', 'remote_name', 'remote_url'],
  rawJsonColumns: [],
  // A fresh machine joining after the project was deleted pulls the carried
  // remotes with no parent row — skip them or the FK aborts the batch.
  importSkipIfMissingParent: [{ column: 'project_id', table: 'projects', columnRef: 'id' }],
};

export const projectSettingsTable: SyncTableConfig = {
  table: 'project_settings',
  keyColumns: ['project_id'],
  mode: 'continuous',
  payloadColumns: [
    'project_id',
    'base_project_settings_json',
    'shareable_project_settings_json',
    'legacy_config_migrated_at',
    'created_at',
    'updated_at',
  ],
  rawJsonColumns: [],
  // worktreeDirectory/workspaceProvider are machine-local base settings:
  // stripped before push, re-applied from the local row at import.
  pushTransform: (pk, columns) => ({
    ...columns,
    base_project_settings_json: stripJsonFields(
      columns.base_project_settings_json,
      PROJECT_SETTINGS_LOCAL_FIELDS
    ),
  }),
  importTransform: (pk, columns, localRow) => ({
    ...columns,
    base_project_settings_json: mergeJsonFields(
      columns.base_project_settings_json,
      localRow?.base_project_settings_json as string | null | undefined,
      PROJECT_SETTINGS_LOCAL_FIELDS
    ),
  }),
  importSkipIfMissingParent: [{ column: 'project_id', table: 'projects', columnRef: 'id' }],
};

export const tasksTable: SyncTableConfig = {
  table: 'tasks',
  keyColumns: ['id'],
  mode: 'continuous',
  payloadColumns: [
    'id',
    'project_id',
    'name',
    'status',
    'workflow_stage',
    'source_branch',
    'task_branch',
    'linked_issue',
    'archived_at',
    'created_at',
    'updated_at',
    'last_interacted_at',
    'status_changed_at',
    'is_pinned',
    'workspace_provider',
    'workspace_id',
    'type',
    'automation_run_id',
    'assigned_pr_url',
  ],
  // board_rank (derived fractional-index state) and the dead
  // workspace_provider_data / workspace_intent columns are never sent.
  rawJsonColumns: ['linked_issue'],
  importNullIfMissingFk: [{ column: 'assigned_pr_url', table: 'pull_requests', columnRef: 'url' }],
  importSkipIfMissingParent: [{ column: 'project_id', table: 'projects', columnRef: 'id' }],
};

export const conversationsTable: SyncTableConfig = {
  table: 'conversations',
  keyColumns: ['id'],
  mode: 'continuous',
  // Metadata only: transcripts (messages) are out of scope. session_id /
  // agent_status / agent_status_seen are machine-specific and never sent.
  payloadColumns: [
    'id',
    'project_id',
    'task_id',
    'title',
    'provider',
    'config',
    'created_at',
    'updated_at',
    'last_interacted_at',
    'is_initial_conversation',
    'type',
  ],
  rawJsonColumns: ['config'],
  importSkipIfMissingParent: [
    { column: 'project_id', table: 'projects', columnRef: 'id' },
    { column: 'task_id', table: 'tasks', columnRef: 'id' },
  ],
};

export const automationsTable: SyncTableConfig = {
  table: 'automations',
  keyColumns: ['id'],
  mode: 'continuous',
  payloadColumns: [
    'id',
    'name',
    'project_id',
    'trigger_config',
    'conversation_config',
    'task_config',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  rawJsonColumns: ['trigger_config', 'conversation_config', 'task_config'],
  // `enabled` is machine-local (never in the payload); fresh imports default
  // to disabled so the receiving machine opts in explicitly.
  importInsertColumns: { enabled: '0' },
  importSkipIfMissingParent: [{ column: 'project_id', table: 'projects', columnRef: 'id' }],
};

export const promptLibraryTable: SyncTableConfig = {
  table: 'kv:prompt-library',
  keyColumns: ['key'],
  mode: 'continuous',
  payloadColumns: ['value'],
  rawJsonColumns: [],
  kvStyle: true,
  isPortablePk: (pk) => pk.startsWith('prompt-library:'),
};

export const appSettingsTable: SyncTableConfig = {
  table: 'app_settings',
  keyColumns: ['key'],
  mode: 'continuous',
  payloadColumns: ['value'],
  rawJsonColumns: [],
  kvStyle: true,
  isPortablePk: (pk) => !(EXCLUDED_APP_SETTINGS_KEYS as readonly string[]).includes(pk),
  pushTransform: (pk, columns) => ({
    ...columns,
    value: stripJsonFields(columns.value, APP_SETTINGS_LOCAL_FIELDS[pk] ?? []),
  }),
  importTransform: (pk, columns, localRow) => ({
    ...columns,
    value: mergeJsonFields(
      columns.value,
      localRow?.value as string | null | undefined,
      APP_SETTINGS_LOCAL_FIELDS[pk] ?? []
    ),
  }),
};

/**
 * Allowlisted tables in push order (parents before children so the relay's
 * receipt-order versions keep FK applicability on the pull side).
 */
export const SYNC_TABLES: SyncTableConfig[] = [
  projectsTable,
  projectRemotesTable,
  projectSettingsTable,
  tasksTable,
  conversationsTable,
  automationsTable,
  promptLibraryTable,
  appSettingsTable,
];

export const SYNC_TABLES_BY_NAME = new Map(SYNC_TABLES.map((config) => [config.table, config]));

export function isInitialOnly(config: SyncTableConfig): boolean {
  return config.mode === 'initial-only';
}

// ---------------------------------------------------------------------------
// JSON blob helpers for the machine-specific field transforms
// ---------------------------------------------------------------------------

function stripJsonFields(raw: string | null, fields: string[]): string | null {
  const record = parseJsonObject(raw);
  if (record === null) return raw;
  let changed = false;
  for (const field of fields) {
    if (field in record) {
      delete record[field];
      changed = true;
    }
  }
  return changed ? JSON.stringify(record) : raw;
}

function mergeJsonFields(
  remoteRaw: string | null,
  localRaw: string | null | undefined,
  fields: string[]
): string | null {
  const local = parseJsonObject(localRaw ?? null);
  if (local === null) return remoteRaw;
  const remote = parseJsonObject(remoteRaw) ?? {};
  let changed = false;
  for (const field of fields) {
    if (field in local) {
      remote[field] = local[field];
      changed = true;
    }
  }
  return changed ? JSON.stringify(remote) : remoteRaw;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
