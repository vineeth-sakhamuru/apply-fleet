import type { DiscoveredJob } from '@apply-fleet/discovery';
import { isEligible } from './eligibility.ts';
import { relevanceScore } from './rank.ts';

/**
 * Final 0..100 match score for a job. Ineligible jobs are 0. Eligible jobs get
 * a deterministic base = an eligibility floor plus a lexical-relevance bump.
 * An optional `llmScore` hook can refine an eligible job's score: when it
 * returns a number it is blended in; when it returns null (i.e. no model is
 * configured) the deterministic base stands.
 */

/** Points an eligible job earns just for clearing the gate. */
const ELIGIBLE_FLOOR = 50;
/** Points an eligible job earns for a perfect lexical match, on top of floor. */
const LEXICAL_WEIGHT = 50;
/** How much a provided LLM score pulls the final away from the base (0..1). */
const LLM_BLEND = 0.5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export interface ScoreOptions {
  /**
   * Optional model-backed scorer returning 0..100, or null when unconfigured.
   * Kept as an injected dependency so scoring stays pure and testable.
   */
  llmScore?: (job: DiscoveredJob) => Promise<number | null>;
}

export async function scoreMatch(
  job: DiscoveredJob,
  opts?: ScoreOptions,
): Promise<number> {
  if (!isEligible(job).eligible) return 0;

  const lexical = relevanceScore(job.role); // 0..1
  const base = ELIGIBLE_FLOOR + LEXICAL_WEIGHT * lexical; // 50..100

  const llmScore = opts?.llmScore;
  if (llmScore) {
    const llm = await llmScore(job);
    if (typeof llm === 'number' && Number.isFinite(llm)) {
      const blended = base * (1 - LLM_BLEND) + clamp(llm, 0, 100) * LLM_BLEND;
      return clamp(Math.round(blended), 0, 100);
    }
  }

  return clamp(Math.round(base), 0, 100);
}
