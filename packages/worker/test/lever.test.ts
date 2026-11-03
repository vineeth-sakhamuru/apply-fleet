import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'patchright';
import { loadAnswers, loadProfile } from '@apply-fleet/data';
import { scanForm, resolve } from '../src/index.ts';
import type { FieldSpec, ResolveCtx } from '../src/index.ts';

const root = resolvePath(import.meta.dirname, '../../..');
// Hermetic: a committed fake persona, never the real (gitignored) config.
process.env.APPLY_FLEET_CONFIG_DIR = resolvePath(import.meta.dirname, 'fixtures/config');
const pick = (name: string) => resolvePath(process.env.APPLY_FLEET_CONFIG_DIR!, `${name}.yml`);
const ctx: ResolveCtx = { profile: loadProfile(pick('profile')), answers: loadAnswers(pick('answers')) };
const fixtureUrl = (name: string) =>
  pathToFileURL(resolvePath(import.meta.dirname, `fixtures/${name}.html`)).href;

const find = (fields: FieldSpec[], re: RegExp) => fields.filter((f) => re.test(f.label));

test('Lever custom cards: reads the card question, groups radios, collapses "check all"', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(fixtureUrl('lever'));
    const fields = await scanForm(page);

    // Work authorization — the opaque cards[uuid][field0] name is gone; the card
    // question is the label, options Yes/No.
    const auth = find(fields, /authoriz.*work|legally.*work/i);
    assert.equal(auth.length, 1, 'exactly one work-auth field');
    assert.ok(['radio', 'choice'].includes(auth[0].kind));
    assert.deepEqual((auth[0].options || []).map((o) => o.toLowerCase()).sort(), ['no', 'yes']);

    // Sponsorship — separate card, own group (so it can't inherit work-auth's answer).
    const spon = find(fields, /sponsor/i);
    assert.equal(spon.length, 1, 'exactly one sponsorship field');

    // "Check all that apply" — 8 checkboxes share one name → ONE field, 8 options.
    const langs = find(fields, /language/i);
    assert.equal(langs.length, 1, 'the 8 language checkboxes collapse to ONE field');
    assert.equal(langs[0].kind, 'choice');
    assert.equal((langs[0].options || []).length, 8);

    // Label bleed — status text stays out of the label.
    const loc = fields.find((f) => /current location/i.test(f.label));
    assert.ok(loc, 'location field present');
    assert.equal(loc!.label, 'Current location');

    // The whole point: work-auth + sponsorship now GROUND (were HITL before).
    const authRes = await resolve(auth[0], ctx);
    assert.equal(authRes.status, 'resolved');
    if (authRes.status === 'resolved') assert.equal(authRes.value, 'Yes');

    const sponRes = await resolve(spon[0], ctx);
    assert.equal(sponRes.status, 'resolved');
    if (sponRes.status === 'resolved') assert.equal(sponRes.value, 'No');
  } finally {
    await browser.close();
  }
});

test('Greenhouse scan is unchanged (no .application-question → no regression)', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(fixtureUrl('greenhouse'));
    const fields = await scanForm(page);
    assert.ok(find(fields, /first name/i).length >= 1, 'greenhouse first name still read');
    assert.ok(find(fields, /email/i).length >= 1, 'greenhouse email still read');
  } finally {
    await browser.close();
  }
});
