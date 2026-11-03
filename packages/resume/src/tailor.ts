import type { Bullet, ResumeSource, TailoredResume } from './types.ts';
import { extractKeywords, tokens } from './keywords.ts';

export interface TailorOpts {
  maxBulletsPerRole?: number;
  /**
   * Optional strong-model rephraser (Claude). Given a source bullet and the JD
   * keywords it matched, returns a rewrite — or null to keep the original.
   * The rewrite is still run through the verifier: it may only rephrase what
   * the source bullet already evidences, never introduce new claims.
   */
  rephrase?: (bullet: Bullet, matched: string[]) => Promise<string | null>;
}

/**
 * Tailor a résumé to a JD. This layer only ever SELECTS, REORDERS, and
 * (optionally, via `rephrase`) rewords the source's own bullets to surface
 * JD-relevant experience. It never invents an employer, role, or claim — new
 * content cannot originate here. `verify()` enforces that programmatically.
 */
export async function tailor(
  source: ResumeSource,
  jdText: string,
  opts: TailorOpts = {},
): Promise<TailoredResume> {
  const keywords = extractKeywords(jdText);
  const kw = new Set(keywords);
  const max = opts.maxBulletsPerRole ?? 4;

  const experience = [];
  for (const entry of source.experience) {
    const scored = entry.bullets
      .map((b) => {
        const terms = new Set([...b.tags.map((t) => t.toLowerCase()), ...tokens(b.text)]);
        const matched = [...terms].filter((t) => kw.has(t));
        return { b, matched, score: matched.length };
      })
      .sort((a, b) => b.score - a.score);

    const bullets = [];
    for (const { b, matched } of scored.slice(0, max)) {
      let text = b.text;
      if (opts.rephrase) {
        const r = await opts.rephrase(b, matched);
        if (r) text = r;
      }
      bullets.push({ id: b.id, text, matched });
    }
    experience.push({ ...entry, bullets });
  }

  // Surface skills that overlap the JD first (stable within each group).
  const skills = [...source.skills].sort(
    (a, b) => (kw.has(b.toLowerCase()) ? 1 : 0) - (kw.has(a.toLowerCase()) ? 1 : 0),
  );

  return {
    basics: source.basics,
    experience,
    education: source.education,
    skills,
    keywords: keywords.slice(0, 30),
  };
}
