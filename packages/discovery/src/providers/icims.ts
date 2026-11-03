import type { DiscoveredJob } from '../types.ts';

/**
 * iCIMS provider — iCIMS exposes no public JSON, only the HTML career portal
 * at `careers-{slug}.icims.com`. We fetch the search results as an iframe
 * fragment (`?in_iframe=1`), which returns a compact list of
 * `<li class="iCIMS_JobCardItem">` cards, and parse those. Each card carries a
 * `/jobs/{id}/…/job` link, an `<h3>` title, and an accessible posted date
 * `(M/D/YYYY h:mm AM/PM)`. Location isn't in the card, so it's left blank.
 *
 * ponytail: regex over the card markup rather than a DOM parse — no HTML parser
 * in this stack and only three fields are needed. Upgrade path if the portal
 * layout drifts: a real DOM parse (linkedom/cheerio) or iCIMS' partner API.
 * Note: some tenants sit at a `careersN-` prefix (e.g. `careers3-powerschool`);
 * pass that whole label as the slug to reach them.
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the slug. */
  company?: string;
}

// NaN-safe ISO conversion.
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Decode the handful of HTML entities iCIMS titles actually use. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Collapse tags + whitespace out of a fragment of HTML. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export async function fetchIcims(
  slug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `https://careers-${slug}.icims.com`;
  const url = `${base}/jobs/search?ss=1&searchKeyword=&in_iframe=1`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`icims: HTTP ${res.status} for ${slug}`);
  const html = await res.text();

  const cards = html.match(/<li class="iCIMS_JobCardItem">[\s\S]*?<\/li>/g) ?? [];
  const out: DiscoveredJob[] = [];
  for (const card of cards) {
    const href = card.match(/href="([^"]*\/jobs\/\d+\/[^"]*)"/);
    if (!href) continue;
    const applyUrl = href[1].split('?')[0];
    const idMatch = applyUrl.match(/\/jobs\/(\d+)\//);
    const title = card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    // The accessible "(M/D/YYYY h:mm AM/PM)" mirror of the posted date.
    const date = card.match(/<span class="sr-only">\(([^)]+)\)<\/span>/);
    out.push({
      source: slug,
      externalId: idMatch ? idMatch[1] : applyUrl,
      company: opts.company ?? slug,
      role: title ? textOf(title[1]) : '',
      location: '',
      ats: 'icims' as const,
      applyUrl,
      postedAt: date ? toIso(date[1]) : '',
    });
  }
  return out;
}
