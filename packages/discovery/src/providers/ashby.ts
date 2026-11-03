import { MAX_DESCRIPTION_CHARS, type DiscoveredJob } from '../types.ts';

/**
 * Ashby provider — reads the public posting-api JSON feed.
 * `https://api.ashbyhq.com/posting-api/job-board/{slug}`
 * → `{ jobs: [{ id, title, location, jobUrl | applyUrl, publishedAt }] }`.
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

// The fillable Ashby form always lives at the posting url + /application.
// Derive it canonically from the feed's jobUrl (posting) or applyUrl: drop any
// query string / existing /application suffix, then append /application — so we
// always yield the form url, never the posting page prepareApplication skips.
function toApplicationUrl(
  jobUrl: string | null | undefined,
  applyUrl: string | null | undefined,
): string | undefined {
  const base = (jobUrl ?? applyUrl ?? '')
    .split('?')[0]
    .replace(/\/application\/?$/, '')
    .replace(/\/+$/, '');
  return base ? `${base}/application` : undefined;
}

export async function fetchAshby(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const company = opts.company ?? companySlug;
  const url = `https://api.ashbyhq.com/posting-api/job-board/${companySlug}`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`ashby: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as {
    jobs?: Array<{
      id?: string;
      title?: string;
      location?: string;
      jobUrl?: string;
      applyUrl?: string;
      publishedAt?: string;
      descriptionPlain?: string;
    }>;
  };

  const jobs = Array.isArray(json.jobs) ? json.jobs : [];
  return jobs
    // Always emit the canonical /application form url, not the posting page.
    .map((j) => ({ ...j, applyUrl: toApplicationUrl(j.jobUrl, j.applyUrl) }))
    .filter((j) => j.applyUrl)
    .map((j) => ({
      source: companySlug,
      externalId: String(j.id ?? ''),
      company,
      role: j.title ?? '',
      location: j.location ?? '',
      ats: 'ashby' as const,
      applyUrl: j.applyUrl!,
      postedAt: toIso(j.publishedAt),
      description: j.descriptionPlain?.slice(0, MAX_DESCRIPTION_CHARS),
    }));
}
