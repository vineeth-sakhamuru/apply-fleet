import type { DiscoveredJob } from '@apply-fleet/discovery';

/**
 * Cheap, deterministic relevance ranking over job titles. This is the "pre-rank"
 * stage: a lexical pass that orders jobs before any expensive embeddings/LLM
 * scoring runs. Pure, offline, no models.
 */

/** Target title vocabulary, weighted by phrase length when scored. */
export const DEFAULT_KEYWORDS: string[] = [
  'software engineer',
  'swe',
  'sde',
  'backend',
  'back end',
  'full stack',
  'platform',
  'infrastructure',
  'distributed systems',
  'python',
  'api',
];

/** Space-pad + strip to alphanumeric words so `includes(' term ')` is exact. */
function normalize(text: string): string {
  const inner = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${inner} `;
}

/** A keyword's weight is its word count — multi-word phrases are more specific. */
function keywordWeight(keyword: string): number {
  const inner = normalize(keyword).trim();
  return inner.length === 0 ? 0 : inner.split(' ').length;
}

/**
 * Weighted keyword overlap of a title, normalized to 0..1: the summed weight of
 * matched keywords over the summed weight of all keywords. A title matching
 * every keyword scores 1; matching none scores 0.
 */
export function relevanceScore(
  role: string,
  keywords: string[] = DEFAULT_KEYWORDS,
): number {
  const text = normalize(role);
  let matched = 0;
  let total = 0;
  for (const keyword of keywords) {
    const weight = keywordWeight(keyword);
    total += weight;
    const term = normalize(keyword).trim();
    if (term.length > 0 && text.includes(` ${term} `)) matched += weight;
  }
  return total === 0 ? 0 : matched / total;
}

/**
 * Rank jobs by lexical relevance, highest first. Stable: jobs with equal scores
 * keep their input order. Returns a new array; does not mutate the input.
 */
export function rankByRelevance(
  jobs: DiscoveredJob[],
  keywords: string[] = DEFAULT_KEYWORDS,
): Array<{ job: DiscoveredJob; score: number }> {
  return jobs
    .map((job, index) => ({ job, score: relevanceScore(job.role, keywords), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ job, score }) => ({ job, score }));
}

/**
 * A swappable pre-ranking strategy. The lexical implementation below is the
 * default; an embeddings-based ranker can implement the same shape later and
 * drop in without changing callers.
 */
export interface PreRanker {
  rank(
    jobs: DiscoveredJob[],
  ): Promise<Array<{ job: DiscoveredJob; score: number }>>;
}

/** The default {@link PreRanker}: lexical overlap against {@link DEFAULT_KEYWORDS}. */
export const lexicalPreRanker: PreRanker = {
  async rank(jobs) {
    return rankByRelevance(jobs);
  },
};
