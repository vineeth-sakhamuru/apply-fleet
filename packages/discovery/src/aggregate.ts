import type { DiscoveredJob, DiscoveryAts } from './types.ts';
import { fetchGreenhouse } from './providers/greenhouse.ts';
import { fetchLever } from './providers/lever.ts';
import { fetchAshby } from './providers/ashby.ts';
import { fetchSmartRecruiters } from './providers/smartrecruiters.ts';
import { fetchWorkable } from './providers/workable.ts';
import { fetchRecruitee } from './providers/recruitee.ts';
import { fetchBreezy } from './providers/breezy.ts';
import { fetchPersonio } from './providers/personio.ts';
import { fetchBambooHr } from './providers/bamboohr.ts';
import { fetchWorkday } from './providers/workday.ts';
import { fetchRippling } from './providers/rippling.ts';
import { fetchTeamtailor } from './providers/teamtailor.ts';
import { fetchIcims } from './providers/icims.ts';
import { fetchJobvite } from './providers/jobvite.ts';
import { fetchJazzHr } from './providers/jazzhr.ts';
import { dedupe, filterFresh, sortNewestFirst } from './normalize.ts';

export interface DiscoveryTarget {
  ats: DiscoveryAts;
  slug: string;
  company?: string;
}

// `linkedin` is excluded: it has no HTTP feed and is served only by the
// query-driven Apify provider (`fetchApify`), which the orchestrator calls
// directly rather than through this per-company fan-out.
const PROVIDERS: Record<
  Exclude<DiscoveryAts, 'linkedin'>,
  (slug: string, opts: { fetchImpl?: typeof fetch; company?: string }) => Promise<DiscoveredJob[]>
> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
  recruitee: fetchRecruitee,
  breezy: fetchBreezy,
  personio: fetchPersonio,
  bamboohr: fetchBambooHr,
  workday: fetchWorkday,
  rippling: fetchRippling,
  teamtailor: fetchTeamtailor,
  icims: fetchIcims,
  jobvite: fetchJobvite,
  jazzhr: fetchJazzHr,
};

export interface DiscoverOpts {
  fetchImpl?: typeof fetch;
  maxAgeHours?: number;
  now?: number;
  /** Per-target failures are isolated so one dead board can't sink a cycle. */
  onError?: (target: DiscoveryTarget, err: unknown) => void;
  /**
   * How often {@link pollDiscovery} refetches, in ms. Default is a polite ~2h
   * ATS cadence; drop it to minutes for a "within minutes of posting" watch.
   */
  pollIntervalMs?: number;
  /**
   * Max in-flight feed requests. Unbounded fan-out silently loses boards: at
   * ~127 targets at once, every Workday tenant dropped out (they rate-limit /
   * reset under burst) while smaller feeds survived — a coverage hole that
   * looks like "that ATS doesn't work" rather than "we hammered it". Default 8
   * is polite and kept every board alive in testing.
   */
  concurrency?: number;
}

/** Run `work` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Fan out across all targets with bounded concurrency, isolate per-target
 * failures, then dedupe by apply URL, drop anything older than the freshness
 * window, and return newest-first.
 */
export async function discoverAll(
  targets: DiscoveryTarget[],
  opts: DiscoverOpts = {},
): Promise<DiscoveredJob[]> {
  const results = await mapLimit(targets, opts.concurrency ?? 8, async (t) => {
    try {
      const provider = (PROVIDERS as Record<string, (typeof PROVIDERS)[keyof typeof PROVIDERS]>)[t.ats];
      if (!provider) {
        throw new Error(`discovery: no HTTP provider for "${t.ats}" (use fetchApify directly)`);
      }
      return await provider(t.slug, {
        fetchImpl: opts.fetchImpl,
        company: t.company,
      });
    } catch (err) {
      opts.onError?.(t, err);
      return [] as DiscoveredJob[];
    }
  });
  const fresh = filterFresh(dedupe(results.flat()), opts.maxAgeHours ?? 24, opts.now);
  return sortNewestFirst(fresh);
}

/** Default poll cadence: ~2h, the polite ATS-feed rate from the plan. */
export const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 60 * 1000;

export interface PollHandle {
  /** Stop the loop. Idempotent. */
  stop: () => void;
}

/**
 * Poll `discoverAll` on a cadence and hand each cycle's jobs to `onResults`.
 * Runs one cycle immediately, then every `pollIntervalMs` (default ~2h; set it
 * to minutes for near-real-time). YAGNI: a bare `setInterval`, no scheduler —
 * the timer is `unref`'d so it never blocks process exit. Cycle errors go to
 * `onError` so a failing cycle is never silent.
 */
export function pollDiscovery(
  targets: DiscoveryTarget[],
  onResults: (jobs: DiscoveredJob[]) => void,
  opts: DiscoverOpts = {},
): PollHandle {
  let stopped = false;
  const cycle = async (): Promise<void> => {
    try {
      const jobs = await discoverAll(targets, opts);
      if (!stopped) onResults(jobs);
    } catch (err) {
      // discoverAll isolates per-target errors, so this is a defensive net for
      // an unexpected whole-cycle failure. Surface it — never swallow.
      console.error('pollDiscovery: cycle failed', err);
    }
  };
  void cycle();
  const timer = setInterval(() => void cycle(), opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
