import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'patchright';

import { visionScanForm, scanFormWithFallback, parseMappings } from '../src/index.ts';
import type { VisionModel, VisionModelInput, VisionFieldMapping } from '../src/index.ts';

const fixtureUrl = (name: string) =>
  pathToFileURL(resolvePath(import.meta.dirname, `fixtures/${name}.html`)).href;

const freshCacheDir = () => mkdtempSync(join(tmpdir(), 'af-vis-'));

/**
 * Deterministic offline stub for the multimodal model. Maps the custom fixture's
 * marks by the accessible-name-ish `nearbyText` the tier extracted — proving the
 * tier feeds correct metadata and the label->selector mapping flows through. No
 * live key, no network. "Phone" is returned at low confidence to exercise HITL.
 */
const stubModel: VisionModel = async (input: VisionModelInput) => {
  const out: VisionFieldMapping[] = [];
  for (const el of input.elements) {
    const t = el.nearbyText.toLowerCase();
    if (t.includes('full name'))
      out.push({ mark: el.mark, label: 'Full Name', kind: 'text', required: true, confidence: 0.96 });
    else if (t.includes('email'))
      out.push({ mark: el.mark, label: 'Email Address', kind: 'email', required: true, confidence: 0.95 });
    else if (t.includes('why'))
      out.push({ mark: el.mark, label: 'Why do you want to work here?', kind: 'textarea', required: false, confidence: 0.9 });
    else if (t.includes('office'))
      out.push({ mark: el.mark, label: 'Preferred Office', kind: 'select', required: false, options: el.options, confidence: 0.88 });
    else if (t.includes('authorized'))
      out.push({ mark: el.mark, label: 'Authorized to work in the US?', kind: 'choice', required: true, options: el.options, confidence: 0.92 });
    else if (t.includes('phone'))
      out.push({ mark: el.mark, label: 'Phone', kind: 'tel', required: false, confidence: 0.3 }); // low -> HITL
  }
  return out;
};

const bySel = (fields: Array<{ label: string; selector: string }>, label: string) =>
  fields.find((f) => f.label === label);

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

test('vision tier discovers custom-form fields with correct label→selector mappings', async () => {
  const result = await withPage(fixtureUrl('custom'), (page) =>
    visionScanForm(page, { model: stubModel, cacheDir: freshCacheDir() }),
  );

  assert.equal(result.source, 'vision');
  assert.equal(result.modelCalled, true);

  const name = bySel(result.fields, 'Full Name');
  assert.ok(name, 'discovered Full Name');
  assert.equal(name!.selector, '#fld_name');
  assert.equal(name!.kind, 'text');
  assert.equal(name!.required, true);

  const email = bySel(result.fields, 'Email Address');
  assert.equal(email!.selector, '#fld_email');
  assert.equal(email!.kind, 'email');

  const why = bySel(result.fields, 'Why do you want to work here?');
  assert.equal(why!.selector, '#fld_why');
  assert.equal(why!.kind, 'textarea');

  const office = bySel(result.fields, 'Preferred Office');
  assert.equal(office!.selector, '#fld_office');
  assert.equal(office!.kind, 'select');

  const auth = result.fields.find((f) => f.label === 'Authorized to work in the US?');
  assert.equal(auth!.selector, '#fld_auth');
  assert.equal(auth!.kind, 'choice');
  assert.deepEqual(auth!.options, ['Yes', 'No']); // options captured from the div group
});

test('cache replays the mapping with ZERO model calls on the second encounter', async () => {
  const cacheDir = freshCacheDir();
  let calls = 0;
  const counting: VisionModel = async (input) => {
    calls += 1;
    return stubModel(input);
  };

  const first = await withPage(fixtureUrl('custom'), (page) =>
    visionScanForm(page, { model: counting, cacheDir }),
  );
  assert.equal(first.source, 'vision');
  assert.equal(calls, 1);

  // Second run, same cache dir + same form signature. The model MUST NOT be called.
  const throwIfCalled: VisionModel = async () => {
    throw new Error('model called on a cache hit');
  };
  const second = await withPage(fixtureUrl('custom'), (page) =>
    visionScanForm(page, { model: throwIfCalled, cacheDir }),
  );

  assert.equal(second.source, 'vision-cache');
  assert.equal(second.modelCalled, false);
  assert.equal(calls, 1, 'no second model call');
  assert.equal(second.fields.length, first.fields.length);
  assert.equal(bySel(second.fields, 'Full Name')!.selector, '#fld_name');
});

test('low-confidence / ambiguous fields are flagged for HITL, never mis-mapped', async () => {
  const result = await withPage(fixtureUrl('custom'), (page) =>
    visionScanForm(page, { model: stubModel, cacheDir: freshCacheDir() }),
  );

  // "Phone" came back at 0.3 confidence (< 0.6 default) — must NOT be a field.
  assert.equal(bySel(result.fields, 'Phone'), undefined);
  assert.ok(result.hitl.some((h) => /phone/i.test(h.label)), 'Phone routed to HITL');
});

test('keyless / model-unavailable → graceful empty result (routes to HITL)', async () => {
  const keyless: VisionModel = async () => null; // simulates no anthropic-api-key
  const result = await withPage(fixtureUrl('custom'), (page) =>
    visionScanForm(page, { model: keyless, cacheDir: freshCacheDir() }),
  );

  assert.equal(result.source, 'none');
  assert.equal(result.modelCalled, false);
  assert.equal(result.fields.length, 0);
  assert.ok(result.hitl.length > 0, 'a HITL note is surfaced');
});

test('scanFormWithFallback: DOM-readable form uses the DOM scan (no model call)', async () => {
  const throwIfCalled: VisionModel = async () => {
    throw new Error('vision tier invoked on a readable form');
  };
  const result = await withPage(fixtureUrl('greenhouse'), (page) =>
    scanFormWithFallback(page, { model: throwIfCalled, cacheDir: freshCacheDir() }),
  );
  assert.equal(result.source, 'dom');
  assert.ok(result.fields.length > 0);
});

test('scanFormWithFallback: near-empty custom form falls back to the vision tier', async () => {
  const result = await withPage(fixtureUrl('custom'), (page) =>
    scanFormWithFallback(page, { model: stubModel, cacheDir: freshCacheDir() }),
  );
  assert.equal(result.source, 'vision');
  assert.ok(bySel(result.fields, 'Full Name'), 'vision fields surfaced through the fallback');
});

test('parseMappings tolerates code fences and surrounding prose', () => {
  const text = 'Here you go:\n```json\n[{"mark":0,"label":"Name","kind":"text","required":true,"confidence":0.9}]\n```';
  const parsed = parseMappings(text);
  assert.ok(parsed);
  assert.equal(parsed!.length, 1);
  assert.equal(parsed![0].label, 'Name');
  assert.equal(parseMappings('no json here'), null);
});
