import type { DiscoveredJob } from '../types.ts';

/**
 * BambooHR provider — reads a company's public careers-board feed.
 * `https://{slug}.bamboohr.com/careers/list`
 * → `{ result: [{ id, jobOpeningName, location: { city, state }, ... }] }`.
 * The public posting/apply page is `https://{slug}.bamboohr.com/careers/{id}`.
 *
 * Note: the list feed carries no posting date (it lives on the per-job
 * `/careers/{id}/detail` endpoint as `datePosted`), so `postedAt` is '' here.
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

export async function fetchBambooHr(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const company = opts.company ?? companySlug;
  const url = `https://${companySlug}.bamboohr.com/careers/list`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`bamboohr: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as {
    result?: Array<{
      id?: number | string;
      jobOpeningName?: string;
      location?: { city?: string; state?: string };
      datePosted?: string;
    }>;
  };

  const postings = Array.isArray(json.result) ? json.result : [];
  return postings
    .filter((j) => j.id != null)
    .map((j) => {
      const loc = j.location ?? {};
      return {
        source: companySlug,
        externalId: String(j.id ?? ''),
        company,
        role: j.jobOpeningName ?? '',
        location: [loc.city, loc.state].filter(Boolean).join(', '),
        ats: 'bamboohr' as const,
        applyUrl: `https://${companySlug}.bamboohr.com/careers/${j.id}`,
        postedAt: toIso(j.datePosted),
      };
    });
}
