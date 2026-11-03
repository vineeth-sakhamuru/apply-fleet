import { PGlite } from '@electric-sql/pglite';
import type { Db } from '../src/db.ts';

/** Rewrite `?` positional placeholders to Postgres `$1..$n`. */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** Postgres-backed Db (in-process WASM Postgres) — used to prove portability. */
export async function openPglite(): Promise<Db> {
  const db = await PGlite.create();
  return {
    async exec(sql) {
      await db.exec(sql);
    },
    async run(sql, params = []) {
      await db.query(toPg(sql), params as unknown[]);
    },
    async get(sql, params = []) {
      const r = await db.query(toPg(sql), params as unknown[]);
      return r.rows[0] as never;
    },
    async all(sql, params = []) {
      const r = await db.query(toPg(sql), params as unknown[]);
      return r.rows as never;
    },
    async tx(fn) {
      await db.exec('BEGIN');
      try {
        const r = await fn();
        await db.exec('COMMIT');
        return r;
      } catch (e) {
        await db.exec('ROLLBACK');
        throw e;
      }
    },
    async close() {
      await db.close();
    },
  };
}
