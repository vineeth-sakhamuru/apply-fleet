import type { EmailRecord } from '@apply-fleet/shared';
import type { Db } from './db.ts';

/** Raw projection row + the joined application columns. */
interface Row {
  id: string;
  application_id: string | null;
  alias: string;
  direction: string;
  subject: string | null;
  from_addr: string | null;
  received_at: string;
  parsed: string | null;
  company: string | null;
  role: string | null;
}

export function rowToEmail(r: Row): EmailRecord {
  const parsed = r.parsed
    ? (JSON.parse(r.parsed) as { kind?: string })
    : undefined;
  return {
    id: r.id,
    applicationId: r.application_id ?? undefined,
    company: r.company ?? undefined,
    role: r.role ?? undefined,
    alias: r.alias,
    direction: r.direction as EmailRecord['direction'],
    subject: r.subject ?? undefined,
    fromAddr: r.from_addr ?? undefined,
    receivedAt: r.received_at,
    kind: parsed?.kind,
  };
}

/**
 * The reply log, newest first, joined to the application it belongs to.
 * LEFT JOIN on purpose: an email whose alias never resolved still shows up
 * rather than vanishing from the dashboard.
 */
export async function listEmails(
  db: Db,
  opts: { limit?: number } = {},
): Promise<EmailRecord[]> {
  const rows = await db.all<Row>(
    `SELECT e.id, e.application_id, e.alias, e.direction, e.subject,
            e.from_addr, e.received_at, e.parsed, a.company, a.role
       FROM emails e
       LEFT JOIN applications a ON a.id = e.application_id
      ORDER BY e.received_at DESC, e.id DESC
      LIMIT ?`,
    [opts.limit ?? 200],
  );
  return rows.map(rowToEmail);
}
