import type { DiscoveredJob } from '../types.ts';

/**
 * JazzHR provider — JazzHR boards live at `{slug}.applytojob.com` and expose no
 * public JSON (the `resumatorapi.com` feed needs a per-account key), but the
 * board page at `/apply/jobs/` is server-rendered: one
 * `<div id="row_job_{YYYYMMDDHHMMSS}_{code}" class="jobs_row">` per posting,
 * each with a `job_title_link` to `/apply/jobs/details/{id}` and a
 * `Location:` span. The row id's timestamp gives the posted date.
 *
 * ponytail: regex over the row markup rather than a DOM parse — no HTML parser
 * in this stack, four fields needed. The timestamp is read as UTC (JazzHR
 * doesn't label a zone); that's day-granularity, fine for freshness. Upgrade
 * path if the board layout drifts: a DOM parse or the keyed resumator API.
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the slug. */
  company?: string;
}

// NaN-safe ISO conversion.
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** `20260717200310` → `2026-07-17T20:03:10Z` (read as UTC). */
function stampToIso(stamp: string): string {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return '';
  return toIso(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

/** Strip tags + decode the handful of entities JazzHR titles use. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchJazzHr(
  slug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `https://${slug}.applytojob.com`;
  const url = `${base}/apply/jobs/`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`jazzhr: HTTP ${res.status} for ${slug}`);
  const html = await res.text();

  // Split on the row marker so each chunk is exactly one posting.
  const rows = html.split(/(?=<div id="row_job_)/).filter((r) => r.includes('row_job_'));
  const out: DiscoveredJob[] = [];
  for (const row of rows) {
    const idMatch = row.match(/\/apply\/jobs\/details\/([A-Za-z0-9]+)/);
    if (!idMatch) continue;
    const jobId = idMatch[1];
    const stamp = row.match(/row_job_(\d{14})_/);
    const title = row.match(/class="job_title_link"[^>]*>([\s\S]*?)<\/a>/);
    const loc = row.match(/Location:<\/strong>\s*([^<]*)</);
    out.push({
      source: slug,
      externalId: jobId,
      company: opts.company ?? slug,
      role: title ? textOf(title[1]) : '',
      location: loc ? textOf(loc[1]) : '',
      ats: 'jazzhr' as const,
      applyUrl: `${base}/apply/jobs/details/${jobId}`,
      postedAt: stamp ? stampToIso(stamp[1]) : '',
    });
  }
  return out;
}
