import type { DiscoveredJob } from './types.ts';

/**
 * Post-fetch shaping of discovered jobs: dedupe across boards, drop stale
 * postings, and order newest-first. All pure and side-effect free.
 */

/**
 * Canonical key for an apply URL: lowercase host, no query string, no hash,
 * no trailing slash. Two URLs that differ only by those collapse to one key.
 * Falls back to a trimmed/lowercased string for anything unparseable.
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Collapse jobs whose apply URLs are the same after normalization. First wins. */
export function dedupe(jobs: DiscoveredJob[]): DiscoveredJob[] {
  const seen = new Set<string>();
  const out: DiscoveredJob[] = [];
  for (const job of jobs) {
    const key = normalizeUrl(job.applyUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(job);
  }
  return out;
}

/**
 * Keep jobs posted within the last `maxAgeHours`. A job whose `postedAt` is
 * unparseable/absent is KEPT, not dropped: some ATS list feeds (Personio,
 * BambooHR, Workday) carry no posting date, and silently dropping every
 * undated job would erase those whole sources. We can't prove such a job is
 * stale, so we keep it and let dedupe (by id/apply-url) handle repeats.
 * ponytail: precise freshness for those sources needs an N+1 per-job detail
 * fetch — deferred; keeping undated jobs is the no-silent-fail floor.
 */
export function filterFresh(
  jobs: DiscoveredJob[],
  maxAgeHours = 24,
  now: number = Date.now(),
): DiscoveredJob[] {
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  return jobs.filter((job) => {
    const posted = Date.parse(job.postedAt);
    if (Number.isNaN(posted)) return true; // no usable date → keep, don't drop
    return now - posted <= maxAgeMs;
  });
}

/**
 * Newest posting first. Undated jobs sort last (treated as oldest) so real,
 * dated-fresh postings lead. Returns a new array; does not mutate the input.
 */
export function sortNewestFirst(jobs: DiscoveredJob[]): DiscoveredJob[] {
  const ts = (s: string): number => {
    const n = Date.parse(s);
    return Number.isNaN(n) ? -Infinity : n;
  };
  return [...jobs].sort((a, b) => ts(b.postedAt) - ts(a.postedAt));
}
