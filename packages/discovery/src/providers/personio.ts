import type { DiscoveredJob } from '../types.ts';

/**
 * Personio provider — reads a company's public jobs-board feed.
 * `https://{slug}.jobs.personio.de/search.json`
 * → `[{ id, name, offices: [..], office, department, ... }]` (a flat array).
 * The public posting/apply page is `https://{slug}.jobs.personio.de/job/{id}`.
 *
 * Note: search.json carries no posting date, so `postedAt` is '' for this feed.
 * (The XML feed at `/xml` exposes `createdAt`, but needs an XML parser.)
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the slug. */
  company?: string;
}

// NaN-safe ISO conversion — an unparseable timestamp yields '' rather than
// "Invalid Date".
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export async function fetchPersonio(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const company = opts.company ?? companySlug;
  const url = `https://${companySlug}.jobs.personio.de/search.json`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`personio: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as Array<{
    id?: number | string;
    name?: string;
    office?: string;
    offices?: string[];
    createdAt?: string;
  }>;

  const postings = Array.isArray(json) ? json : [];
  return postings
    .filter((j) => j.id != null)
    .map((j) => ({
      source: companySlug,
      externalId: String(j.id ?? ''),
      company,
      role: j.name ?? '',
      location: Array.isArray(j.offices) ? j.offices.join(', ') : j.office ?? '',
      ats: 'personio' as const,
      applyUrl: `https://${companySlug}.jobs.personio.de/job/${j.id}`,
      postedAt: toIso(j.createdAt),
    }));
}
