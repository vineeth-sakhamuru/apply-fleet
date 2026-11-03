/** Throwaway: dump the real Ashby custom-widget DOM so the scanner targets it without guessing. */
import { chromium } from 'patchright';

const url = process.argv[2] ?? 'https://jobs.ashbyhq.com/brainco/58cff031-5b0b-4b92-a1ea-2ebf2495d89d/application';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input,select,textarea', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const dump = await page.evaluate(() => {
    const out: string[] = [];
    const containers = document.querySelectorAll(
      '.ashby-application-form-field-entry, [class*="_fieldEntry"], [role="radiogroup"]',
    );
    [...containers].forEach((c: any, i: number) => {
      const txt = (c.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/authorized to work|days per week/i.test(txt)) return;
      const nativeInput = c.querySelector('input:not([type="hidden"]), select, textarea');
      const inputs = [...c.querySelectorAll('input')].map(
        (x: any) => `INPUT{type=${x.type}, hidden=${x.type === 'hidden'}, name=${x.name || ''}}`,
      );
      const buttons = [...c.querySelectorAll('button')].map((b: any) => JSON.stringify((b.textContent || '').trim()));
      out.push(
        `#${i} Q=${JSON.stringify(txt.slice(0, 45))}` +
          `\n   GUARD nativeInput=${nativeInput ? 'PRESENT(' + (nativeInput as any).tagName + '/' + (nativeInput as any).type + ') -> SKIPPED' : 'none -> kept'}` +
          `\n   inputs=[${inputs.join(', ')}]  buttons=[${buttons.join(', ')}]`,
      );
    });
    return out.join('\n\n') || 'no matching containers';
  });
  console.log(dump);
} finally {
  await browser.close();
}
