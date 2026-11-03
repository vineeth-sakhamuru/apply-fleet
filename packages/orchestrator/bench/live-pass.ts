/**
 * LIVE PASS — controlled end-to-end sanity check. Runs the REAL pipeline against
 * live postings: discover → eligibility/score → build tailored PDF → navigate a
 * real ATS form → fill every grounded field → HALT AT SUBMIT. It NEVER calls the
 * executor, so nothing is ever submitted. Dumps what got filled and screenshots
 * the filled form for human review.
 *
 *   node packages/orchestrator/bench/live-pass.ts
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'patchright';
import { loadProfile, loadAnswers } from '@apply-fleet/data';
import { prepareApplication } from '@apply-fleet/worker';
import type { ResolveCtx } from '@apply-fleet/worker';
import { discoverAll, type DiscoveryTarget } from '@apply-fleet/discovery';
import { isEligible, relevanceScore } from '@apply-fleet/matching';
import { loadResume, buildTailoredResume, type ResumeSource } from '@apply-fleet/resume';
import type { Application } from '@apply-fleet/shared';

const ROOT = resolve(import.meta.dirname, '../../..');
const SHOT = resolve(ROOT, 'data/live-fill.png');

const cfg = (n: string) => {
  const real = resolve(ROOT, `config/${n}.yml`);
  return existsSync(real) ? real : resolve(ROOT, `config/${n}.example.yml`);
};

// Same live boards the server polls.
const TARGETS: DiscoveryTarget[] = [
  { ats: 'ashby', slug: 'notion', company: 'Notion' },
  { ats: 'ashby', slug: 'ramp', company: 'Ramp' },
  { ats: 'ashby', slug: 'linear', company: 'Linear' },
  { ats: 'lever', slug: 'palantir', company: 'Palantir' },
  { ats: 'greenhouse', slug: 'stripe', company: 'Stripe' },
];

const toApp = (j: {
  company: string; role: string; location: string; ats: Application['ats']; applyUrl: string; postedAt: string;
}, score: number): Application => ({
  id: `live_${Math.random().toString(36).slice(2, 8)}`,
  company: j.company, role: j.role, location: j.location, ats: j.ats,
  applyUrl: j.applyUrl, postedAt: j.postedAt,
  discoveredAt: new Date().toISOString(), status: 'queued',
  matchScore: score, updatedAt: new Date().toISOString(),
});

async function main() {
  const ctx: ResolveCtx = { profile: loadProfile(cfg('profile')), answers: loadAnswers(cfg('answers')) };
  const resumeCfg = resolve(ROOT, 'config/resume.yml');
  const resumeSource: ResumeSource | undefined = existsSync(resumeCfg) ? loadResume(resumeCfg) : undefined;

  console.log('=== PHASE A: live discovery ===');
  const jobs = await discoverAll(TARGETS, {
    maxAgeHours: 24 * 60,
    onError: (t, e) => console.error('  discover FAIL', t.ats, t.slug, e instanceof Error ? e.message : e),
  });
  console.log(`  raw jobs discovered: ${jobs.length}`);
  const eligible = jobs
    .filter((j) => isEligible(j).eligible)
    .map((j) => ({ j, score: Math.round(relevanceScore(j.role) * 100) }))
    .sort((a, b) => b.score - a.score);
  console.log(`  eligible SWE/US roles: ${eligible.length}`);
  for (const { j, score } of eligible.slice(0, 8)) {
    console.log(`   [${score}] ${j.company} — ${j.role} (${j.ats}) ${j.applyUrl}`);
  }

  const candidates = eligible.length
    ? eligible.map((e) => toApp(e.j, e.score))
    : [];
  if (!candidates.length) {
    console.log('\n  no eligible live postings right now — cannot run a fill pass. Stopping.');
    return;
  }

  console.log('\n=== PHASE B: fill a real form, HALT AT SUBMIT ===');
  const browser = await chromium.launch({ headless: true });
  try {
    let bestHitl = Infinity;
    let bestLabel = '';
    for (const app of candidates.slice(0, 10)) {
      console.log(`\n  → ${app.company} — ${app.role}\n    ${app.applyUrl}`);
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 1700 });
      let resumePath: string | undefined;
      try {
        if (resumeSource) {
          const rp = await browser.newPage();
          try {
            const built = await buildTailoredResume(resumeSource, `${app.role} — ${app.company}`, { page: rp });
            resumePath = built.path;
          } catch (e) {
            console.error('    resume build failed:', e instanceof Error ? e.message : e);
          } finally {
            await rp.close().catch(() => {});
          }
        }
        const result = await prepareApplication(page, app, { ...ctx, company: app.company, resumePath });
        const fillable = result.spec.values.length;
        const noForm = result.hitl.some((h) => /No application form found/.test(h.question));
        if (fillable === 0 || noForm) {
          console.log(`    skipped: ${noForm ? 'no fillable form at URL' : 'zero fields resolved'}`);
          await page.close().catch(() => {});
          continue;
        }
        const hitlN = result.hitl.length;
        console.log(`    FILLED ${fillable} fields · NEEDS YOU ${hitlN}`);
        // Keep the cleanest form's screenshot — fewest open questions is closest
        // to a submit-ready 'ready'. Zero HITL IS a clean ready → stop there.
        if (hitlN < bestHitl) {
          bestHitl = hitlN;
          bestLabel = `${app.company} — ${app.role}`;
          for (const r of result.resolved) console.log(`      • ${r.label}: ${JSON.stringify(r.value)}  (${r.source})`);
          if (hitlN) for (const h of result.hitl) console.log(`      ? ${h.question}  [${h.severity}]`);
          await page.screenshot({ path: SHOT, fullPage: true });
          console.log(`    ★ new best (${hitlN} open) → ${SHOT}`);
        }
        await page.close().catch(() => {});
        if (hitlN === 0) { console.log('\n  CLEAN READY — every field grounded, halted at submit.'); break; }
      } catch (e) {
        console.error('    prepare error:', e instanceof Error ? e.message : e);
        await page.close().catch(() => {});
      }
    }
    if (bestHitl === Infinity) console.log('\n  no candidate yielded a fillable form this run.');
    else console.log(`\n  BEST: ${bestLabel} — ${bestHitl} open question(s)${bestHitl === 0 ? '  ✅ CLEAN READY' : ''}`);
  } finally {
    await browser.close();
  }
  console.log('\n=== DONE — nothing was submitted (executor never called) ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
