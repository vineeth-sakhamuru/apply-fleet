/** Probe the two Palantir fields that stay open: "how you heard" + "AI notetakers".
 *  Dump their DOM so we can see why fillByLabel misses. Read-only. */
import { chromium } from 'patchright';
import { discoverAll, type DiscoveryTarget } from '@apply-fleet/discovery';

const TARGET: DiscoveryTarget[] = [{ ats: 'lever', slug: 'palantir', company: 'Palantir' }];

async function main() {
  const jobs = await discoverAll(TARGET, { maxAgeHours: 24 * 90, onError: () => {} });
  const url = jobs[0]?.applyUrl;
  console.log('apply URL:', url, '\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1700 });
  try {
    await page.goto(url!, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input,select,textarea', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const out = await page.evaluate(() => {
      const pick = (re: RegExp) => {
        const cards = [...document.querySelectorAll('.application-question, li.application-question')] as any[];
        const card = cards.find((c) => re.test(c.textContent || ''));
        if (!card) return { found: false };
        const labelEl = card.querySelector('.application-label .text') || card.querySelector('.application-label');
        const controls = [...card.querySelectorAll('input,select,textarea')].filter((i: any) => i.type !== 'hidden').map((i: any) => ({
          tag: i.tagName.toLowerCase(), type: i.type, name: i.name, id: i.id,
          placeholder: i.placeholder || '', optText: (i.closest('.application-answer-alternative')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
        }));
        return { found: true, label: (labelEl?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), controlCount: controls.length, controls: controls.slice(0, 8) };
      };
      return { heard: pick(/how you heard|how did you hear/i), notetaker: pick(/notetaker|note taker|ai note/i) };
    });
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
