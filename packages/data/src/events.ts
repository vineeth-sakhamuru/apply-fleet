import type { Db } from './db.ts';

/**
 * Append-only event log + projection reducer.
 *
 * `append` assigns a global `seq` and a per-aggregate `version` inside one
 * transaction, writes the event, then folds it into the projection tables.
 * Single-writer (the orchestrator process), so MAX()+1 sequencing is safe and
 * needs no dialect-specific auto-increment.
 */

export type EventType =
  | 'application.discovered'
  | 'application.status_changed'
  | 'answer.cached'
  | 'email.received';

export type Aggregate = 'application' | 'answer' | 'email';

export interface AppendInput {
  type: EventType;
  aggregate: Aggregate;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export async function append(db: Db, input: AppendInput): Promise<void> {
  await db.tx(async () => {
    const seqRow = await db.get<{ next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events',
    );
    const verRow = await db.get<{ next: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM events WHERE aggregate = ? AND aggregate_id = ?',
      [input.aggregate, input.aggregateId],
    );
    const seq = Number(seqRow?.next ?? 1);
    const version = Number(verRow?.next ?? 1);
    const ts = new Date().toISOString();

    await db.run(
      `INSERT INTO events (seq, id, type, aggregate, aggregate_id, version, payload, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seq,
        `evt_${seq}`,
        input.type,
        input.aggregate,
        input.aggregateId,
        version,
        JSON.stringify(input.payload),
        ts,
      ],
    );

    await applyProjection(db, input, ts);
  });
}

async function applyProjection(
  db: Db,
  input: AppendInput,
  ts: string,
): Promise<void> {
  const p = input.payload as Record<string, unknown>;
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

  switch (input.type) {
    case 'application.discovered':
      await db.run(
        `INSERT INTO applications
           (id, company, role, location, ats, apply_url, posted_at, discovered_at,
            status, match_score, resume_variant, fields, hitl, description, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.aggregateId,
          p.company,
          p.role,
          p.location,
          p.ats,
          p.applyUrl,
          p.postedAt,
          p.discoveredAt ?? ts,
          p.status ?? 'queued',
          p.matchScore ?? 0,
          p.resumeVariant ?? null,
          json(p.fields),
          json(p.hitl),
          p.description ?? null,
          ts,
        ],
      );
      break;

    case 'application.status_changed':
      await db.run(
        `UPDATE applications
            SET status = ?,
                resume_variant = COALESCE(?, resume_variant),
                fields = COALESCE(?, fields),
                hitl = ?,
                ready_spec = COALESCE(?, ready_spec),
                updated_at = ?
          WHERE id = ?`,
        [
          p.status,
          p.resumeVariant ?? null,
          json(p.fields),
          json(p.hitl),
          json(p.spec),
          ts,
          input.aggregateId,
        ],
      );
      break;

    case 'answer.cached':
      await db.run(
        `INSERT INTO answers (question_norm, question, answer, source, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (question_norm) DO UPDATE SET
           answer = excluded.answer,
           source = excluded.source,
           question = excluded.question,
           updated_at = excluded.updated_at`,
        [p.questionNorm, p.question, p.answer, p.source, ts],
      );
      break;

    case 'email.received':
      await db.run(
        `INSERT INTO emails
           (id, application_id, alias, direction, subject, from_addr, received_at, parsed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.aggregateId,
          p.applicationId ?? null,
          p.alias,
          p.direction ?? 'inbound',
          p.subject ?? null,
          p.fromAddr ?? null,
          p.receivedAt ?? ts,
          json(p.parsed),
        ],
      );
      break;
  }
}
