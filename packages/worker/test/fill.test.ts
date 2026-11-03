import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'patchright';
import { loadAnswers, loadProfile } from '@apply-fleet/data';
import { prepareApplication, GROUNDED } from '../src/index.ts';
import type { Application } from '@apply-fleet/shared';
import type { ResolveCtx } from '../src/index.ts';

// Hermetic: this suite exercises the DETERMINISTIC fill pipeline and must never
// make a live model call — even when a real provider key sits in the Keychain.
// The LLM tier's live drafting is proven separately by the live-pass sweep.
process.env.APPLY_FLEET_NO_LLM = '1';

const root = resolvePath(import.meta.dirname, '../../..');
const pick = (name: string) => {
  const real = resolvePath(root, `config/${name}.yml`);
  return existsSync(real) ? real : resolvePath(root, `config/${name}.example.yml`);
};
const ctx: ResolveCtx = {
  profile: loadProfile(pick('profile')),
  answers: loadAnswers(pick('answers')),
};
const A = ctx.answers as unknown as Record<string, any>;

// A throwaway résumé file to prove the upload path.
const dir = mkdtempSync(join(tmpdir(), 'apply-fleet-'));
const resumePath = join(dir, 'vineeth-backend-distributed.pdf');
writeFileSync(resumePath, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

const fixtureUrl = (name: string) =>
  pathToFileURL(resolvePath(import.meta.dirname, `fixtures/${name}.html`)).href;

const app = (over: Partial<Application>): Application => ({
  id: 'af_test',
  company: 'Notion',
  role: 'New Grad Software Engineer',
  location: 'San Francisco, CA',
  ats: 'greenhouse',
  applyUrl: '',
  postedAt: new Date().toISOString(),
  discoveredAt: new Date().toISOString(),
  status: 'queued',
  matchScore: 85,
  updatedAt: new Date().toISOString(),
  ...over,
});

test('fills a Greenhouse form end-to-end, grounded, and halts at submit', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const result = await prepareApplication(
      page,
      app({ applyUrl: fixtureUrl('greenhouse') }),
      { ...ctx, resumePath, company: 'Notion' },
    );

    const val = (sel: string) => page.$eval(sel, (el: any) => el.value);
    const selText = (sel: string) =>
      page.$eval(sel, (el: any) => el.options[el.selectedIndex].textContent.trim());

    // text fields
    assert.equal(await val('#first_name'), A.identity.first_name);
    assert.equal(await val('#email'), A.contact.email);

    // React-safe fill: controlled input's state mirror updated (events fired)
    assert.equal(
      await page.$eval('#first_name', (el: any) => el.dataset.state),
      A.identity.first_name,
    );

    // selects
    assert.equal(await selText('#work_auth'), 'Yes');
    assert.equal(await selText('#sponsorship'), 'No');

    // EEO fills from the user's own confirmed self-ID (never guessed)
    assert.match(await selText('#eeo_gender'), /^male$/i);
    assert.match(await selText('#eeo_race'), /^asian$/i);
    assert.match(await selText('#eeo_veteran'), /not a protected veteran/i);
    assert.match(await selText('#eeo_disability'), /do not have a disability/i);

    // résumé attached
    const files = await page.$eval('#resume', (el: any) =>
      [...el.files].map((f: any) => f.name),
    );
    assert.equal(files.length, 1);
    assert.equal(files[0], 'vineeth-backend-distributed.pdf');

    // never clicked submit (DOM attribute stays absent)
    assert.equal(await page.$eval('#submit_app', (el: any) => el.getAttribute('data-clicked')), null);

    // zero ungrounded values
    for (const rf of result.resolved) {
      assert.ok(GROUNDED.has(rf.source), `${rf.label} source "${rf.source}" is ungrounded`);
    }

    // open-ended "why" routed to HITL, not guessed
    assert.ok(result.hitl.some((h) => /why/i.test(h.label)));

    // replayable spec is well-formed
    assert.ok(result.spec.values.length > 0);
    assert.ok(result.spec.submitSelector);
  } finally {
    await browser.close();
  }
});

test('fills an Ashby form (single Name field) and halts at submit', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const result = await prepareApplication(
      page,
      app({ company: 'Ramp', ats: 'ashby', applyUrl: fixtureUrl('ashby') }),
      { ...ctx, resumePath, company: 'Ramp' },
    );

    const val = (sel: string) => page.$eval(sel, (el: any) => el.value);
    const selText = (sel: string) =>
      page.$eval(sel, (el: any) => el.options[el.selectedIndex].textContent.trim());

    assert.equal(await val('#name'), A.identity.full_legal_name);
    assert.equal(await val('#email'), A.contact.email);
    assert.equal(await selText('#auth'), 'Yes');
    assert.equal(await selText('#sponsor'), 'No');
    assert.match(await selText('#eeo_gender'), /^man$/i); // "Male" → "Man" via synonym

    // Custom (non-native) choice group: the scanner must see the Yes/No <button>
    // group and the engine must click the grounded option. Coverage regression.
    assert.equal(await page.$eval('#onsite_yes', (el: any) => el.getAttribute('data-selected')), '1');
    assert.equal(await page.$eval('#onsite_no', (el: any) => el.getAttribute('data-selected')), null);

    const files = await page.$eval('#resume', (el: any) => el.files.length);
    assert.equal(files, 1);
    assert.equal(await page.$eval('#submit', (el: any) => el.getAttribute('data-clicked')), null);

    for (const rf of result.resolved) {
      assert.ok(GROUNDED.has(rf.source), `${rf.label} source "${rf.source}" is ungrounded`);
    }
  } finally {
    await browser.close();
  }
});

test('a job POSTING page is never "ready" — it has no identity fields', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const result = await prepareApplication(
      page,
      app({ applyUrl: fixtureUrl('posting-page'), company: 'Samsara' }),
      { ...ctx, resumePath, company: 'Samsara' },
    );
    // Two optional region selects and zero required fields used to sail through
    // every gate. Then the submit finder would click "Apply Now" — a link — and
    // the vanished button would read as a confirmed submit. A false receipt.
    assert.ok(result.hitl.length > 0, 'a posting page must stop, not report ready');
    assert.match(result.hitl[0].question, /No application form found/);
    assert.equal(result.spec.values.length, 0, 'nothing should be prepared from a posting page');
  } finally {
    await page.close();
    await browser.close();
  }
});
