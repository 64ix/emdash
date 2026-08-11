/**
 * Ambient types for `node:sqlite` (Node >= 22.5).
 *
 * The app's pinned @types/node (20.x) does not declare this builtin, but the
 * sync-relay's in-process D1 harness (`apps/sync-relay/test/memory-d1.ts`) is
 * imported by `join-credential.test.ts` and typechecked inside the app
 * program. Only the surface the harness uses is declared; the runtime module
 * is provided by Node itself.
 */
declare module 'node:sqlite' {
  export type SQLInputValue = string | number | bigint | null | Uint8Array;
  export type SQLOutputValue = string | number | bigint | null | Uint8Array;

  export class StatementSync {
    get(...args: SQLInputValue[]): Record<string, unknown> | undefined;
    all(...args: SQLInputValue[]): Array<Record<string, unknown>>;
    run(...args: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string, options?: unknown);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
