/**
 * Portable DDL — runs identically on SQLite (node:sqlite) and Postgres.
 *
 * Portability rules kept here:
 *  - only TEXT / INTEGER column types (both engines share them)
 *  - timestamps are ISO-8601 TEXT; JSON payloads are TEXT
 *  - no AUTOINCREMENT / SERIAL: the event `seq` is assigned in app code
 *    (single-writer orchestrator) so the schema needs no dialect branch
 *  - `ON CONFLICT ... DO UPDATE` upsert works on SQLite 3.24+ and Postgres
 *
 * Event-sourced: `events` is the append-only log; the other tables are
 * projections rebuilt by applying events. Swapping to Postgres is a driver
 * swap (see db.ts), not a schema change.
 */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER NOT NULL,
  id           TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  aggregate    TEXT    NOT NULL,
  aggregate_id TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  payload      TEXT    NOT NULL,
  ts           TEXT    NOT NULL,
  PRIMARY KEY (seq)
);
CREATE INDEX IF NOT EXISTS idx_events_agg ON events (aggregate, aggregate_id, version);

CREATE TABLE IF NOT EXISTS applications (
  id             TEXT PRIMARY KEY,
  company        TEXT    NOT NULL,
  role           TEXT    NOT NULL,
  location       TEXT    NOT NULL,
  ats            TEXT    NOT NULL,
  apply_url      TEXT    NOT NULL,
  posted_at      TEXT    NOT NULL,
  discovered_at  TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  match_score    INTEGER NOT NULL DEFAULT 0,
  resume_variant TEXT,
  fields         TEXT,
  hitl           TEXT,
  ready_spec     TEXT,
  description    TEXT,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS answers (
  question_norm TEXT PRIMARY KEY,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  source        TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id             TEXT PRIMARY KEY,
  application_id TEXT,
  alias          TEXT NOT NULL,
  direction      TEXT NOT NULL,
  subject        TEXT,
  from_addr      TEXT,
  received_at    TEXT NOT NULL,
  parsed         TEXT
);
CREATE INDEX IF NOT EXISTS idx_emails_app ON emails (application_id);
`;
