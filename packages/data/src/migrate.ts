import type { Db } from './db.ts';

/**
 * Additive schema migrations.
 *
 * `SCHEMA` uses `CREATE TABLE IF NOT EXISTS`, which means a column added to an
 * existing table is silently NOT applied to a database that already exists —
 * every dev and the live `data/live.db` would keep the old shape and the new
 * feature would read undefined forever. That is the bug this prevents.
 *
 * Deliberately minimal: a list of `ALTER TABLE ADD COLUMN` statements, each
 * applied once, tracked in a table. Additive only — no renames, no drops, no
 * down-migrations. That covers every change this schema has needed so far and
 * keeps both engines happy (`ADD COLUMN` is identical on SQLite and Postgres).
 *
 * ponytail: no down-migrations and no checksums. Ceiling: an additive column or
 * index. Upgrade path — if a destructive or data-backfilling change is ever
 * needed, that's the point to reach for a real migration tool, not to extend
 * this.
 */

export interface Migration {
  /** Stable identifier. NEVER reuse or renumber — it's the applied-marker. */
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    // The JD text the résumé tailor keys off. Without it, tailoring ran against
    // "Role — Company", matched no keywords, and the rewording never fired.
    id: '001-applications-description',
    sql: 'ALTER TABLE applications ADD COLUMN description TEXT',
  },
];

const TRACKING = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

/**
 * Apply every migration not yet recorded. Idempotent, so it's safe to call on
 * every boot — which is the point: nobody has to remember to run it.
 *
 * A migration that fails because the column already exists (a database created
 * before tracking existed) is recorded as applied rather than crashing the
 * process. Any other failure propagates — a half-migrated schema must be loud.
 */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(TRACKING);
  const done = new Set(
    (await db.all<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id),
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    try {
      await db.exec(m.sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column|already exists/i.test(msg)) throw e;
    }
    await db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
      m.id,
      new Date().toISOString(),
    ]);
    applied.push(m.id);
  }
  return applied;
}
