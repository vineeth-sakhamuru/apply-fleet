import type { DiscoveredJob, DiscoveryAts } from '../types.ts';

/**
 * Apify provider — heavy scraping breadth via the Apify Store, for sources with
 * no public JSON feed (LinkedIn) or that span many ATSes at once (career-site
 * aggregators). Unlike the native providers this is query-driven and runs a
 * paid Actor on Apify's infra, so it takes an injected `runActor` instead of a
 * `fetch`: the orchestrator binds `runActor` to the Apify MCP (call-actor →
 * get-dataset-items). A library can't call MCP tools itself.
 *
 * HARD RULE: LinkedIn is scraped ONLY through the Actor (Apify's infra/IP) —
 * never the user's own LinkedIn account or IP.
 *
 * GATING: both chosen Actors are PAY_PER_EVENT with no free tier (every result
 * bills the user's Apify account), so we never auto-run. Without a `runActor`,
 * `fetchApify` throws a clear gated error rather than silently returning [].
 */

/** The two Actors this provider is wired for (real Apify Store ids). */
export const APIFY_ACTORS = {
  /** LinkedIn Jobs Scraper — 120k users, $0.001/result, input: LinkedIn search URLs. */
  linkedin: 'curious_coder/linkedin-jobs-scraper',
  /** Career Site Job Listing API — 54 ATS platforms, $0.012/job, title/limit search. */
  'career-site': 'fantastic-jobs/career-site-job-listing-api',
} as const;

export type ApifyActor = keyof typeof APIFY_ACTORS;

/**
 * Runs an Actor and resolves its dataset items. Injected by the orchestrator,
 * which wires it to the Apify MCP. `actor` is the full Apify name; `input` is
 * the Actor input JSON.
 */
export type ApifyRunner = (actor: string, input: Record<string, unknown>) => Promise<unknown[]>;

export interface FetchOpts {
  /** Which Actor / input shape to use. Default `linkedin`. */
  actor?: ApifyActor;
  /** Bound to the Apify MCP by the orchestrator. Absent → the run is gated. */
  runActor?: ApifyRunner;
  /** Max results to request. */
  limit?: number;
  /** Optional location filter (LinkedIn Actor). */
  location?: string;
}

// NaN-safe ISO conversion; accepts ISO strings or epoch ms/seconds.
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  // Epoch seconds (10-digit) → ms.
  const v = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** ATS strings we have native fill maps for; a career-site `source` maps here. */
const KNOWN_ATS = new Set<DiscoveryAts>([
  'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee',
  'breezy', 'personio', 'bamboohr', 'workday', 'rippling', 'teamtailor',
  'icims', 'jobvite', 'jazzhr',
]);

function atsFromSource(source: unknown): DiscoveryAts {
  const s = String(source ?? '').toLowerCase();
  return (KNOWN_ATS as Set<string>).has(s) ? (s as DiscoveryAts) : 'linkedin';
}

/** curious_coder/linkedin-jobs-scraper item (documented output fields). */
interface LinkedInItem {
  id?: string;
  link?: string;
  title?: string;
  companyName?: string;
  location?: string;
  postedAt?: string;
  postedAtTimestamp?: number;
  applyUrl?: string;
}

/** fantastic-jobs/career-site-job-listing-api item (documented output fields). */
interface CareerSiteItem {
  id?: number | string;
  title?: string;
  organization?: string;
  url?: string;
  date_posted?: string;
  locations_derived?: string[];
  locations_alt?: string;
  source?: string;
  source_domain?: string;
}

/** Map one raw dataset item (either Actor shape) to a DiscoveredJob. */
function mapItem(raw: unknown): DiscoveredJob | null {
  const item = raw as LinkedInItem & CareerSiteItem;

  // Career-site shape: carries the real employer ATS in `source`.
  if (item.organization != null || item.date_posted != null || item.source_domain != null) {
    const applyUrl = item.url ?? '';
    if (!applyUrl) return null;
    return {
      source: item.source_domain ?? item.source ?? 'apify-career-site',
      externalId: String(item.id ?? applyUrl),
      company: item.organization ?? '',
      role: item.title ?? '',
      location: item.locations_derived?.[0] ?? item.locations_alt ?? '',
      ats: atsFromSource(item.source),
      applyUrl,
      postedAt: toIso(item.date_posted),
    };
  }

  // LinkedIn shape.
  const applyUrl = item.applyUrl ?? item.link ?? '';
  if (!applyUrl) return null;
  return {
    source: 'linkedin',
    externalId: String(item.id ?? applyUrl),
    company: item.companyName ?? '',
    role: item.title ?? '',
    location: item.location ?? '',
    ats: 'linkedin',
    applyUrl,
    postedAt: toIso(item.postedAt ?? item.postedAtTimestamp),
  };
}

/** Build the Actor input JSON for a given query. */
function buildInput(actor: ApifyActor, query: string, opts: FetchOpts): Record<string, unknown> {
  if (actor === 'career-site') {
    return { titleSearch: [query], limit: opts.limit ?? 50 };
  }
  // LinkedIn Actor takes LinkedIn search URLs — we build one from the query so
  // the scraping happens entirely on Apify's infra (never our account/IP).
  const params = new URLSearchParams({ keywords: query });
  if (opts.location) params.set('location', opts.location);
  return {
    urls: [`https://www.linkedin.com/jobs/search/?${params.toString()}`],
    count: opts.limit ?? 50,
  };
}

/**
 * Run a job-scraping Actor for `query` and map its dataset to DiscoveredJob[].
 * Throws if `runActor` is absent — the live run is gated (paid Actor, no free
 * tier); the orchestrator must opt in by wiring the Apify MCP to `runActor`.
 */
export async function fetchApify(
  query: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const actor = opts.actor ?? 'linkedin';
  if (!opts.runActor) {
    throw new Error(
      `apify: live run gated — ${APIFY_ACTORS[actor]} is a paid Actor with no free tier. ` +
        `Provide opts.runActor (bound to the Apify MCP) to enable.`,
    );
  }
  const items = await opts.runActor(APIFY_ACTORS[actor], buildInput(actor, query, opts));
  if (!Array.isArray(items)) {
    throw new Error(`apify: ${APIFY_ACTORS[actor]} returned a non-array dataset`);
  }
  return items.map(mapItem).filter((j): j is DiscoveredJob => j !== null);
}
