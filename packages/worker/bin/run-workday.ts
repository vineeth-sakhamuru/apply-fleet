/**
 * Workday wizard adapter — the multi-step case the single-page maps in
 * src/maps.ts (greenhouse/ashby/lever) don't cover.
 *
 * Deterministic by construction: every value comes from config/profile.yml or
 * config/answers.yml via the ordered RULES table below. No LLM, no guessing.
 * A question that matches no rule is reported as HITL, never invented.
 *
 * Usage:
 *   node bin/run-workday.ts <applyUrl> [company]
 *   CDP=1                 attach to Chrome on :9222 (keeps your logged-in session)
 *   APPLY_FLEET_ARM_SUBMIT=1   actually click Submit (otherwise stops at Review)
 *
 * ponytail: Workday only. Other wizard ATSes (iCIMS, Phenom, Oracle) reuse
 * RULES + setField verbatim; they need their own STEP/next selectors here.
 */
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, type Locator } from 'patchright';
import { loadProfile, loadAnswers } from '@apply-fleet/data';

/** True only when run as `node run-workday.ts`, so tests can import RULES. */
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

const url = process.argv[2];
const company = process.argv[3] ?? 'the company';
if (isMain && !url) { console.error('usage: run-workday.ts <applyUrl> [company]'); process.exit(1); }

const root = resolvePath(import.meta.dirname, '../../..');
const pick = (n: string) => {
  const real = resolvePath(root, `config/${n}.yml`);
  return existsSync(real) ? real : resolvePath(root, `config/${n}.example.yml`);
};
const A = loadAnswers(pick('answers')) as any;
const P = loadProfile(pick('profile')) as any;

const RESUME = process.env.RESUME ?? P?.resume?.path ?? '';

/** Ordered question bank. First match wins. The deterministic knowledge layer. */
type Rule = [RegExp, string | (() => string)];
const RULES: Rule[] = [
  // --- work authorization: the single most-asked screener family -----------
  [/require.*sponsor|sponsorship for employment|need.*visa.*sponsor/i, A.authorization.requires_sponsorship ? 'Yes' : 'No'],
  [/legally authorized to work|authorized to work in|right to work|eligible to work/i, A.authorization.authorized_to_work_us ? 'Yes' : 'No'],
  [/provide documentation establishing your identity/i, 'Yes'],
  [/(at least|of legal) age|18 years|over 18/i, A.authorization.over_18 ? 'Yes' : 'No'],
  [/security clearance/i, A.authorization.security_clearance ?? 'None'],

  // --- prior relationship with this employer ------------------------------
  [/ever (been )?(worked|employed) (at|by|for)|previously.*employ|former employee/i, 'No'],
  [/have not worked for|never worked for/i, 'CHECK'],          // checkbox-style opt-out
  [/related to .*employee|relative.*work(s|ing) (at|for)/i, 'No'],
  [/non.?compete|restrictive covenant/i, 'No'],

  // --- logistics -----------------------------------------------------------
  [/willing to relocate|able to relocate|open to relocation/i, A.relocation.willing_to_relocate ? 'Yes' : 'No'],
  [/able to work on a daily basis in the work location/i, 'Yes'],
  [/background check|drug (screen|test)/i, 'Yes'],
  [/competing offer|other offers.*deadline/i, 'No'],
  [/earliest.*start date|when (can|could) you start|available to start/i, A.availability.earliest_start_date],
  [/notice period/i, String(A.availability.notice_period_days ?? '')],

  // --- education / status --------------------------------------------------
  [/currently enrolled|best describes your current status/i, 'currently enrolled'],
  [/graduation date|expected graduation|when.*graduat/i, gradMMYYYY()],
  [/degree major|major and\/or minor|field of study|area of study/i, majorLine()],
  [/(gpa|grade point)/i, A.education?.[0]?.gpa ?? ''],
  [/phd candidates/i, ''],                                      // not a PhD → leave blank

  // --- compensation --------------------------------------------------------
  [/desired (salary|compensation)|salary expectation|expected (salary|compensation)/i, A.compensation.desired_total_comp],
  [/minimum (salary|compensation)|salary floor/i, A.compensation.minimum_total_comp],

  // --- sourcing ------------------------------------------------------------
  [/how did you hear|how were you referred|source/i, 'Adobe.com'],

  // --- EEO / self-identification (his confirmed values, see answers.yml) ---
  [/veteran/i, A.eeo.veteran_status],
  [/gender/i, A.eeo.gender],
  [/ethnicity|race/i, A.eeo.race_ethnicity],
  [/disability/i, A.eeo.disability_status],
  [/pronoun/i, A.eeo.pronouns],

  // --- identity / contact --------------------------------------------------
  [/first name|given name/i, A.identity.first_name],
  [/last name|family name|surname/i, A.identity.last_name],
  [/^.*middle name/i, A.identity.middle_name],
  [/full (legal )?name|legal name/i, A.identity.full_legal_name],
  [/email/i, A.contact.email],
  [/phone (number|device)?$|^phone/i, A.contact.phone],
  [/address line 1|street address/i, A.contact.address_line1],
  [/address line 2|apt|unit|suite/i, A.contact.address_line2],
  [/^city/i, A.contact.city],
  [/postal code|zip/i, A.contact.postal_code],
  [/^state|province|region/i, 'California'],
  [/^country(?! phone)/i, 'United States of America'],
  [/linkedin/i, A.contact.linkedin],
  [/github/i, A.contact.github],
  [/website|portfolio/i, ''],
  [/spoken language|languages.*speak/i, A.spoken_languages],
];

