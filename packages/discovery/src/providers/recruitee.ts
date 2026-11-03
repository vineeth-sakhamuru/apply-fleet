import type { DiscoveredJob } from '../types.ts';

/**
 * Recruitee provider — reads the public offers JSON feed.
 * `https://{slug}.recruitee.com/api/offers/`
 * → `{ offers: [{ id, title, company_name, location, careers_apply_url, careers_url, published_at }] }`.
 * The feed already carries the canonical apply URL (`careers_apply_url`,
 * e.g. `https://{careers-domain}/o/{slug}/c/new`), which honors custom domains.
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the feed's company name / slug. */
  company?: string;
}

// NaN-safe ISO conversion — an unparseable timestamp yields '' rather than
// "Invalid Date".
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export async function fetchRecruitee(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://${companySlug}.recruitee.com/api/offers/`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`recruitee: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as {
    offers?: Array<{
      id?: number | string;
      title?: string;
      company_name?: string;
      location?: string;
      careers_apply_url?: string;
      careers_url?: string;
      published_at?: string;
    }>;
  };

  const offers = Array.isArray(json.offers) ? json.offers : [];
  return offers
    .filter((j) => j.id != null)
    .map((j) => ({
      source: companySlug,
      externalId: String(j.id ?? ''),
      company: opts.company ?? j.company_name ?? companySlug,
      role: j.title ?? '',
      location: j.location ?? '',
      ats: 'recruitee' as const,
      applyUrl: j.careers_apply_url ?? j.careers_url ?? '',
      postedAt: toIso(j.published_at),
    }));
}
