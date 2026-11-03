import type { ResumeSource, TailoredResume } from './types.ts';
import { tokens, SKILL_VOCAB } from './keywords.ts';

/** Content tokens of a string: the source's tokenizer, minus 1-char noise. */
function contentTokens(s: string): string[] {
  return tokens(s).filter((t) => t.length >= 2);
}

/**
 * Entity-level no-fabrication gate — the complement to `verify` (which is
 * per-bullet-id). Where `verify` checks a reworded bullet against ITS own source
 * bullet, `verifyTraceable` proves the WHOLE tailored résumé traces to the
 * source: every employer, role, degree/school, and skill it surfaces must be
 * evidenced SOMEWHERE in the source. It catches fabrications `verify` can't — an
 * invented company/degree, or a skill smuggled in via the skills list or a
 * different company's bullet than the one that (via id) evidences it.
 *
 * Traceability is token overlap against the pool of everything the source says:
 * a claim is untraceable if any of its key tokens appears in NO source field.
 * Returns human-readable violation strings. Fail-closed: any untraceable claim →
 * `ok: false`, so `buildTailoredResume` can refuse to attach a fabricated PDF.
 */
export function verifyTraceable(
  tailored: TailoredResume,
  source: ResumeSource,
): { ok: boolean; violations: string[] } {
  // The pool of everything the source legitimately evidences.
  const srcTokens = new Set<string>();
  const add = (s: string | undefined): void => {
    if (s) for (const t of contentTokens(s)) srcTokens.add(t);
  };
  for (const e of source.experience) {
    add(e.company);
    add(e.role);
    for (const b of e.bullets) {
      add(b.text);
      for (const tag of b.tags) add(tag);
    }
  }
  for (const ed of source.education) {
    add(ed.school);
    add(ed.degree);
    add(ed.detail);
  }
  for (const sk of source.skills) add(sk);

  // Per-entity pools give precise messages ("appear in ANY source" = union).
  const companyTokens = new Set(source.experience.flatMap((e) => contentTokens(e.company)));
  const roleTokens = new Set(source.experience.flatMap((e) => contentTokens(e.role)));
  const eduTokens = new Set(
    source.education.flatMap((ed) =>
      [ed.school, ed.degree, ed.detail ?? ''].flatMap(contentTokens),
    ),
  );

  const unbacked = (s: string, pool: Set<string>): string[] =>
    contentTokens(s).filter((t) => !pool.has(t));

  const violations: string[] = [];
  for (const e of tailored.experience) {
    const badCo = unbacked(e.company, companyTokens);
    if (badCo.length) violations.push(`invented employer "${e.company}" (unbacked: ${badCo.join(', ')})`);
    const badRole = unbacked(e.role, roleTokens);
    if (badRole.length) violations.push(`invented role "${e.role}" at ${e.company} (unbacked: ${badRole.join(', ')})`);
    // Bullet skills must be evidenced SOMEWHERE in the source, not just by the
    // same-id bullet (that's `verify`'s job) — a skill moved onto a role that
    // never did it is still a fabrication.
    for (const b of e.bullets) {
      const bad = [...new Set(tokens(b.text))].filter((t) => SKILL_VOCAB.has(t) && !srcTokens.has(t));
      if (bad.length) violations.push(`bullet ${b.id} introduces unbacked skill: ${bad.join(', ')}`);
    }
  }
  for (const ed of tailored.education) {
    const bad = unbacked(`${ed.school} ${ed.degree}`, eduTokens);
    if (bad.length) violations.push(`invented education "${ed.degree}, ${ed.school}" (unbacked: ${bad.join(', ')})`);
  }
  for (const sk of tailored.skills) {
    const bad = contentTokens(sk).filter((t) => !srcTokens.has(t));
    if (bad.length) violations.push(`unbacked skill "${sk}" (unbacked: ${bad.join(', ')})`);
  }

  return { ok: violations.length === 0, violations };
}
