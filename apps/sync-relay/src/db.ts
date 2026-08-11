/**
 * Minimal D1-shaped database surface used by the relay.
 *
 * The relay only needs a handful of D1 features: parameterised prepared
 * statements (`prepare().bind().run()/first()/all()`), `exec()` for the
 * idempotent schema bootstrap, and `batch()` for the transactional
 * counter-increment + row-write pair.
 *
 * The real Cloudflare D1 binding (`D1Database` from @cloudflare/workers-types)
 * structurally satisfies this interface, which keeps the worker entry free of
 * any test harness. Tests run against an in-process implementation backed by
 * `node:sqlite` (see `test/memory-d1.ts`), so the same SQL executes against
 * real SQLite semantics in both environments.
 */

export interface SqlResult {
  success: boolean;
  meta?: {
    changes?: number;
    last_row_id?: number;
  };
  /** Rows returned by the statement (e.g. `UPDATE ... RETURNING version`). */
  results?: unknown[];
}

export interface SqlStatement {
  bind(...params: unknown[]): SqlStatement;
  run(): Promise<SqlResult>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  /** Execute one or more statements; used for the idempotent schema bootstrap. */
  exec(sql: string): Promise<unknown>;
  /** Execute statements sequentially inside a single transaction. */
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
}
