import type { Page } from 'patchright';
import type { ReadySpec } from './types.ts';
import { scanFormWithFallback, fillField, uploadResume } from './engine.ts';
import { findSubmit, clickSubmit } from './submit.ts';

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Result of an execute pass. `submitted` = the armed click fired; `confirmed`
 *  = the ATS actually acknowledged it (nav/thank-you/form gone). `incomplete`
 *  lists required fields we could NOT fill on replay — when non-empty we refuse
 *  to click, so a drifted or partially-rendered form is never blind-submitted. */
export interface ExecuteResult {
  filled: number;
  submitted: boolean;
  confirmed: boolean;
  incomplete: string[];
  reason?: string;
  /** Post-click screenshot, written when `evidencePath` is given. */
  evidencePath?: string;
  /** Inline validation errors the ATS rendered after the click, if any. */
  errors?: string[];
}

/**
 * Pull the ATS's own inline validation messages off the page.
 *
 * This is the difference between "submit didn't work" and "submit didn't work
 * BECAUSE Work Authorization was required and we left it blank". An unconfirmed
 * submit with no diagnostic is unactionable — you can't retry safely because you
 * don't know whether the click failed or the application silently went through.
 */
export async function readValidationErrors(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const sel = '[aria-invalid="true"], [role="alert"], .error, [class*="error" i], [class*="invalid" i]';
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const t = (el as HTMLElement).innerText?.trim();
        // Skip empty shells and whole-form wrappers that swallow the page.
        if (t && t.length < 200 && !out.includes(t)) out.push(t);
      }
      return out.slice(0, 12);
    })
    .catch(() => []);
}

/**
 * Decide whether a post-submit page indicates the application was accepted.
 * Pure so it's unit-testable without a browser. Success is any of: the URL
 * moved to a confirmation/thank-you route, or the page text carries an
 * acknowledgement, or (checked by the caller) the submit control is gone.
 */
export function isSubmitConfirmed(urlBefore: string, urlAfter: string, bodyText: string): boolean {
  const okUrl = /thank|confirm|success|submitted|complete|received|application-sent/i;
  if (urlAfter !== urlBefore && okUrl.test(urlAfter)) return true;
  const okText =
    /thank you|application (has been |was )?(received|submitted|sent)|we('| ha)ve received your application|successfully (applied|submitted|received)|your application (is|has been) (complete|submitted|received)|thanks for applying/i;
  return okText.test(bodyText || '');
}

/**
 * Replay a prepared spec on a fresh page, then (only if armed) submit — with a
 * completeness gate before the click and a confirmation check after it.
 *
 * It re-scans the live form through the SAME engine that prepared it (including
 * the vision fallback for custom forms), so every field kind replays correctly
 * and any drift since prepare is caught here rather than blind-submitted.
 *
 * Submit is DOUBLE-gated: the human triggers submission AND `arm` must be true.
 * Without the arm flag it fills and stops — a stray click can never file a real
 * application. Auto-submitting real applications is the one irreversible action
 * the system refuses to take on its own.
 */
export async function executeSpec(
  page: Page,
  spec: ReadySpec,
  opts: { arm?: boolean; resumePath?: string; evidencePath?: string } = {},
): Promise<ExecuteResult> {
  await page.goto(spec.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input,select,textarea', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const byLabel = new Map(spec.values.map((v) => [norm(v.label), v]));
  const { fields } = await scanFormWithFallback(page);
  let filled = 0;
  const incomplete: string[] = [];
  // Résumé first — same reason as prepare: Ashby's résumé parser re-renders the
  // form and wipes anything already typed. On replay this mattered even more,
  // because the wipe happened AFTER the completeness gate had already passed.
  const ordered = [
    ...fields.filter((f) => f.kind === 'file'),
    ...fields.filter((f) => f.kind !== 'file'),
  ];
  for (const f of ordered) {
    if (f.kind === 'file') {
      const rp = opts.resumePath ?? spec.resumePath;
      if (rp) {
        try { await uploadResume(page, f.selector || 'input[type="file"]', rp); filled++; }
        catch { if (f.required) incomplete.push(f.label || 'Resume'); }
      } else if (f.required) {
        incomplete.push(f.label || 'Resume');
      }
      continue;
    }
    const v = byLabel.get(norm(f.label));
    if (!v) {
      // The live form has a field the prepared spec doesn't cover. Only a hard
      // stop if it's required — optional extras are fine to leave blank.
      if (f.required) incomplete.push(f.label);
      continue;
    }
    const ok = await fillField(page, f, v.value);
    if (ok) filled++;
    else if (f.required) incomplete.push(f.label);
  }

  // Never submit a form with unfilled required fields — abort before the click.
  if (incomplete.length) {
    return { filled, submitted: false, confirmed: false, incomplete, reason: 'required fields unfilled on replay' };
  }
  if (!opts.arm) return { filled, submitted: false, confirmed: false, incomplete: [] };

  // Armed: locate the real submit control by intent and click THAT. Never the
  // stored CSS selector — on Ashby it resolves to "Upload file" and on Lever to
  // the cookie banner, both observed live on forms marked 'ready'.
  const target = await findSubmit(page);
  if (!target) {
    return {
      filled,
      submitted: false,
      confirmed: false,
      incomplete: [],
      reason: 'no trustworthy submit control on the page — refusing to click anything',
    };
  }
  const urlBefore = page.url();
  const clicked = await clickSubmit(page, target.index);
  if (!clicked) {
    return { filled, submitted: false, confirmed: false, incomplete: [], reason: 'submit control vanished before the click' };
  }
  // Give the ATS time to navigate / render its confirmation.
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const urlAfter = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const submitGone = (await findSubmit(page).catch(() => null)) === null;
  const confirmed = isSubmitConfirmed(urlBefore, urlAfter, bodyText) || submitGone;

  // Always capture what the page looked like AFTER the click. On a confirmed
  // submit it's the receipt; on an unconfirmed one it's the only way to tell a
  // blocked click from a silent success — and without that you can't retry
  // safely, because a retry might file a duplicate.
  let evidencePath: string | undefined;
  if (opts.evidencePath) {
    try {
      await page.screenshot({ path: opts.evidencePath, fullPage: true });
      evidencePath = opts.evidencePath;
    } catch { /* the errors list below is still useful on its own */ }
  }
  const errors = confirmed ? [] : await readValidationErrors(page);
  return { filled, submitted: true, confirmed, incomplete: [], evidencePath, errors };
}
