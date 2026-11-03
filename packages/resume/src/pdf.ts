import { readFileSync } from 'node:fs';
// pdfjs-dist ships built ESM; the legacy build runs in Node with no worker and
// no canvas (getTextContent doesn't render). This is the same parser an ATS
// uses to read a résumé — if it reads back here, an ATS can read it too.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Collapse whitespace so extracted text matches regardless of PDF spacing. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Pull the full text layer out of a PDF. Returns '' on any parse failure —
 *  an image-only or corrupt PDF yields no text, which the caller treats as
 *  unreadable (fail-closed), never as a crash. */
async function extractText(path: string): Promise<string> {
  const data = new Uint8Array(readFileSync(path));
  const doc = await getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(content.items.map((i) => ('str' in i ? i.str : '')).join(' '));
    }
    return pages.join('\n');
  } finally {
    await doc.destroy();
  }
}

/**
 * ATS-readability gate. Chromium print embeds a real, selectable text layer, so
 * re-extracting it and finding the candidate's name plus a known keyword proves
 * the PDF is machine-parseable (a real text résumé, not a scanned image). Used
 * fail-closed before attach: an image-only, corrupt, or empty PDF returns
 * `ok: false` so a résumé an ATS couldn't read never gets submitted.
 *
 * `expect.keywords` must be terms KNOWN to be in the résumé (skills, matched
 * bullet keywords) — they prove body text (not just the header) reads back. Not
 * a relevance check: pass terms you rendered, not raw JD keywords.
 */
export async function assertPdfReadable(
  path: string,
  expect: { name: string; keywords: string[] },
): Promise<{ ok: boolean; text: string }> {
  let text = '';
  try {
    text = await extractText(path);
  } catch {
    return { ok: false, text: '' };
  }
  const hay = norm(text).toLowerCase();
  const nameOk = hay.includes(norm(expect.name).toLowerCase());
  const kwOk = expect.keywords.some((k) => k && hay.includes(k.toLowerCase()));
  return { ok: nameOk && kwOk, text };
}
