import type { Page } from 'patchright';

/**
 * Finding the real submit control.
 *
 * A per-ATS CSS selector is not enough, and trusting one is actively dangerous:
 *  - Ashby renders EVERY control as `<button type="submit">` — "Upload file",
 *    each Yes/No option — so `button[type="submit"]` resolves to "Upload file".
 *  - Lever's real submit is `#btn-submit` with `type="button"`, so the same
 *    selector misses it entirely and instead matches the cookie banner's
 *    "Accept"/"Deny".
 * Both were live on real forms while those applications were marked 'ready'.
 *
 * So we enumerate the visible controls and choose by INTENT, with an explicit
 * deny-list for the destructive/wrong lookalikes. The scoring is a pure
 * function so the dangerous cases are unit-tested offline rather than
 * discovered by clicking something irreversible.
 */

export interface SubmitCandidate {
  text: string;
  cls: string;
  id: string;
  type: string;
  disabled: boolean;
}

/**
 * Controls that must NEVER be mistaken for submit. Clicking any of these is
 * either destructive, consent-granting, or silently derails the application.
 */
const DENY =
  /upload|attach|choose file|replace|remove|delete|clear|cancel|back|previous|save (as )?draft|accept|deny|agree|cookie|consent|sign in|log ?in|register|create account|apply with|linkedin|indeed|autofill|parse/i;

/** Strong positive signals, best first. */
const EXACT = /^(submit application|submit|send application|apply now|submit my application)$/i;
const CONTAINS = /\bsubmit\b|\bapply\b/i;

/**
 * Score one candidate. Higher is better; `null` means never click it.
 * Exported for tests — the deny-list behaviour is the safety-critical part.
 */
export function scoreSubmitCandidate(c: SubmitCandidate): number | null {
  const text = (c.text || '').replace(/\s+/g, ' ').trim();
  const hay = `${text} ${c.id} ${c.cls}`;
  if (c.disabled) return null;
  // Deny-list wins over everything, including a "submit" type: Ashby's
  // "Upload file" is a type=submit button whose class also says button.
  if (DENY.test(text)) return null;

  let score = 0;
  if (EXACT.test(text)) score += 100;
  else if (CONTAINS.test(text)) score += 50;
  // An id/class naming submit is good corroboration (Lever's #btn-submit).
  if (/submit/i.test(c.id)) score += 40;
  if (/submit/i.test(c.cls)) score += 20;
  // Ashby marks the real action button `_primary_`; option buttons are not.
  if (/primary|_cta\b/i.test(c.cls)) score += 10;
  if (c.type === 'submit') score += 5;

  // Require at least one real submit signal — never fall back to "first
  // button", which is how "Upload file" got clicked.
  return score >= 50 ? score : null;
}

/** Choose the best candidate index, or null when none is trustworthy. */
export function pickSubmit(cands: SubmitCandidate[]): number | null {
  let bestIdx: number | null = null;
  let best = -1;
  cands.forEach((c, i) => {
    const s = scoreSubmitCandidate(c);
    if (s != null && s > best) {
      best = s;
      bestIdx = i;
    }
  });
  return bestIdx;
}

/** Enumerate visible clickable controls on the page. */
export async function submitCandidates(page: Page): Promise<SubmitCandidate[]> {
  return await page.evaluate(() => {
    const els = [
      ...document.querySelectorAll('button, input[type="submit"], [role="button"], a[class*="submit"]'),
    ] as any[];
    return els
      .filter((e) => e.offsetParent !== null || e.getClientRects().length > 0)
      .map((e) => ({
        text: (e.textContent || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        cls: (e.className || '').toString().slice(0, 120),
        id: e.id || '',
        type: e.type || '',
        disabled: !!e.disabled,
      }));
  });
}

/**
 * Locate the real submit control and return its index among the visible
 * controls, or null if the page has none we'd trust. Callers treat null as
 * "not submittable" — an application that can't be submitted is not 'ready'.
 */
export async function findSubmit(page: Page): Promise<{ index: number; label: string } | null> {
  const cands = await submitCandidates(page);
  const idx = pickSubmit(cands);
  if (idx == null) return null;
  return { index: idx, label: cands[idx].text };
}

/**
 * Click the control `findSubmit` chose, by the same enumeration order.
 *
 * A REAL browser click, not `el.click()` from `page.evaluate`.
 *
 * `page.evaluate` runs in Patchright's isolated world, so `el.click()` dispatches
 * an untrusted synthetic event. On a live Ramp form that did nothing at all: the
 * post-click screenshot showed the form still filled, no navigation, no
 * validation errors — the handler simply never ran. Driving the mouse through
 * the browser produces a trusted event, which is what the page actually reacts
 * to. Same reason the typeahead needed a real click to open its menu.
 *
 * The element is tagged first so the mouse targets exactly the control we
 * scored, not whatever else may sit at those coordinates.
 */
export async function clickSubmit(page: Page, index: number): Promise<boolean> {
  const tagged = await page.evaluate((i: number) => {
    const els = [
      ...document.querySelectorAll('button, input[type="submit"], [role="button"], a[class*="submit"]'),
    ] as any[];
    const visible = els.filter((e) => e.offsetParent !== null || e.getClientRects().length > 0);
    const el = visible[i];
    if (!el) return false;
    for (const prev of document.querySelectorAll('[data-af-submit]')) prev.removeAttribute('data-af-submit');
    el.setAttribute('data-af-submit', '1');
    el.scrollIntoView({ block: 'center' });
    return true;
  }, index);
  if (!tagged) return false;

  try {
    await page.click('[data-af-submit="1"]', { timeout: 8000 });
    return true;
  } catch {
    // Something overlays the button (a cookie bar, a sticky footer). Fall back to
    // the synthetic click rather than giving up — it works on some forms, and a
    // failed submit is reported honestly either way.
    return await page
      .evaluate(() => {
        const el = document.querySelector('[data-af-submit="1"]') as HTMLElement | null;
        if (!el) return false;
        el.click();
        return true;
      })
      .catch(() => false);
  }
}
