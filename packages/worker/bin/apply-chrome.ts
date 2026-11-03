/**
 * Walk a multi-step application in his Chrome: open the apply form from a
 * posting page, then fill each step with fill-chrome and press Next, until the
 * page offers only Submit/Apply. That last click is his; this never presses
 * anything named submit/apply/send.
 *
 * Usage: node packages/worker/bin/apply-chrome.ts <urlSubstring> [fill-chrome flags...]
 */
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { chromePage } from '../src/chrome.ts';

const [match = '', ...fillArgs] = process.argv.slice(2);
const t0 = Date.now();
const page = await chromePage(match);
const fill = resolvePath(import.meta.dirname, 'fill-chrome.ts');

// Posting page → the form. Setting the tab URL works where a JS click on the
// Apply link doesn't (Google routes it through jsaction).
const applyHref: string | null = await page.evaluate(() => {
  // Already on a form (Workday keeps "apply" links in its chrome): stay put.
  if (document.querySelector('[data-automation-id^="formField"], form input:not([type=hidden])')) return null;
  // Already on a form (Workday keeps "apply" links in its chrome): stay put.
  if (document.querySelector('[data-automation-id^="formField"], form input:not([type=hidden])')) return null;
  // Match the resolved URL: Google's attribute is relative ("./apply?jobId=").
  const a = [...document.querySelectorAll('a')].find((a) => /\/apply(\/|\?)/.test(a.href) && /apply/i.test(a.innerText + (a.getAttribute('aria-label') || '')));
  return a ? a.href : null;
});
if (applyHref) await page.goto(applyHref);

const button = (re: string) =>
  page.evaluate((re: string) => {
    const r = new RegExp(re, 'i');
    return [...document.querySelectorAll('button, [role=button], input[type=submit]')]
      .filter((b: any) => b.getClientRects().length && !b.disabled)
      .map((b: any) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim())
      .filter((t) => r.test(t));
  }, re);

// Where the form is: the URL, plus Workday's "current step N of M" (its URL
// never changes between steps).
const where = () =>
  page.evaluate(() => location.href + ' ' + ((document.body.innerText.match(/current step \d+ of \d+/i) || [''])[0]));

for (let step = 0; step < 12; step++) {
  await page.waitForSelector('input, select, textarea, [role=combobox]', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const url = await page.evaluate(() => location.href);
  const before = await where();
  console.log(`\n=== step ${step + 1} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${url}`);
  process.stdout.write(execFileSync('node', [fill, match, ...fillArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

  const next = (await button('^(next|continue|save (and|&) continue)$'))[0];
  if (!next) {
    const final = await button('submit|apply|send');
    console.log(`\nSTOP at ${url}: ${final.length ? `his click: "${final.join('" / "')}"` : 'no Next button'}`);
    break;
  }
  await page.evaluate((label: string) => {
    // The innermost real <button>: a [role=button] wrapper with the same text
    // swallowed the click and the step never advanced.
    const bs = [...document.querySelectorAll('button')].filter(
      (b: any) => b.getClientRects().length && (b.innerText || '').trim() === label,
    ) as any[];
    const b = bs[bs.length - 1];
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.x + 4, clientY: r.y + 4 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      b.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
  }, next);
  for (let i = 0; i < 40 && (await where()) === before; i++) await page.waitForTimeout(150);
  if ((await where()) === before) {
    console.log(`\nSTOP: "${next}" did not advance (validation error on this step?)`);
    break;
  }
}
console.log(`\nTOTAL script time ${((Date.now() - t0) / 1000).toFixed(1)}s`);
