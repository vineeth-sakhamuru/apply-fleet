/** Inspect a live Ashby form: for each input, show what our labelFor picks vs
 *  the real field-entry label. Read-only, submits nothing. */
import { chromium } from 'patchright';
import { discoverAll, type DiscoveryTarget } from '@apply-fleet/discovery';

const TARGET: DiscoveryTarget[] = [{ ats: 'ashby', slug: 'notion', company: 'Notion' }];

async function main() {
  const jobs = await discoverAll(TARGET, { maxAgeHours: 24 * 90, onError: () => {} });
  const url = jobs[0]?.applyUrl;
  if (!url) { console.log('no notion ashby job'); return; }
  console.log('apply URL:', url, '\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1700 });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input,select,textarea', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const rows = await page.evaluate(() => {
      const labelFor = (el: any): string => {
        if (el.labels && el.labels.length) return (el.labels[0].textContent || '').trim();
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim();
        if (el.placeholder) return el.placeholder.trim();
        return (el.name || '').trim();
      };
      const clean = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const out: any[] = [];
      for (const el of [...document.querySelectorAll('input,textarea')] as any[]) {
        if (['hidden', 'submit', 'button'].includes(el.type)) continue;
        const entry = el.closest('.ashby-application-form-field-entry, [class*="_fieldEntry"], [class*="fieldEntry"]');
        const labEl = entry ? entry.querySelector('label, [class*="label"], .ashby-application-form-question-title') : null;
        out.push({
          type: el.type,
          placeholder: el.placeholder || '',
          ourLabel: clean(labelFor(el)).slice(0, 50),
          entryClass: entry ? clean(entry.className).slice(0, 60) : '(none)',
          realLabel: labEl ? clean(labEl.textContent || '').slice(0, 70) : '(no label in entry)',
        });
      }
      return out;
    });
    for (const r of rows) {
      const flag = (r.type === 'text' && /pick date|date/i.test(r.placeholder)) || r.ourLabel !== r.realLabel ? ' ⚠' : '';
      console.log(`[${r.type}] ph="${r.placeholder}"${flag}`);
      console.log(`   ourLabel:  ${r.ourLabel}`);
      console.log(`   realLabel: ${r.realLabel}`);
      console.log(`   entry:     ${r.entryClass}`);
    }
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
