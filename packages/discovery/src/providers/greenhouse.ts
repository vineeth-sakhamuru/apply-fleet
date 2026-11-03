import { htmlToText, type DiscoveredJob } from '../types.ts';

/**
 * Greenhouse provider — reads the public boards-api JSON feed.
 * `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
 * → `{ jobs: [{ id, title, location: { name }, absolute_url, updated_at }] }`.
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

export async function fetchGreenhouse(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const company = opts.company ?? companySlug;
  const url = `https://boards-api.greenhouse.io/v1/boards/${companySlug}/jobs?content=true`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`greenhouse: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as {
    jobs?: Array<{
      id?: number | string;
      title?: string;
      location?: { name?: string };
      absolute_url?: string;
      first_published?: string;
      updated_at?: string;
      content?: string;
    }>;
  };

  const jobs = Array.isArray(json.jobs) ? json.jobs : [];
  return jobs
    .filter((j) => j.absolute_url)
    .map((j) => ({
      source: companySlug,
      externalId: String(j.id ?? ''),
      company,
      role: j.title ?? '',
      location: j.location?.name ?? '',
      ats: 'greenhouse' as const,
      applyUrl: j.absolute_url!,
      // Freshness keys off when the posting went live, not last edit.
      postedAt: toIso(j.first_published ?? j.updated_at),
      // `?content=true` is already in the URL — this was being fetched and dropped.
      description: j.content ? htmlToText(j.content) : undefined,
    }));
}
