import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'patchright';

import { axScanForm, scanFormWithFallback } from '../src/index.ts';

/**
 * An AX-only form: every control is an ARIA-role widget (contenteditable
 * role="textbox", a role="listbox") with NO native <input>/<select> and no
 * Ashby/radiogroup container. The DOM scanner (input,select,textarea + custom
 * choice-group loop) under-reads it to zero fields; the accessibility tree sees
 * all three. `aria-required` proves the required flag flows through.
 */
const AX_ONLY_HTML = `<!doctype html><html><body>
  <div role="textbox" id="ax_name" aria-label="Full Name" aria-required="true" contenteditable="true"></div>
  <div role="textbox" id="ax_email" aria-label="Email Address" contenteditable="true"></div>
  <div role="listbox" id="ax_office" aria-label="Preferred Office">
    <div role="option">New York</div>
    <div role="option">San Francisco</div>
  </div>
</body></html>`;

const axOnlyUrl = 'data:text/html,' + encodeURIComponent(AX_ONLY_HTML);
const fixtureUrl = (name: string) =>
  pathToFileURL(resolvePath(import.meta.dirname, `fixtures/${name}.html`)).href;

async function withPage<T>(url: string, fn: (page: import('patchright').Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test('axScanForm reads ARIA controls the DOM scan misses, with working selectors', async () => {
  await withPage(axOnlyUrl, async (page) => {
    const fields = await axScanForm(page);
    const by = (label: string) => fields.find((f) => f.label === label);

    const name = by('Full Name');
    assert.ok(name, 'discovered Full Name');
    assert.equal(name!.kind, 'text');
    assert.equal(name!.selector, '#ax_name');
    assert.equal(name!.required, true);

    const email = by('Email Address');
    assert.ok(email, 'discovered Email Address');
    assert.equal(email!.kind, 'text');
    assert.equal(email!.selector, '#ax_email');
    assert.equal(email!.required, false);

    const office = by('Preferred Office');
    assert.ok(office, 'discovered Preferred Office');
    assert.equal(office!.kind, 'select');
    assert.equal(office!.selector, '#ax_office');
    assert.deepEqual(office!.options, ['New York', 'San Francisco']);

    // Every emitted selector must resolve to exactly one live element.
    for (const f of fields) {
      const count = await page.$$eval(f.selector, (els) => els.length);
      assert.equal(count, 1, `selector ${f.selector} for "${f.label}" resolves to one element`);
    }
  });
});

test('scanFormWithFallback: DOM-readable form reports source "dom"', async () => {
  const result = await withPage(fixtureUrl('greenhouse'), (page) => scanFormWithFallback(page));
  assert.equal(result.source, 'dom');
  assert.ok(result.fields.length > 0);
});

test('scanFormWithFallback: AX-only form reports source "ax" (before vision)', async () => {
  // If AX ever fails to read, vision would run — so stub the model to throw,
  // guaranteeing the "ax" source came from the AX tier, not vision.
  const throwIfVision = async () => {
    throw new Error('vision tier invoked on an AX-readable form');
  };
  const result = await withPage(axOnlyUrl, (page) =>
    scanFormWithFallback(page, { model: throwIfVision }),
  );
  assert.equal(result.source, 'ax');
  assert.ok(result.fields.find((f) => f.label === 'Full Name'), 'AX fields surfaced through the fallback');
  assert.ok(result.fields.find((f) => f.label === 'Preferred Office'));
});
