import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'patchright';

import { prepareApplication, executeSpec } from '../src/index.ts';
import { loadProfile, loadAnswers } from '@apply-fleet/data';
import type { ResolveCtx } from '../src/index.ts';
import type { Application } from '@apply-fleet/shared';

const root = resolvePath(import.meta.dirname, '../../..');
const pick = (n: string) => {
  const real = resolvePath(root, `config/${n}.yml`);
  return existsSync(real) ? real : resolvePath(root, `config/${n}.example.yml`);
};
const ctx: ResolveCtx = { profile: loadProfile(pick('profile')), answers: loadAnswers(pick('answers')) };
const A = ctx.answers as unknown as Record<string, any>;

const dir = mkdtempSync(join(tmpdir(), 'apply-fleet-exec-'));
const resumePath = join(dir, 'r.pdf');
writeFileSync(resumePath, '%PDF-1.4\n%%EOF');

const fixtureUrl = (n: string) => pathToFileURL(resolvePath(import.meta.dirname, `fixtures/${n}.html`)).href;
const app = (over: Partial<Application>): Application => ({
  id: 'af_exec', company: 'Ramp', role: 'x', location: '', ats: 'ashby', applyUrl: '',
  postedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
  status: 'queued', matchScore: 0, updatedAt: new Date().toISOString(), ...over,
});

test('executeSpec replays a prepared spec; submits ONLY when armed', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // Prepare a real spec off the live fixture.
    const p1 = await browser.newPage();
    const { spec } = await prepareApplication(
      p1,
      app({ applyUrl: fixtureUrl('ashby') }),
      { ...ctx, resumePath, company: 'Ramp' },
    );
    await p1.close();
    assert.ok(spec.values.length > 0);

    // UNARMED: replays every field but never clicks submit.
    const p2 = await browser.newPage();
    const r2 = await executeSpec(p2, spec, { arm: false, resumePath });
    assert.ok(r2.filled > 0);
    assert.equal(r2.submitted, false);
    assert.equal(await p2.$eval('#name', (el: any) => el.value), A.identity.full_legal_name);
    assert.equal(await p2.$eval('#onsite_yes', (el: any) => el.getAttribute('data-selected')), '1'); // custom choice replayed
    assert.equal(await p2.$eval('#submit', (el: any) => el.getAttribute('data-clicked')), null); // NOT submitted
    await p2.close();

    // ARMED: fills, then clicks submit.
    const p3 = await browser.newPage();
    const r3 = await executeSpec(p3, spec, { arm: true, resumePath });
    assert.equal(r3.submitted, true);
    assert.equal(await p3.$eval('#submit', (el: any) => el.getAttribute('data-clicked')), '1');
    await p3.close();
  } finally {
    await browser.close();
  }
});
