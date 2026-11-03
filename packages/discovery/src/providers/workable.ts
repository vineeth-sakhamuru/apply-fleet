import type { DiscoveredJob } from '../types.ts';

/**
 * Workable provider — reads the public careers-widget JSON feed.
 * `https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true`
 * → `{ name, jobs: [{ shortcode, title, city, state, country, published_on }] }`.
 * The public apply form is `https://apply.workable.com/{slug}/j/{shortcode}/apply`.
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the feed's account name / slug. */
  company?: string;
}

// NaN-safe ISO conversion — an unparseable timestamp yields '' rather than
// "Invalid Date".
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export async function fetchWorkable(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://apply.workable.com/api/v1/widget/accounts/${companySlug}?details=true`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`workable: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as {
    name?: string;
    jobs?: Array<{
      shortcode?: string;
      title?: string;
      city?: string;
      state?: string;
      country?: string;
      published_on?: string;
    }>;
  };

  const jobs = Array.isArray(json.jobs) ? json.jobs : [];
  return jobs
    .filter((j) => j.shortcode != null)
    .map((j) => {
      const location = [j.city, j.state, j.country].filter(Boolean).join(', ');
      return {
        source: companySlug,
        externalId: String(j.shortcode ?? ''),
        company: opts.company ?? json.name ?? companySlug,
        role: j.title ?? '',
        location,
        ats: 'workable' as const,
        applyUrl: `https://apply.workable.com/${companySlug}/j/${j.shortcode}/apply`,
        postedAt: toIso(j.published_on),
      };
    });
}
