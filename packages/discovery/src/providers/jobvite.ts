import type { DiscoveredJob } from '../types.ts';

/**
 * Jobvite provider — the `jobs.jobvite.com/{name}` career sites are
 * server-rendered and expose no JSON, but every Jobvite tenant has a public
 * XML syndication feed keyed by its company id:
 * GET `https://app.jobvite.com/CompanyJobs/xml.aspx?c={companyId}`
 * → `<result><job><id/><title/><location/><date/><apply-url/>…</job>…`.
 * The `slug` here is the Jobvite company id (e.g. `quYbVfwi`), the `c=` value —
 * it's visible in the career site's analytics payload.
 *
 * ponytail: regex over the XML rather than a DOM/XML parse — no XML parser in
 * this stack and only five fields are needed. Upgrade path if the feed shape
 * drifts: a real XML parser (fast-xml-parser).
 */

export interface FetchOpts {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Display name to record as `company`; defaults to the company id. */
  company?: string;
}

// NaN-safe ISO conversion.
function toIso(value: string | number | null | undefined): string {
  if (value == null) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Decode the few XML entities Jobvite fields use; unwrap CDATA. */
function decode(s: string): string {
  return s
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

/** Pull the inner text of the first `<tag>…</tag>` in an XML fragment. */
function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}

export async function fetchJobvite(
  slug: string,
  opts: FetchOpts = {},
): Promise<DiscoveredJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://app.jobvite.com/CompanyJobs/xml.aspx?c=${slug}`;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`jobvite: HTTP ${res.status} for ${slug}`);
  const xml = await res.text();

  const jobs = xml.match(/<job>[\s\S]*?<\/job>/g) ?? [];
  return jobs
    .map((j) => {
      const id = tag(j, 'id');
      const apply = tag(j, 'apply-url').replace(/^http:/, 'https:');
      return {
        source: slug,
        externalId: id,
        company: opts.company ?? slug,
        role: tag(j, 'title'),
        location: tag(j, 'location'),
        ats: 'jobvite' as const,
        applyUrl: apply || `https://jobs.jobvite.com/careers/job/${id}`,
        postedAt: toIso(tag(j, 'date')),
      };
    })
    .filter((j) => j.externalId);
}
