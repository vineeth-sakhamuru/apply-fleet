import type { DiscoveredJob } from '../types.ts';

/**
 * Breezy provider — reads the public positions JSON feed.
 * `https://{slug}.breezy.hr/json`
 * → `[{ id, friendly_id, name, url, location: { name }, company: { name }, published_date }]`.
 * The feed's `url` is the canonical public posting/apply page
 * (`https://{slug}.breezy.hr/p/{friendly_id}`).
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

export async function fetchBreezy(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://${companySlug}.breezy.hr/json`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`breezy: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as Array<{
    id?: string;
    friendly_id?: string;
    name?: string;
    url?: string;
    location?: { name?: string };
    company?: { name?: string };
    published_date?: string;
  }>;

  const positions = Array.isArray(json) ? json : [];
  return positions
    .filter((j) => j.id != null)
    .map((j) => ({
      source: companySlug,
      externalId: String(j.id ?? ''),
      company: opts.company ?? j.company?.name ?? companySlug,
      role: j.name ?? '',
      location: j.location?.name ?? '',
      ats: 'breezy' as const,
      applyUrl: j.url ?? `https://${companySlug}.breezy.hr/p/${j.friendly_id}`,
      postedAt: toIso(j.published_date),
    }));
}