function gradMMYYYY(): string {
  const g = A.education?.[0]?.end ?? '';                        // "2027-04"
  const m = /^(\d{4})-(\d{2})$/.exec(g);
  return m ? `${m[2]}/${m[1]}` : (A.education?.[0]?.graduation ?? '');
}
function majorLine(): string {
  const d = A.education?.[0]?.degree ?? '';                     // "MS, Computer Science"
  const m = /,\s*(.+)$/.exec(d);
  return m ? `${m[1]} (MS); no minor.` : d;
}

/** Resolve a question to an answer, or null when nothing grounds it. */
export function resolveQuestion(q: string): string | null {
  const text = q.replace(/\s+/g, ' ').trim();
  for (const [re, val] of RULES) {
    if (re.test(text)) {
      const v = typeof val === 'function' ? val() : val;
      return v === '' ? null : v;
    }
  }
  return null;
}

const log = (...a: unknown[]) => console.log('[workday]', ...a);
const step = async (page: Page) => {
  const n = page.locator('[data-automation-id="progressBarActiveStep"]');
  return (await n.count()) ? (await n.first().innerText()).replace(/\s+/g, ' ').trim() : '';
};

/** Fill one Workday formField with `value`, picking the widget handler by DOM. */
async function setField(page: Page, ff: Locator, value: string): Promise<string> {
  // 1. single-select dropdown
  const btn = ff.locator('button[aria-haspopup="listbox"]');
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(900);
    const opts = page.locator('[role="option"]');
    const texts = await opts.allInnerTexts();
    const i = bestOption(texts, value);
    if (i < 0) { await page.keyboard.press('Escape'); return `no option ~ "${value}"`; }
    await opts.nth(i).click();
    await page.waitForTimeout(700);
    return texts[i].trim();
  }

  // 2. checkbox group — `value === 'CHECK'` ticks the box whose label matched
  const cbs = ff.locator('input[type="checkbox"]');
  if (await cbs.count()) {
    await cbs.first().check({ force: true });
    return 'checked';
  }

  // 3. radio group (Yes/No)
  const radios = ff.locator('input[type="radio"]');
  if (await radios.count()) {
    const want = /^y/i.test(value) ? 'true' : 'false';
    const r = ff.locator(`input[type="radio"][value="${want}"]`);
    if (await r.count()) { await r.first().check({ force: true }); return value; }
  }

  // 4. multiselect prompt (searchbox + popup; Workday searches on Enter only)
  const search = ff.locator('input[data-automation-id="searchBox"]');
  if (await search.count()) return pickFromPrompt(page, search.first(), value, value);

  // 5. date (MM/YYYY segments)
  const month = ff.locator('[data-automation-id="dateSectionMonth-input"]');
  if (await month.count()) {
    const digits = value.replace(/\D/g, '');
    await month.first().click();
    await month.first().type(digits, { delay: 55 });
    return value;
  }
  const year = ff.locator('[data-automation-id="dateSectionYear-input"]');
  if (await year.count()) {
    await year.first().click();
    await year.first().type(value.replace(/\D/g, ''), { delay: 55 });
    return value;
  }

  // 6. plain text / textarea
  const txt = ff.locator('input[type="text"], input:not([type]), textarea');
  if (await txt.count()) { await txt.first().fill(value); return value; }

  return 'no widget';
}

