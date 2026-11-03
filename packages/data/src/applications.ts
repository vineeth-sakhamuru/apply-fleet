import type { Application } from '@apply-fleet/shared';
import type { Db } from './db.ts';

/** Raw projection row shape (snake_case, JSON columns as TEXT). */
interface Row {
  id: string;
  company: string;
  role: string;
  location: string;
  ats: string;
  apply_url: string;
  posted_at: string;
  discovered_at: string;
  status: string;
  match_score: number;
  resume_variant: string | null;
  fields: string | null;
  hitl: string | null;
  description: string | null;
  updated_at: string;
}

export function rowToApplication(r: Row): Application {
  return {
    id: r.id,
    company: r.company,
    role: r.role,
    location: r.location,
    ats: r.ats as Application['ats'],
    applyUrl: r.apply_url,
    postedAt: r.posted_at,
    discoveredAt: r.discovered_at,
    status: r.status as Application['status'],
    matchScore: Number(r.match_score),
    resumeVariant: r.resume_variant ?? undefined,
    fields: r.fields ? JSON.parse(r.fields) : undefined,
    hitl: r.hitl ? JSON.parse(r.hitl) : undefined,
    description: r.description ?? undefined,
    updatedAt: r.updated_at,
  };
}

export async function listApplications(db: Db): Promise<Application[]> {
  const rows = await db.all<Row>(
    'SELECT * FROM applications ORDER BY posted_at DESC',
  );
  return rows.map(rowToApplication);
}

export async function getApplication(
  db: Db,
  id: string,
): Promise<Application | undefined> {
  const row = await db.get<Row>('SELECT * FROM applications WHERE id = ?', [id]);
  return row ? rowToApplication(row) : undefined;
}

export async function listByStatus(
  db: Db,
  status: string,
): Promise<Application[]> {
  const rows = await db.all<Row>(
    'SELECT * FROM applications WHERE status = ? ORDER BY posted_at DESC',
    [status],
  );
  return rows.map(rowToApplication);
}

/** The persisted replayable ready-to-submit spec (survives a crash). */
export async function getReadySpec(
  db: Db,
  id: string,
): Promise<unknown | undefined> {
  const row = await db.get<{ ready_spec: string | null }>(
    'SELECT ready_spec FROM applications WHERE id = ?',
    [id],
  );
  return row?.ready_spec ? JSON.parse(row.ready_spec) : undefined;
}

/** One ATS family's outcome counts, for the metrics endpoint. */
export interface AtsStats {
  ats: string;
  total: number;
  ready: number;
  submitted: number;
  needsYou: number;
  failed: number;
  /** Fraction that reached ready-or-submitted. The honest denominator is every
   *  application we discovered for that ATS, including the login-walled ones. */
  fillRate: number;
}

/**
 * Per-ATS outcome rates. The plan asks for per-ATS success rates; this is the
 * cheapest honest source — the projection already holds every application's
 * terminal state, so no extra bookkeeping can drift out of sync with it.
 */
export async function atsStats(db: Db): Promise<AtsStats[]> {
  const rows = await db.all<{ ats: string; status: string; n: number }>(
    'SELECT ats, status, COUNT(*) AS n FROM applications GROUP BY ats, status',
  );
  const by = new Map<string, AtsStats>();
  for (const r of rows) {
    let s = by.get(r.ats);
    if (!s) {
      s = { ats: r.ats, total: 0, ready: 0, submitted: 0, needsYou: 0, failed: 0, fillRate: 0 };
      by.set(r.ats, s);
    }
    const n = Number(r.n);
    s.total += n;
    if (r.status === 'ready') s.ready += n;
    else if (r.status === 'submitted') s.submitted += n;
    else if (r.status === 'needs_you') s.needsYou += n;
    else if (r.status === 'failed') s.failed += n;
  }
  return [...by.values()]
    .map((s) => ({ ...s, fillRate: s.total ? (s.ready + s.submitted) / s.total : 0 }))
    .sort((a, b) => b.total - a.total);
}
