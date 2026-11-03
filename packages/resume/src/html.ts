import type { TailoredResume } from './types.ts';

/**
 * HTML résumé renderer + Chromium print-to-PDF. This is the PDF path that needs
 * no system LaTeX: the fill engine already runs Chromium, so we render clean,
 * ATS-parseable HTML (real selectable text, not an image) and print it to a
 * genuine PDF. `renderLatex`/`compilePdf` remain for LaTeX-toolchain setups.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a tailored résumé to a single self-contained HTML document. */
export function renderHtml(r: TailoredResume): string {
  const contact = [
    esc(r.basics.email),
    r.basics.phone ? esc(r.basics.phone) : '',
    r.basics.location ? esc(r.basics.location) : '',
    ...(r.basics.links ?? []).map(esc),
  ]
    .filter(Boolean)
    .join(' &nbsp;|&nbsp; ');

  const experience = r.experience
    .map(
      (e) => `
    <div class="entry">
      <div class="row"><span class="strong">${esc(e.company)}</span><span>${esc(e.start)} – ${esc(e.end)}</span></div>
      <div class="row"><span class="italic">${esc(e.role)}</span></div>
      <ul>${e.bullets.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>
    </div>`,
    )
    .join('');

  const education = r.education
    .map(
      (ed) => `
    <div class="entry">
      <div class="row"><span class="strong">${esc(ed.school)}</span><span>${esc(ed.start)} – ${esc(ed.end)}</span></div>
      <div class="row"><span class="italic">${esc(ed.degree)}</span><span>${esc(ed.detail ?? '')}</span></div>
    </div>`,
    )
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 10.5pt; color: #111; margin: 0; line-height: 1.3; }
  h1 { font-size: 20pt; margin: 0 0 2px; text-align: center; letter-spacing: 0.5px; }
  .contact { text-align: center; font-size: 9.5pt; margin-bottom: 10px; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #111; margin: 12px 0 6px; padding-bottom: 2px; }
  .entry { margin-bottom: 8px; }
  .row { display: flex; justify-content: space-between; }
  .strong { font-weight: bold; }
  .italic { font-style: italic; }
  ul { margin: 3px 0 0; padding-left: 18px; }
  li { margin-bottom: 2px; }
  .skills { margin-top: 2px; }
  </style></head><body>
  <h1>${esc(r.basics.name)}</h1>
  <div class="contact">${contact}</div>
  <h2>Experience</h2>${experience}
  <h2>Education</h2>${education}
  <h2>Skills</h2>
  <div class="skills">${esc(r.skills.join(', '))}</div>
  </body></html>`;
}

/** Minimal Chromium page contract — satisfied by a Patchright/Playwright Page. */
export interface PageLike {
  setContent(html: string, opts?: { waitUntil?: string }): Promise<void>;
  pdf(opts: {
    path: string;
    format?: string;
    printBackground?: boolean;
    margin?: { top?: string; bottom?: string; left?: string; right?: string };
  }): Promise<unknown>;
}

/**
 * Print résumé HTML to a real PDF using a caller-supplied Chromium page.
 * The caller owns the browser lifecycle (the fill engine already has one).
 * Returns the output path.
 */
export async function htmlToPdf(page: PageLike, html: string, outPath: string): Promise<string> {
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({
    path: outPath,
    format: 'Letter',
    printBackground: true,
    margin: { top: '0.6in', bottom: '0.6in', left: '0.6in', right: '0.6in' },
  });
  return outPath;
}
