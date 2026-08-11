/**
 * In-process D1-compatible harness for the relay tests.
 *
 * Implemented on top of `node:sqlite` (built into Node >= 24) so the relay's
 * SQL runs against real SQLite semantics: PRIMARY KEY / UNIQUE constraints,
 * `ON CONFLICT ... DO UPDATE`, `RETURNING`, and transactional `batch()`.
 *
 * Deliberately NOT miniflare/workerd: this keeps the relay's test suite
 * dependency-free (no workerd binary download) and fast, while the SQL surface
 * the relay uses is small enough that the two implementations cannot drift.
 * The `SqlDb` interface in `src/db.ts` is the single seam between the real D1
 * binding (workers-types) and this harness.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import type { SqlDb, SqlResult, SqlStatement } from '../src/db';

type Row = Record<string, unknown>;

function toPlainRow(row: Record<string, unknown> | undefined): Row | null {
  return row === undefined ? null : { ...row };
}

class MemoryStatement implements SqlStatement {
  private params: unknown[] = [];

  constructor(private readonly stmt: StatementSync) {}

  bind(...params: unknown[]): SqlStatement {
    this.params = params;
    return this;
  }

  private args(): SQLInputValue[] {
    return this.params as SQLInputValue[];
  }

  async run(): Promise<SqlResult> {
    const row = this.stmt.get(...this.args());
    const result: SqlResult = { success: true, meta: {} };
    if (row !== undefined) {
      result.results = [toPlainRow(row) as Row];
    }
    return result;
  }

  async first<T>(): Promise<T | null> {
    const row = this.stmt.get(...this.args());
    return toPlainRow(row) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.stmt.all(...this.args());
    return { results: rows.map((row) => toPlainRow(row) as T) };
  }
}

export class MemoryD1 implements SqlDb {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  prepare(sql: string): SqlStatement {
    return new MemoryStatement(this.db.prepare(sql));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    this.db.exec('BEGIN');
    try {
      const results: SqlResult[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
