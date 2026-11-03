import type { DiscoveredJob } from '../types.ts';

/**
 * Teamtailor provider — reads the public JSON Feed (jsonfeed.org 1.1) that
 * every `{slug}.teamtailor.com` career site exposes at `/jobs.json`.
 * → `{ items: [{ id, title, url, date_published, _jobposting }] }` where
 * `_jobposting` is a schema.org JobPosting carrying `jobLocation` +
 * `hiringOrganization`. `url` is the canonical posting/apply page.
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the feed org / slug. */
  company?: string;
}

// NaN-safe ISO conversion.
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

interface PostalAddress {
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string;
}

/** Flatten a schema.org jobLocation[] into a free-text location. */
function locationOf(jobLocation: unknown): string {
  const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  const addr = (first as { address?: PostalAddress } | undefined)?.address;
  if (!addr) return '';
  return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
    .filter(Boolean)
    .join(', ');
}

export async function fetchTeamtailor(
  slug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://${slug}.teamtailor.com/jobs.json`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`teamtailor: HTTP ${res.status} for ${slug}`);
  const json = (await res.json()) as {
    items?: Array<{
      id?: string;
      title?: string;
      url?: string;
      date_published?: string;
      _jobposting?: {
        jobLocation?: unknown;
        hiringOrganization?: { name?: string };
      };
    }>;
  };

  const items = Array.isArray(json.items) ? json.items : [];
  return items
    .filter((j) => j.url)
    .map((j) => ({
      source: slug,
      externalId: String(j.id ?? ''),
      company: opts.company ?? j._jobposting?.hiringOrganization?.name ?? slug,
      role: j.title ?? '',
      location: locationOf(j._jobposting?.jobLocation),
      ats: 'teamtailor' as const,
      applyUrl: j.url ?? '',
      postedAt: toIso(j.date_published),
    }));
}
