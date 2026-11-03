/**
 * Record a real ATS form as an offline golden fixture.
 *
 * Every ATS bug this system has had was found by paying to load a live page:
 * Ashby's asterisk-only required markers, Greenhouse's aria-hidden proxy inputs,
 * react-select menus that ignore synthetic events, "Apply Now" links scored as
 * submit buttons. Each took a live run to find and a live run to confirm — and
 * the offline fixtures we had were too clean to reproduce any of them.
 *
 * This snapshots the DOM AFTER the SPA has rendered, so the fixture has the same
 * shape the scanner actually meets. Fill logic can then be tested offline, and a
 * regression is caught by `npm test` instead of by a failed real application.
 *
 * PII: the capture happens BEFORE any fill, so nothing personal is written. The
 * script refuses to save a page that already has values in it.
 *
 * usage: node packages/worker/bench/capture-fixture.ts <url> <name>
 *   e.g. ... https://jobs.ashbyhq.com/ramp/<id>/application ashby-ramp
 */
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'patchright';
import { scanFormWithFallback } from '../src/engine.ts';

const [url, name] = process.argv.slice(2);
if (!url || !name) {
  console.log('usage: capture-fixture.ts <url> <name>');
  process.exit(1);
}

const outDir = resolve(import.meta.dirname, '../test/fixtures');
const htmlPath = resolve(outDir, `${name}.html`);
const metaPath = resolve(outDir, `${name}.scan.json`);
if (existsSync(htmlPath)) {
  console.log(`${htmlPath} exists — delete it first if you mean to re-record.`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input,select,textarea', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500); // let the SPA settle, same as prepare does

  // Refuse to record a page that already carries values — a fixture must never
  // ship someone's name and phone number into the repo.
  // Name the offending fields but NEVER print their values — the whole point is
  // that this content might be personal.
  const dirty = await page.evaluate(() =>
    [...document.querySelectorAll('input,textarea')]
      .filter(
        (e) =>
          !!(e as HTMLInputElement).value?.trim() &&
          // radio/checkbox `.value` is the option's value from the markup, not
          // something a human typed — `.checked` is the state that matters, and
          // an unfilled form has none set.
          !['hidden', 'submit', 'button', 'radio', 'checkbox'].includes(
            (e as HTMLInputElement).type,
          ),
      )
      .map((e) => (e as HTMLInputElement).id || (e as HTMLInputElement).name || e.getAttribute('placeholder') || '(unnamed)')
      .slice(0, 8),
  );
  if (dirty.length) {
    console.log(`refusing to record — ${dirty.length} field(s) already hold values (possible PII):`);
    for (const d of dirty) console.log(`  ${d}`);
    console.log('Clear them, or capture in a fresh profile. Values are never printed.');
    process.exit(1);
  }

  const html = await page.content();
  const { fields, hitl } = await scanFormWithFallback(page);

  writeFileSync(htmlPath, html);
  // The scan alongside it is the assertion target: a fixture whose field list
  // silently changes shape is a scanner regression, and this makes it visible.
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        capturedFrom: url,
        capturedAt: new Date().toISOString(),
        fieldCount: fields.length,
        requiredCount: fields.filter((f) => f.required).length,
        fields: fields.map((f) => ({ label: f.label, kind: f.kind, required: f.required })),
        hitl: hitl.length,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`recorded ${name}: ${fields.length} fields, ${fields.filter((f) => f.required).length} required`);
  console.log(`  ${htmlPath}`);
  console.log(`  ${metaPath}`);
} finally {
  await page.close().catch(() => {});
  await browser.close();
}
