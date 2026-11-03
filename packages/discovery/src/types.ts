import type { Ats } from '@apply-fleet/shared';

/**
 * The subset of {@link Ats} the discovery layer can produce jobs for. All but
 * `linkedin` have a native public-feed HTTP adapter (see `PROVIDERS`);
 * `linkedin` comes only from the query-driven Apify provider (`fetchApify`),
 * which is not part of the HTTP fan-out. Narrowed from the shared `Ats` union
 * so a `DiscoveredJob` can only ever carry a source we know how to handle.
 */
export type DiscoveryAts = Extract<
  Ats,
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'recruitee'
  | 'breezy'
  | 'personio'
  | 'bamboohr'
  | 'workday'
  | 'rippling'
  | 'teamtailor'
  | 'icims'
  | 'jobvite'
  | 'jazzhr'
  | 'eightfold'
  | 'linkedin'
>;

/**
 * One job posting as pulled from an ATS's public job-board feed, normalized to
 * a single shape across providers. This is the discovery layer's output; the
 * orchestrator turns these into `application.discovered` events.
 */
export interface DiscoveredJob {
  /** The board slug we queried, e.g. "stripe". Which feed this came from. */
  source: string;
  /** The ATS's own id for the posting, stringified. */
  externalId: string;
  /** Display name if one was passed, otherwise the slug. */
  company: string;
  /** Job title. */
  role: string;
  /** Free-text location as the feed reports it. */
  location: string;
  ats: DiscoveryAts;
  /** Canonical apply/posting URL. */
  applyUrl: string;
  /** ISO 8601. When the posting went live (or was last updated). */
  postedAt: string;
  /**
   * Plain-text job description, when the feed carries one.
   *
   * Greenhouse (`?content=true`), Ashby (`descriptionPlain`) and Lever
   * (`descriptionPlain`) all return this and we were discarding it — so résumé
   * tailoring ran against the string "Role — Company", matched ~no keywords,
   * and the per-JD rewording silently never fired. Truncated: keyword
   * extraction saturates long before the tail of a JD, and the whole thing
   * lands in an event row.
   */
  description?: string;
}

/** Keep event rows sane; keyword extraction saturates well before this. */
export const MAX_DESCRIPTION_CHARS = 12_000;

/**
 * Greenhouse returns entity-encoded HTML. Strip to text so keyword extraction
 * doesn't tokenize `<div>` and `&amp;`.
 * ponytail: regex, not a parser — this feeds a keyword bag, not a renderer.
 * Upgrade to a real HTML parser only if we ever display the description.
 */
export function htmlToText(html: string): string {
  const decode = (s: string): string =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_m, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k] ?? ' ';
    });

  // Decode BEFORE stripping. Greenhouse's `content` is entity-encoded HTML, so
  // stripping first leaves `&lt;p&gt;` untouched and the final decode turns it
  // back into a live `<p>` — tags then survive into the keyword bag.
  const strip = (s: string): string =>
    s
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');

  // Twice, bounded: parts of the Greenhouse payload are double-encoded, so one
  // pass turns `&amp;nbsp;` into a literal `&nbsp;` sitting in the text.
  // Bounded rather than looped-to-stable so a crafted payload can't spin here.
  return strip(decode(decode(html)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}
