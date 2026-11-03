import type { DiscoveredJob } from '../types.ts';

/**
 * Rippling provider — reads the public ATS board API that powers
 * `ats.rippling.com/{slug}/jobs`.
 * GET `https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs`
 * → `[{ uuid, name, department:{label}, url, workLocation:{label} }]`.
 * `url` is already the canonical apply link. The feed repeats a job once per
 * work location (same uuid + url), so we collapse by uuid here; the aggregate
 * dedupe (by apply URL) would catch it too, but a direct caller shouldn't see
 * dupes. Rippling's board feed carries no posting date — undated jobs are kept
 * (see normalize.ts), not dropped.
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the slug. */
  company?: string;
}

export async function fetchRippling(
  slug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`rippling: HTTP ${res.status} for ${slug}`);
  const json = (await res.json()) as Array<{
    uuid?: string;
    name?: string;
    department?: { label?: string };
    url?: string;
    workLocation?: { label?: string };
  }>;

  const jobs = Array.isArray(json) ? json : [];
  const seen = new Set<string>();
  const out: DiscoveredJob[] = [];
  for (const j of jobs) {
    if (j.uuid == null) continue;
    if (seen.has(j.uuid)) continue;
    seen.add(j.uuid);
    out.push({
      source: slug,
      externalId: String(j.uuid),
      company: opts.company ?? slug,
      role: j.name ?? '',
      location: j.workLocation?.label ?? '',
      ats: 'rippling' as const,
      applyUrl: j.url ?? `https://ats.rippling.com/${slug}/jobs/${j.uuid}`,
      postedAt: '', // board feed carries no date → kept, not dropped
    });
  }
  return out;
}
