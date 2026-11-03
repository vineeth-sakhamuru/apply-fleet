import { DatabaseSync } from 'node:sqlite';

/**
 * Minimal async DB seam. One interface, two drivers: node:sqlite now,
 * Postgres later (pg / PGlite). Queries use `?` placeholders; the Postgres
 * adapter rewrites them to `$1..$n`. This is the whole "Postgres-ready" seam.
 */
export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined>;
  all<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function openSqlite(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  // One synchronous connection: serialize transactions so concurrent callers
  // (e.g. the pipeline preparing several apps at once) never nest a BEGIN.
  let txChain: Promise<unknown> = Promise.resolve();

  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...(params as never[])) as never;
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...(params as never[])) as never;
    },
    async tx(fn) {
      const run = txChain.then(async () => {
        db.exec('BEGIN');
        try {
          const r = await fn();
          db.exec('COMMIT');
          return r;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      });
      // Keep the chain alive regardless of this transaction's outcome.
      txChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    async close() {
      db.close();
    },
  };
}
