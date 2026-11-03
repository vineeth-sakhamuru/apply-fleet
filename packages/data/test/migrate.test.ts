import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite, migrate, MIGRATIONS } from '../src/index.ts';

// SCHEMA is CREATE-IF-NOT-EXISTS, so a column added to an existing table never
// reaches a database that already exists. That is the failure this guards: the
// live db keeps the old shape and the new feature reads undefined forever.

const OLD_SCHEMA = `
CREATE TABLE applications (
  id TEXT PRIMARY KEY, company TEXT NOT NULL, role TEXT NOT NULL,
  location TEXT NOT NULL, ats TEXT NOT NULL, apply_url TEXT NOT NULL,
  posted_at TEXT NOT NULL, discovered_at TEXT NOT NULL, status TEXT NOT NULL,
  match_score INTEGER NOT NULL DEFAULT 0, resume_variant TEXT, fields TEXT,
  hitl TEXT, ready_spec TEXT, updated_at TEXT NOT NULL
);`;

async function old() {
  const db = openSqlite(':memory:');
  await db.exec(OLD_SCHEMA);
  return db;
}

test('migrates a database created before the column existed', async () => {
  const db = await old();
  await assert.rejects(
    () => db.run('INSERT INTO applications (id, company, role, location, ats, apply_url, posted_at, discovered_at, status, updated_at, description) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ['a', 'c', 'r', 'l', 'greenhouse', 'u', 't', 't', 'queued', 't', 'jd']),
    'the column must genuinely be missing first',
  );

  const applied = await migrate(db);
  assert.deepEqual(applied, MIGRATIONS.map((m) => m.id));

  await db.run(
    'INSERT INTO applications (id, company, role, location, ats, apply_url, posted_at, discovered_at, status, updated_at, description) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['a', 'c', 'r', 'l', 'greenhouse', 'u', 't', 't', 'queued', 't', 'the job description'],
  );
  const row = await db.get<{ description: string }>('SELECT description FROM applications WHERE id = ?', ['a']);
  assert.equal(row?.description, 'the job description');
});

test('is idempotent — a second boot applies nothing', async () => {
  const db = await old();
  await migrate(db);
  assert.deepEqual(await migrate(db), [], 're-running must be a no-op');
});

test('an already-present column is recorded, not thrown', async () => {
  // A db that someone hand-patched, or one created from the current SCHEMA.
  const db = openSqlite(':memory:');
  await db.exec(OLD_SCHEMA);
  await db.exec('ALTER TABLE applications ADD COLUMN description TEXT');
  await migrate(db); // must not throw
  assert.deepEqual(await migrate(db), []);
});
