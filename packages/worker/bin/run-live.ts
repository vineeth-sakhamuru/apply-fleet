/**
 * Point the real Patchright engine at ONE live apply URL: navigate → scan →
 * resolve (grounded only) → fill → screenshot → report. NEVER clicks submit.
 * Usage: node bin/run-live.ts <applyUrl> <ats> <company>
 */
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { chromium } from 'patchright';
import { prepareApplication } from '../src/index.ts';
import type { ResolveCtx } from '../src/index.ts';
import type { Application, Ats } from '@apply-fleet/shared';
import { loadProfile, loadAnswers } from '@apply-fleet/data';

const url = process.argv[2] ?? 'https://jobs.ashbyhq.com/brainco/58cff031-5b0b-4b92-a1ea-2ebf2495d89d/application';
const ats = (process.argv[3] ?? 'ashby') as Ats;
const company = process.argv[4] ?? 'BrainCo';

const root = resolvePath(import.meta.dirname, '../../..');
const pick = (n: string) => {
  const real = resolvePath(root, `config/${n}.yml`);
  return existsSync(real) ? real : resolvePath(root, `config/${n}.example.yml`);
};
const ctx: ResolveCtx = { profile: loadProfile(pick('profile')), answers: loadAnswers(pick('answers')), company };

const app: Application = {
  id: 'af_live', company, role: 'live-test', location: '', ats, applyUrl: url,
  postedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
  status: 'queued', matchScore: 0, updatedAt: new Date().toISOString(),
};

const shot = process.env.SHOT ?? '/tmp/apply-fleet-live.png';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  const t0 = Date.now();
  const result = await prepareApplication(page, app, ctx);
  const ms = Date.now() - t0;

  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  console.log(`\n=== LIVE ENGINE: ${company} (${ats}) ===`);
  console.log(`url: ${url}`);
  console.log(`elapsed: ${ms} ms | fields scanned: ${result.spec.values.length + result.hitl.length}`);
  console.log(`\nFILLED grounded (${result.resolved.length}):`);
  for (const r of result.resolved) console.log(`  ${r.label.slice(0, 42).padEnd(42)} = ${String(r.value).slice(0, 40)}  [${r.source}]`);
  console.log(`\nROUTED TO HITL (${result.hitl.length}) — not guessed:`);
  for (const h of result.hitl) console.log(`  (${h.severity}) ${h.label.slice(0, 70)}`);
  console.log(`\nsubmit: never called — prepareApplication has no submit path ✓`);
  console.log(`screenshot: ${shot}`);
} finally {
  await browser.close();
}
