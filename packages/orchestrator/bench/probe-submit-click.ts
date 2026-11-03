/** What ACTUALLY happens when we click Submit?
 *
 *  Replays a ready spec, clicks the real submit control, and records the things
 *  a screenshot cannot show: console errors, every network request the click
 *  produced, and the aria/validation state afterwards.
 *
 *  This exists because three armed attempts all reported "clicked, no
 *  confirmation" while the post-click screenshot showed a fully filled, valid
 *  form. Screenshot evidence had run out of information.
 *
 *  Clicks a REAL submit on a REAL application — run it only on a target you
 *  intend to apply to.
 *
 *  usage: node packages/orchestrator/bench/probe-submit-click.ts <applicationId>
 */
import { resolve } from 'node:path';
import { chromium } from 'patchright';
import { openSqlite, SCHEMA, migrate, getReadySpec, getApplication } from '@apply-fleet/data';
import { scanFormWithFallback, fillField, uploadResume, findSubmit } from '@apply-fleet/worker';

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const id = process.argv[2];
const dbPath = process.env.APPLY_FLEET_DB ?? resolve(import.meta.dirname, '../../../data/live.db');
const db = openSqlite(dbPath);
await db.exec(SCHEMA);
await migrate(db);

const app = await getApplication(db, id);
const spec = (await getReadySpec(db, id)) as any;
if (!app || !spec) { console.log(`no app/spec for ${id}`); process.exit(1); }
console.log(`${app.company} — ${app.role}\n${spec.url}\n`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const console_: string[] = [];
const requests: string[] = [];
const responses: string[] = [];
page.on('console', (m) => console_.push(`${m.type()}: ${m.text().slice(0, 160)}`));
page.on('pageerror', (e) => console_.push(`pageerror: ${String(e).slice(0, 160)}`));
page.on('request', (r) => {
  if (r.method() !== 'GET') requests.push(`${r.method()} ${r.url().slice(0, 120)}`);
});
page.on('response', (r) => {
  if (r.request().method() !== 'GET') responses.push(`${r.status()} ${r.url().slice(0, 120)}`);
});

try {
  await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input,select,textarea', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Replay the spec, résumé first (Ashby's parser re-renders and wipes).
  const byLabel = new Map(spec.values.map((v: any) => [norm(v.label), v]));
  const { fields } = await scanFormWithFallback(page);
  const ordered = [...fields.filter((f) => f.kind === 'file'), ...fields.filter((f) => f.kind !== 'file')];
  for (const f of ordered) {
    if (f.kind === 'file') {
      if (spec.resumePath) {
        await uploadResume(page, f.selector, spec.resumePath).catch((e) => console.log('upload failed:', e.message));
        await page.waitForTimeout(1500);
      }
      continue;
    }
    const v: any = byLabel.get(norm(f.label));
    if (v) await fillField(page, f, v.value);
  }
  await page.waitForTimeout(800);

  const target = await findSubmit(page);
  console.log(`submit control: ${target ? `"${target.label}"` : 'NONE'}`);
  if (!target) process.exit(1);

  // Clear the recorders so we only see what the CLICK caused.
  requests.length = 0;
  responses.length = 0;
  console_.length = 0;

  const urlBefore = page.url();
  await page.click('[data-af-submit="1"]', { timeout: 8000 }).catch(async () => {
    // findSubmit doesn't tag; tag by index then click.
    await page.evaluate((i: number) => {
      const els = [...document.querySelectorAll('button, input[type="submit"], [role="button"], a[class*="submit"]')] as any[];
      const vis = els.filter((e) => e.offsetParent !== null || e.getClientRects().length > 0);
      vis[i]?.setAttribute('data-af-submit', '1');
    }, target.index);
    await page.click('[data-af-submit="1"]', { timeout: 8000 });
  });

  await page.waitForTimeout(5000);

  console.log(`\nurl before: ${urlBefore}`);
  console.log(`url after : ${page.url()}`);
  console.log(`\nNON-GET REQUESTS the click fired (${requests.length}):`);
  for (const r of requests) console.log(`  ${r}`);
  console.log(`\nRESPONSES (${responses.length}):`);
  for (const r of responses) console.log(`  ${r}`);
  console.log(`\nCONSOLE (${console_.length}):`);
  for (const c of console_.slice(0, 12)) console.log(`  ${c}`);

  // Anything the form is now complaining about, and whether it thinks it's busy.
  const state = await page.evaluate(() => {
    const btn = document.querySelector('[data-af-submit="1"]') as HTMLButtonElement | null;
    const invalid = [...document.querySelectorAll('[aria-invalid="true"]')].length;
    const alerts = [...document.querySelectorAll('[role="alert"]')]
      .map((e) => (e as HTMLElement).innerText.trim())
      .filter(Boolean)
      .slice(0, 6);
    return {
      buttonStillPresent: !!btn,
      buttonDisabled: btn ? btn.disabled : null,
      buttonText: btn ? (btn.textContent || '').trim().slice(0, 40) : null,
      ariaInvalidCount: invalid,
      alerts,
      bodyHasThanks: /thank you|received your application/i.test(document.body.innerText),
    };
  });
  console.log(`\nPAGE STATE AFTER CLICK:\n${JSON.stringify(state, null, 2)}`);
} finally {
  await page.close().catch(() => {});
  await browser.close();
}
