import type { DiscoveredJob } from '../types.ts';

/**
 * Workday provider — reads the `wday/cxs` search API that powers every
 * `*.myworkdayjobs.com` career site. Workday needs three coordinates, so the
 * `slug` is `tenant:dc:site`, e.g. `nvidia:wd5:NVIDIAExternalCareerSite`
 * (tenant + Workday datacenter + external site id).
 *
 * POST `https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`
 * with `{ appliedFacets:{}, limit, offset, searchText:"" }`
 * → `{ total, jobPostings: [{ title, externalPath, locationsText, postedOn }] }`.
 * The public posting/apply page is
 * `https://{tenant}.{dc}.myworkdayjobs.com/{site}{externalPath}`.
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the tenant. */
  company?: string;
  /** Page size for the search POST. */
  limit?: number;
  /** Max pages to walk (page size is capped at 20 by Workday). Default 10. */
  maxPages?: number;
  /** Reference time for resolving Workday's relative "Posted N Days Ago". */
  now?: number;
}

// NaN-safe ISO conversion.
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * Workday's list feed only carries a *relative* posted string ("Posted Today",
 * "Posted 5 Days Ago", "Posted 30+ Days Ago"), never an absolute timestamp —
 * the exact date needs an N+1 per-job detail fetch. We approximate from the
 * relative text so freshness ("within minutes of posting") still works for
 * Workday; unrecognized text yields '' and the job is kept (see normalize.ts).
 * ponytail: approximate day-granularity dates; upgrade path is the detail fetch.
 */
function relativePostedToIso(text: string | undefined, now: number): string {
  if (!text) return '';
  const t = text.toLowerCase();
  if (t.includes('today')) return new Date(now).toISOString();
  if (t.includes('yesterday')) return new Date(now - 86400000).toISOString();
  const m = t.match(/(\d+)\+?\s*days?\s*ago/);
  if (m) return new Date(now - Number(m[1]) * 86400000).toISOString();
  return '';
}

export async function fetchWorkday(
  slug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const [tenant, dc, site] = slug.split(':');
  if (!tenant || !dc || !site) {
    throw new Error(`workday: slug must be "tenant:dc:site", got "${slug}"`);
  }
  const base = `https://${tenant}.${dc}.myworkdayjobs.com`;
  const url = `${base}/wday/cxs/${tenant}/${site}/jobs`;

  type Posting = {
    title?: string;
    externalPath?: string;
    locationsText?: string;
    postedOn?: string;
    bulletFields?: string[];
  };

  // Workday caps a page at 20 however large a limit we ask for, so a single
  // POST silently truncated every tenant to 20 — the biggest employers (NVIDIA
  // has thousands of reqs) looked like the smallest. Page until exhausted,
  // bounded so one huge tenant can't run away with the whole cycle.
  const pageSize = opts.limit ?? 20;
  const maxPages = opts.maxPages ?? 10;
  const postings: Posting[] = [];
  let total = Infinity;
  for (let page = 0; page < maxPages && postings.length < total; page++) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        appliedFacets: {},
        limit: pageSize,
        offset: page * pageSize,
        searchText: '',
      }),
    });
    if (!res.ok) {
      // Losing page 3 shouldn't lose the tenant — keep what we have. Only a
      // failure on the first page is fatal.
      if (page === 0) throw new Error(`workday: HTTP ${res.status} for ${slug}`);
      break;
    }
    const json = (await res.json()) as { jobPostings?: Posting[]; total?: number };
    const batch = Array.isArray(json.jobPostings) ? json.jobPostings : [];
    // `total` is unreliable — several tenants report 0 while still serving full
    // pages, which stopped paging almost immediately. Trust it only when it's a
    // positive number; otherwise page until a short page says we're done.
    if (typeof json.total === 'number' && json.total > 0) total = json.total;
    postings.push(...batch);
    if (batch.length < pageSize) break; // short page = last page
  }

  return postings
    .filter((j) => j.externalPath)
    .map((j) => ({
      source: slug,
      // bulletFields usually carries the req id (JR…); fall back to the path.
      externalId: j.bulletFields?.[0] ?? j.externalPath ?? '',
      company: opts.company ?? tenant,
      role: j.title ?? '',
      location: j.locationsText ?? '',
      ats: 'workday' as const,
      applyUrl: `${base}/${site}${j.externalPath}`,
      postedAt: relativePostedToIso(j.postedOn, now) || toIso(j.postedOn),
    }));
}
