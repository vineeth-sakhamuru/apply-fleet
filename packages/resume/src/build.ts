import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResumeSource } from './types.ts';
import type { TailorOpts } from './tailor.ts';
import { tailor } from './tailor.ts';
import { verify } from './verify.ts';
import { verifyTraceable } from './traceable.ts';
import { assertPdfReadable } from './pdf.ts';
import { renderLatex, compilePdf } from './latex.ts';
import { renderHtml, htmlToPdf, type PageLike } from './html.ts';

export interface BuildOpts {
  /** Where to write the artifact. Defaults to the OS temp dir. */
  outDir?: string;
  /**
   * A Chromium page (Patchright/Playwright). When supplied, the résumé is
   * printed to a real PDF via the browser — no system LaTeX needed. This is
   * the production path (the fill engine already has a browser). Omitted →
   * fall back to the LaTeX toolchain, else emit the .tex.
   */
  page?: PageLike;
  /** Reword bullets via `rephrase` (still gated by verify). Off → select/reorder only. */
  reword?: boolean;
  /**
   * Strong-model rephraser (e.g. Claude), applied only when `reword` is set.
   * Omitted → no rewording, so the output is verbatim source bullets. The
   * worker injects its rephraser here; leaving it out keeps builds deterministic.
   */
  rephrase?: TailorOpts['rephrase'];
  maxBulletsPerRole?: number;
}

export interface BuildResult {
  path: string;
  format: 'pdf' | 'tex';
  usedBulletIds: string[];
}

/**
 * The filename a recruiter sees in the ATS before they open anything.
 *
 * It used to be `resume-1785961311376-3t1k1m.pdf` — an epoch timestamp and six
 * random characters, attached to a real application. Now it's the candidate's
 * name and the role. `jobText` is the JD, whose first line is "Role — Company",
 * so only that line is used; the rest is prose.
 *
 * Collision safety: two builds for the same role in the same millisecond would
 * clash, so a short suffix stays — at the END, where it reads as a version
 * rather than as the whole name.
 */
export function resumeFileBase(name: string, jobText: string): string {
  const slug = (s: string, max: number): string =>
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, max)
      .replace(/^-|-$/g, '');
  const who = slug(name, 40) || 'Resume';
  // First line only, and drop the company half of "Role — Company".
  const role = slug((jobText.split('\n')[0] ?? '').split(/[—–|]/)[0] ?? '', 48);
  const stamp = Date.now().toString(36).slice(-4);
  return [who, 'Resume', role, stamp].filter(Boolean).join('-');
}

/**
 * The one entry point that ties the résumé pipeline together: extract JD
 * keywords, select/reorder (and optionally reword) the source's own bullets,
 * run the no-fabrication gate, then render — compiling to PDF when the LaTeX
 * toolchain is present, else emitting the .tex. Never invents content; a
 * verify failure throws with the offending bullet id and reason rather than
 * silently dropping the bullet.
 */
export async function buildTailoredResume(
  source: ResumeSource,
  jobText: string,
  opts: BuildOpts = {},
): Promise<BuildResult> {
  // 1 + 2. keywords + select/reorder happen inside tailor; reword only if asked.
  const tailored = await tailor(source, jobText, {
    maxBulletsPerRole: opts.maxBulletsPerRole,
    rephrase: opts.reword ? opts.rephrase : undefined,
  });

  // 3. No-fabrication gate — reject loudly, don't drop. `verify` is per-bullet
  //    (a reword can't add a claim its own source bullet lacks); `verifyTraceable`
  //    is whole-résumé (no invented employer/role/degree/skill anywhere). Both
  //    throw so a fabricated build never returns a path — the caller catches,
  //    leaves resumePath unset, and prepareApplication routes attach to HITL.
  const { ok, violations } = verify(tailored, source);
  if (!ok) {
    const detail = violations.map((v) => `${v.bulletId}: ${v.reason}`).join('; ');
    throw new Error(`resume failed no-fabrication check: ${detail}`);
  }
  const trace = verifyTraceable(tailored, source);
  if (!trace.ok) {
    throw new Error(`resume failed traceability check: ${trace.violations.join('; ')}`);
  }

  const usedBulletIds = tailored.experience.flatMap((e) => e.bullets.map((b) => b.id));

  const outDir = opts.outDir ?? tmpdir();
  mkdirSync(outDir, { recursive: true });
  const outBase = join(outDir, resumeFileBase(tailored.basics.name, jobText));

  // 4a. Production path: print a real PDF via the browser (no LaTeX needed).
  if (opts.page) {
    const pdfPath = `${outBase}.pdf`;
    await htmlToPdf(opts.page, renderHtml(tailored), pdfPath);
    // ATS-readability gate: the printed PDF must read back the name + a rendered
    // keyword, proving it's a parseable text résumé (not an image). Keywords are
    // ones we know we rendered (matched bullet keywords + skills), so this proves
    // readability, not relevance. Fail → throw → attach routes to HITL.
    const keywords = [
      ...new Set([
        ...tailored.experience.flatMap((e) => e.bullets.flatMap((b) => b.matched)),
        ...tailored.skills,
      ]),
    ];
    const readable = await assertPdfReadable(pdfPath, { name: tailored.basics.name, keywords });
    if (!readable.ok) {
      throw new Error(
        `resume PDF failed ATS-readability check: name/keyword did not read back from ${pdfPath}`,
      );
    }
    return { path: pdfPath, format: 'pdf', usedBulletIds };
  }

  // 4b. Fallback: render Jake's LaTeX; compile when pdflatex exists, else .tex.
  const tex = renderLatex(tailored);
  const out = compilePdf(tex, outBase);
  return out.compiled && out.pdf
    ? { path: out.pdf, format: 'pdf', usedBulletIds }
    : { path: out.tex, format: 'tex', usedBulletIds };
}
