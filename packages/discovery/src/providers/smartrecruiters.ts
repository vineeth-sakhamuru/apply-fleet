import type { DiscoveredJob } from '../types.ts';

/**
 * SmartRecruiters provider — reads the public posting-api JSON feed.
 * `https://api.smartrecruiters.com/v1/companies/{slug}/postings`
 * → `{ content: [{ id, name, company: { identifier, name }, location, releasedDate }] }`.
 * The public posting/apply page is `https://jobs.smartrecruiters.com/{identifier}/{id}`.
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

export async function fetchSmartRecruiters(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://api.smartrecruiters.com/v1/companies/${companySlug}/postings`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`smartrecruiters: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as {
    content?: Array<{
      id?: number | string;
      name?: string;
      company?: { identifier?: string; name?: string };
      location?: { city?: string; region?: string; country?: string; fullLocation?: string };
      releasedDate?: string;
    }>;
  };

  const postings = Array.isArray(json.content) ? json.content : [];
  return postings
    .filter((j) => j.id != null)
    .map((j) => {
      const identifier = j.company?.identifier ?? companySlug;
      const loc = j.location ?? {};
      const location =
        loc.fullLocation ??
        [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
      return {
        source: companySlug,
        externalId: String(j.id ?? ''),
        company: opts.company ?? j.company?.name ?? companySlug,
        role: j.name ?? '',
        location,
        ats: 'smartrecruiters' as const,
        applyUrl: `https://jobs.smartrecruiters.com/${identifier}/${j.id}`,
        postedAt: toIso(j.releasedDate),
      };
    });
}
