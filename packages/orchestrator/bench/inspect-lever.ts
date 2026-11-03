/**
 * Inspect a live Lever apply form's DOM so we can see WHY groundable fields
 * (work authorization, sponsorship, …) come up empty. Read-only. Submits nothing.
 *   node packages/orchestrator/bench/inspect-lever.ts
 */
import { chromium } from 'patchright';
import { discoverAll, type DiscoveryTarget } from '@apply-fleet/discovery';

const TARGET: DiscoveryTarget[] = [{ ats: 'lever', slug: 'palantir', company: 'Palantir' }];

async function main() {
  const jobs = await discoverAll(TARGET, { maxAgeHours: 24 * 90, onError: () => {} });
  const url = jobs[0]?.applyUrl;
  if (!url) { console.log('no palantir lever job found'); return; }
  console.log('apply URL:', url, '\n');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1700 });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input,select,textarea', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const dump = await page.evaluate(() => {
      const labelFor = (el: any): string => {
        if (el.labels && el.labels.length) return (el.labels[0].textContent || '').trim();
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim();
        if (el.placeholder) return el.placeholder.trim();
        return (el.name || '').trim();
      };
      // Lever cards: each custom question sits in an .application-question with a
      // .application-label holding the human question text.
      const cards = [...document.querySelectorAll('.application-question, li.application-question, .card')].map((c: any) => {
        const labelEl = c.querySelector('.application-label, label, .text');
        const inputs = [...c.querySelectorAll('input,select,textarea')].map((i: any) => ({
          tag: i.tagName.toLowerCase(), type: i.type, name: i.name, ourLabel: labelFor(i),
        }));
        return {
          questionText: labelEl ? (labelEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '(no .application-label)',
          inputCount: inputs.length,
          firstInputs: inputs.slice(0, 3),
        };
      });
      // Anything mentioning authorization / sponsorship, however rendered.
      const hits: any[] = [];
      for (const el of [...document.querySelectorAll('input,select,textarea')] as any[]) {
        const around = (el.closest('.application-question, li, fieldset, div') || el).textContent || '';
        if (/authoriz|sponsor|eligible to work/i.test(around)) {
          hits.push({
            tag: el.tagName.toLowerCase(), type: el.type, name: el.name,
            ourLabel: labelFor(el),
            nearbyText: around.replace(/\s+/g, ' ').trim().slice(0, 160),
          });
        }
      }
      return { cardCount: cards.length, cards: cards.slice(0, 12), authHits: hits.slice(0, 6) };
    });

    console.log('=== LEVER CARDS (custom questions) ===');
    console.log(`total cards: ${dump.cardCount}`);
    for (const c of dump.cards) {
      console.log(`\n  Q: ${c.questionText}`);
      console.log(`     inputs: ${c.inputCount}  ${JSON.stringify(c.firstInputs)}`);
    }
    console.log('\n=== WORK-AUTH / SPONSORSHIP HITS ===');
    for (const h of dump.authHits) console.log('  ', JSON.stringify(h));

    console.log('\n=== WORK-AUTH CARD INTERNALS ===');
    const cardDetail = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.application-question, li.application-question')] as any[];
      const card = cards.find((c) => /authoriz|sponsor/i.test(c.textContent || ''));
      if (!card) return null;
      // For each real (non-hidden) control, find the nearest preceding label-ish text.
      const controls = [...card.querySelectorAll('input,select,textarea')].filter((i: any) => i.type !== 'hidden');
      const rows = controls.map((i: any) => {
        let subLabel = '';
        // walk previous siblings / ancestors for a .text/label/description
        let n: any = i;
        for (let hop = 0; hop < 6 && n; hop++) {
          const prev = n.previousElementSibling;
          if (prev && /application-label|text|description|question/i.test(prev.className || '')) {
            subLabel = (prev.textContent || '').replace(/\s+/g, ' ').trim();
            break;
          }
          n = prev || n.parentElement;
        }
        return { type: i.type, name: i.name, valueAttr: i.value, optionText: (i.labels?.[0]?.textContent || '').trim(), subLabel: subLabel.slice(0, 80) };
      });
      return { classNames: card.className, htmlHead: (card.innerHTML || '').replace(/\s+/g, ' ').slice(0, 1400), controls: rows.slice(0, 10) };
    });
    console.log(JSON.stringify(cardDetail, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
