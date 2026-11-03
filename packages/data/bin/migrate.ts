import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openSqlite, SCHEMA } from '../src/index.ts';

const dbPath =
  process.env.APPLY_FLEET_DB ??
  resolve(import.meta.dirname, '../../../data/apply-fleet.db');

mkdirSync(dirname(dbPath), { recursive: true });

const db = openSqlite(dbPath);
await db.exec(SCHEMA);
const tables = await db.all<{ name: string }>(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
);
await db.close();

console.log(`migrated ${dbPath}`);
console.log('tables:', tables.map((t) => t.name).join(', '));
