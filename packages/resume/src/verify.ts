import type { Bullet, ResumeSource, TailoredResume, Violation } from './types.ts';
import { tokens, SKILL_VOCAB } from './keywords.ts';

/**
 * The no-fabrication gate. A tailored résumé is valid only if:
 *   1. every tailored bullet traces to a source bullet (same id), and
 *   2. no bullet introduces a skill/tech term the source bullet didn't
 *      already evidence (via its text or tags).
 * Anything else is a fabrication and must not reach a real application.
 */
export function verify(
  tailored: TailoredResume,
  source: ResumeSource,
): { ok: boolean; violations: Violation[] } {
  const byId = new Map<string, Bullet>();
  for (const e of source.experience) for (const b of e.bullets) byId.set(b.id, b);

  const violations: Violation[] = [];
  for (const e of tailored.experience) {
    for (const tb of e.bullets) {
      const src = byId.get(tb.id);
      if (!src) {
        violations.push({ entry: e.company, bulletId: tb.id, reason: 'bullet id not in source' });
        continue;
      }
      const backed = new Set([...src.tags.map((t) => t.toLowerCase()), ...tokens(src.text)]);
      const introduced = [...new Set(tokens(tb.text))].filter(
        (t) => SKILL_VOCAB.has(t) && !backed.has(t),
      );
      if (introduced.length) {
        violations.push({
          entry: e.company,
          bulletId: tb.id,
          reason: `introduces unbacked terms: ${introduced.join(', ')}`,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
