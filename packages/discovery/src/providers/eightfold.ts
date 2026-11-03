import type { DiscoveredJob } from '../types.ts';

/**
 * Eightfold provider — the platform behind self-hosted boards like Microsoft's
 * (`apply.careers.microsoft.com`). Big employers on Eightfold never appear in
 * the third-party ATS feeds, so without this the fleet is structurally blind to
 * them however many Greenhouse/Lever slugs we add.
 *
 * Unlike every other provider here this one needs a BROWSER, not `fetch`:
 * Eightfold's public JSON API is locked (`/api/apply/v2/jobs` → 403 "Not
 * authorized for PCSX") and the results page is client-rendered, so a plain GET
 * returns an empty shell. We reuse the fleet's existing Patchright page, read
 * the rendered result cards, and never touch the private API.
 *
 * The DOM read is deliberately thin — it pulls raw `{id, title, cardText}` and
 * hands off to `normalizeEightfoldRow`, which is pure and unit-tested. Card
 * markup churns; relative-date and location parsing is where the bugs live, and
 * that part is covered offline.
 */

/** Minimal page contract — satisfied by a Patchright/Playwright Page. */
export interface PageLike {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
}

/**
 * One result card as scraped, before parsing. The three fields come from
 * separate elements in the card (`title` / `fieldValue` / `subData`) — the
 * card's combined textContent concatenates them with NO separator
 * ("…CoreAIUnited States, Washington, RedmondPosted 2 days ago"), so splitting
 * that string is unreliable and we read the elements individually instead.
 */
export interface EightfoldRow {
  id: string;
  title: string;
  location: string;
  /** e.g. "Posted 2 days ago". */
  posted: string;
}

export interface EightfoldOpts {
  /** Board host, e.g. `apply.careers.microsoft.com`. */
  host: string;
  company: string;
  /** Search terms, e.g. "software engineer intern". */
  query: string;
  /** Location filter as the board expects it. Default "United States". */
  location?: string;
  /** Milliseconds to let the SPA render its results. Default 9000. */
  settleMs?: number;
  now?: () => number;
}

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // 30d — good enough for freshness ordering
  year: 31_536_000_000,
};

/**
 * "21 hours ago" / "2 days ago" / "a month ago" → epoch ms, or null if the
 * phrasing isn't one we recognize (caller then omits the job rather than
 * inventing a date — a wrong postedAt corrupts freshness ordering).
 */
export function parseRelativeAge(text: string, now: number): number | null {
  const m = text.match(/(\d+|an?)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return null;
  const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
  const unit = UNIT_MS[m[2].toLowerCase()];
  if (!unit || !Number.isFinite(n)) return null;
  return now - n * unit;
}

/**
 * Turn one scraped card into a normalized job. Returns null when the card can't
 * be trusted (no id, no title, or an unparseable date) — dropping a row beats
 * emitting a fabricated one.
 */
export function normalizeEightfoldRow(
  row: EightfoldRow,
  opts: EightfoldOpts,
): DiscoveredJob | null {
  const id = (row.id || '').trim();
  const title = (row.title || '').replace(/\s+/g, ' ').trim();
  if (!id || !title) return null;

  const now = (opts.now ?? Date.now)();
  const postedMs = parseRelativeAge(row.posted || '', now);
  if (postedMs == null) return null;

  const location = (row.location || '').replace(/\s+/g, ' ').trim();

  return {
    source: opts.host,
    externalId: id,
    company: opts.company,
    role: title,
    location,
    ats: 'eightfold',
    applyUrl: `https://${opts.host}/careers/job/${id}`,
    postedAt: new Date(postedMs).toISOString(),
  };
}

/** Build the results URL. `/careers?query=…&location=…` is the form that
 *  actually returns hits; the `/careers/searchjobs/<q>` path applies extra
 *  default filters and comes back empty. */
export function eightfoldSearchUrl(opts: EightfoldOpts): string {
  const params = new URLSearchParams({
    query: opts.query,
    location: opts.location ?? 'United States',
    sort_by: 'relevance',
  });
  return `https://${opts.host}/careers?${params.toString()}`;
}

/** Scrape one page of results through an existing browser page. */
export async function fetchEightfold(
  page: PageLike,
  opts: EightfoldOpts,
): Promise<DiscoveredJob[]> {
  await page.goto(eightfoldSearchUrl(opts), { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Client-rendered results: no DOM to read until the SPA has fetched them.
  await page.waitForTimeout(opts.settleMs ?? 9000);

  const rows = await page.evaluate<EightfoldRow[]>(() => {
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
    const out: EightfoldRow[] = [];
    const seen = new Set<string>();
    // The job link IS the card on this platform (the anchor wraps title,
    // location and date), so read the three fields from their own elements.
    const anchors = [...document.querySelectorAll('a')].filter((a) =>
      /\/careers\/job\/\d+/.test((a as HTMLAnchorElement).href),
    );
    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).href;
      const id = (href.match(/\/careers\/job\/(\d+)/) || [])[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const pick = (sel: string) => clean(a.querySelector(sel)?.textContent);
      out.push({
        id,
        title: pick('[class*="title"]'),
        location: pick('[class*="fieldValue"]'),
        posted: pick('[class*="subData"]'),
      });
    }
    return out;
  });

  return rows
    .map((r) => normalizeEightfoldRow(r, opts))
    .filter((j): j is DiscoveredJob => j !== null);
}