/** Workday prompt: type, press Enter (search fires on Enter), click exact option. */
async function pickFromPrompt(page: Page, box: Locator, query: string, want: string): Promise<string> {
  await box.click();
  await page.waitForTimeout(300);
  await box.fill('');
  await box.type(query, { delay: 12 });
  await box.press('Enter');
  await page.waitForTimeout(1700);
  const opts = page.locator('[role="option"]');
  const texts = await opts.allInnerTexts();
  const i = bestOption(texts, want);
  if (i < 0) return `no option ~ "${want}"`;
  await opts.nth(i).click();
  await page.waitForTimeout(800);
  return texts[i].trim();
}

/** Exact match wins, then "want (…)", then prefix, then substring. Deterministic. */
export function bestOption(texts: string[], want: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const w = norm(want);
  if (!w) return -1;
  const cands = texts.map((t, i) => ({ t: t.trim(), i })).filter((c) => c.t && c.t !== 'Select One' && c.t !== 'No Items.');
  const score = (t: string) => {
    const x = norm(t), raw = t.toLowerCase();
    if (x === w) return 0;
    if (raw.startsWith(want.toLowerCase() + ' (')) return 1;
    if (x.startsWith(w + ' ')) return 2;
    if (x.startsWith(w)) return 3;
    if (x.includes(w)) return 4;
    return 9;
  };
  const ranked = cands.map((c) => ({ ...c, s: score(c.t) })).filter((c) => c.s < 9)
    .sort((a, b) => a.s - b.s || a.t.length - b.t.length);
  return ranked.length ? ranked[0].i : -1;
}

/** Answer every question on the current step from RULES. Returns [filled, hitl]. */
async function answerStep(page: Page): Promise<[string[], string[]]> {
  const filled: string[] = [], hitl: string[] = [];
  const ffs = page.locator('[data-automation-id^="formField-"]');
  for (let i = 0; i < (await ffs.count()); i++) {
    const ff = ffs.nth(i);
    let text = '';
    try { text = (await ff.innerText()).replace(/\s+/g, ' ').trim(); } catch { continue; }
    const q = text.split(/\s*(?:Select One|\d+ items? selected)/)[0].slice(0, 160);
    if (!q) continue;
    // already answered?
    if (/\d+ items? selected/.test(text) && !/0 items selected/.test(text)) continue;
    const val = resolveQuestion(q);
    if (val === null) { if (/\*/.test(text)) hitl.push(q); continue; }
    try {
      const got = await setField(page, ff, val);
      filled.push(`${q.slice(0, 54).padEnd(54)} = ${got}`);
    } catch (e) { hitl.push(`${q}  (${(e as Error).message.slice(0, 50)})`); }
  }
  return [filled, hitl];
}

