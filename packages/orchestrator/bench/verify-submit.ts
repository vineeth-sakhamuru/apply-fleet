/** For every 'ready' app: open its form, replay nothing, and check whether the
 *  submit control the spec recorded ACTUALLY resolves and is clickable.
 *  Never clicks. This answers "does ready mean submittable?" */
import { resolve } from 'node:path';
import { chromium } from 'patchright';
import { openSqlite, SCHEMA, listByStatus, getReadySpec } from '@apply-fleet/data';

const dbPath = process.env.APPLY_FLEET_DB ?? resolve(import.meta.dirname, '../../../data/live.db');
const db = openSqlite(dbPath);
await db.exec(SCHEMA);
const ready = await listByStatus(db, 'ready');
console.log(`checking ${ready.length} ready apps\n`);

const browser = await chromium.launch({ headless: true });
for (const a of ready) {
  const spec: any = await getReadySpec(db, a.id);
  if (!spec) { console.log(`  ?  ${a.company} — no spec`); continue; }
  const page = await browser.newPage();
  try {
    await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input,select,textarea', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const r = await page.evaluate((sel: string) => {
      const els = [...document.querySelectorAll(sel)] as any[];
      const visible = els.filter((e) => e.offsetParent !== null || e.getClientRects().length);
      const best = visible[0] || els[0];
      return {
        matched: els.length,
        visible: visible.length,
        text: best ? (best.textContent || best.value || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '',
        disabled: best ? !!best.disabled : null,
      };
    }, spec.submitSelector);
    const ok = r.visible > 0 && r.disabled === false;
    console.log(`  ${ok ? 'OK ' : 'BAD'} ${a.company.padEnd(12)} ${a.ats.padEnd(10)} sel="${spec.submitSelector.slice(0,34)}" matched=${r.matched} visible=${r.visible} disabled=${r.disabled} text="${r.text}"`);
  } catch (e) {
    console.log(`  ERR ${a.company}: ${e instanceof Error ? e.message.slice(0, 70) : e}`);
  } finally { await page.close().catch(() => {}); }
}
await browser.close();
