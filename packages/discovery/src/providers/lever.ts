import { MAX_DESCRIPTION_CHARS, type DiscoveredJob } from '../types.ts';

/**
 * Lever provider — reads the public postings JSON feed.
 * `https://api.lever.co/v0/postings/{slug}?mode=json`
 * → `[{ id, text, categories: { location }, hostedUrl, createdAt }]`
 * where `createdAt` is a millisecond epoch.
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

export async function fetchLever(
  companySlug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const company = opts.company ?? companySlug;
  const url = `https://api.lever.co/v0/postings/${companySlug}?mode=json`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`lever: HTTP ${res.status} for ${companySlug}`);
  const json = (await res.json()) as Array<{
    id?: string;
    text?: string;
    categories?: { location?: string };
    hostedUrl?: string;
    createdAt?: number;
    descriptionPlain?: string;
  }>;

  const postings = Array.isArray(json) ? json : [];
  return postings
    .filter((j) => j.hostedUrl)
    .map((j) => ({
      source: companySlug,
      externalId: String(j.id ?? ''),
      company,
      role: j.text ?? '',
      location: j.categories?.location ?? '',
      ats: 'lever' as const,
      // hostedUrl is the posting page; the fillable form lives at /apply.
      applyUrl: j.hostedUrl!.replace(/\/+$/, '') + '/apply',
      postedAt: toIso(j.createdAt),
      description: j.descriptionPlain?.slice(0, MAX_DESCRIPTION_CHARS),
    }));
}