/** Job posting -> wizard. Workday gates the form behind Apply, then a mode. */
async function startApplication(page: Page): Promise<void> {
  if (await step(page)) return;                                  // already in the wizard
  const apply = page.locator('a,button').filter({ hasText: /^Apply$/ });
  if (await apply.count()) { await apply.first().click(); await page.waitForTimeout(3000); }
  // "Autofill with Resume" parses the PDF for us; "Apply Manually" is the fallback.
  for (const label of [/^Autofill with Resume$/, /^Apply Manually$/]) {
    const b = page.locator('a,button').filter({ hasText: label });
    if (await b.count()) { await b.first().click(); await page.waitForTimeout(5000); break; }
  }
  if (await page.locator('input[type="password"]').count()) {
    throw new Error('Workday wants a sign-in. Re-run with CDP=1 against your logged-in Chrome.');
  }
}

async function next(page: Page): Promise<string> {
  const before = await step(page);
  const btn = page.locator('[data-automation-id="pageFooterNextButton"]');
  if (!(await btn.count())) return before;                       // no Next on this screen
  await btn.click();
  await page.waitForFunction(
    (b) => { const n = document.querySelector('[data-automation-id="progressBarActiveStep"]'); return n && n.textContent!.replace(/\s+/g, ' ').trim() !== b; },
    before, { timeout: 25000 },
  ).catch(() => {});
  await page.waitForTimeout(1000);
  const errs = await page.locator('[data-automation-id^="formField-"]')
    .filter({ hasText: /Error|Invalid Date/ }).allInnerTexts().catch(() => []);
  if (errs.length) log('  !! errors:', errs.map((e) => e.replace(/\s+/g, ' ').slice(0, 80)));
  return step(page);
}

// ---------------------------------------------------------------- main ----
if (isMain) {
const useCdp = process.env.CDP === '1';
const browser = useCdp
  ? await chromium.connectOverCDP('http://127.0.0.1:9222')
  : await chromium.launch({ headless: false });
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages().find((p) => p.url().includes('myworkdayjobs.com')) ?? (await ctx.newPage());
if (!page.url().includes('myworkdayjobs.com')) await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.bringToFront();

const allFilled: string[] = [], allHitl: string[] = [];
const t0 = Date.now();
await startApplication(page);

for (let guard = 0; guard < 10; guard++) {
  const s = await step(page);
  log(s || page.url().slice(0, 70));
  if (/step 7 of 7|Review/i.test(s)) break;

  // resume upload, wherever it appears
  if (RESUME && existsSync(RESUME)) {
    const fi = page.locator('input[type="file"]');
    if ((await fi.count()) && !(await page.locator('text=Successfully Uploaded').count())) {
      await fi.last().setInputFiles(RESUME);
      log('  resume attached, waiting for parse…');
      await page.waitForTimeout(8000);
    }
  }

  const [f, h] = await answerStep(page);
  for (const x of f) log('  ' + x);
  allFilled.push(...f); allHitl.push(...h);

  const after = await next(page);
  if (after === s) { log('  stuck on', s); break; }
}

const review = await page.locator('#mainContent').innerText().catch(() => '');
console.log(`\n=== ${company} — Workday === ${Date.now() - t0} ms`);
console.log(`filled from config (${allFilled.length}):`);
for (const f of allFilled) console.log('  ' + f);
console.log(`\nnot grounded — needs you (${allHitl.length}):`);
for (const h of allHitl) console.log('  ' + h);

if (process.env.APPLY_FLEET_ARM_SUBMIT === '1' && /step 7 of 7|Review/i.test(await step(page))) {
  await page.locator('button', { hasText: /^Submit$/ }).first().click();
  await page.waitForTimeout(8000);
  log('submitted:', (await page.locator('#mainContent').innerText()).replace(/\s+/g, ' ').slice(0, 200));
} else {
  console.log('\nstopped at:', (await step(page)) || 'unknown', '— set APPLY_FLEET_ARM_SUBMIT=1 to submit.');
  console.log(review.replace(/\n{3,}/g, '\n').slice(0, 2500));
}
if (!useCdp) await browser.close();
}
