/**
 * Minimal type shim for the subset of `node:sqlite` used by the test harness.
 *
 * The relay package deliberately has no `@types/node` dependency: the worker
 * source runs on the Cloudflare runtime and tests run on the Node runtime
 * (Node >= 24 ships `node:sqlite` as a built-in, unflagged). Declaring the
 * handful of classes the harness touches keeps the shim honest without pulling
 * the whole Node type surface into the same compilation unit as
 * `@cloudflare/workers-types`.
 */
declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;

  export interface StatementSync {
    run(...anonymousParameters: SQLInputValue[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    get(...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue>[];
  }

  export class DatabaseSync {
    constructor(location: string | URL);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
