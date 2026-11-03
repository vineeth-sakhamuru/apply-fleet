/**
 * CONFIRM FLEET — run the REAL pipeline against the top-N live postings and
 * tally how many come out submit-ready with ZERO open questions. No early exit,
 * no cherry-picking: every candidate is prepared and classified honestly.
 *   READY     = fillable form, 0 HITL (fully grounded, halted at submit)
 *   NEEDS YOU = fillable form, >0 HITL (something genuinely couldn't be grounded)
 *   SKIP      = no fillable form at the URL (posting/login wall) — not counted
 * Never submits: the executor is never called.
 *
 *   node packages/orchestrator/bench/confirm-fleet.ts [N]
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
const N = Number(process.argv[2] || 6);

const cfg = (n: string) => {
  const real = resolve(ROOT, `config/${n}.yml`);
  return existsSync(real) ? real : resolve(ROOT, `config/${n}.example.yml`);
};

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

  console.log('=== discovery ===');
  const jobs = await discoverAll(TARGETS, {
    maxAgeHours: 24 * 60,
    onError: (t, e) => console.error('  discover FAIL', t.ats, t.slug, e instanceof Error ? e.message : e),
  });
  // One posting per company so the tally spans real ATS variety, not 6 Notion rows.
  const byScore = jobs
    .filter((j) => isEligible(j).eligible)
    .map((j) => ({ j, score: Math.round(relevanceScore(j.role) * 100) }))
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const picked: typeof byScore = [];
  for (const e of byScore) {
    if (seen.has(e.j.company)) continue;
    seen.add(e.j.company);
    picked.push(e);
    if (picked.length >= N) break;
  }
  // Backfill from remaining if fewer companies than N.
  if (picked.length < N) for (const e of byScore) { if (picked.length >= N) break; if (!picked.includes(e)) picked.push(e); }
  console.log(`  ${jobs.length} raw · ${byScore.length} eligible · preparing top ${picked.length}`);

  const candidates = picked.map((e) => toApp(e.j, e.score));
  const browser = await chromium.launch({ headless: true });
  let ready = 0, needsYou = 0, skip = 0;
  const rows: string[] = [];
  try {
    for (const app of candidates) {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 1700 });
      let resumePath: string | undefined;
      try {
        if (resumeSource) {
          const rp = await browser.newPage();
          try { resumePath = (await buildTailoredResume(resumeSource, `${app.role} — ${app.company}`, { page: rp })).path; }
          catch { /* resume optional; keep going */ }
          finally { await rp.close().catch(() => {}); }
        }
        const r = await prepareApplication(page, app, { ...ctx, company: app.company, resumePath });
        const fillable = r.spec.values.length;
        const noForm = r.hitl.some((h) => /No application form found/.test(h.question));
        if (fillable === 0 || noForm) {
          skip++;
          rows.push(`  SKIP      ${app.company} — ${app.role}  (no fillable form)`);
        } else if (r.hitl.length === 0) {
          ready++;
          rows.push(`  READY     ${app.company} — ${app.role}  (${fillable} fields, 0 open)`);
        } else {
          needsYou++;
          rows.push(`  NEEDS YOU ${app.company} — ${app.role}  (${fillable} fields, ${r.hitl.length} open)`);
          for (const h of r.hitl) rows.push(`              ? ${h.question.slice(0, 90)}`);
        }
      } catch (e) {
        needsYou++;
        rows.push(`  ERROR     ${app.company} — ${app.role}  (${e instanceof Error ? e.message : e})`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }

  const scored = ready + needsYou; // forms that actually had a fillable form
  console.log('\n=== results ===');
  for (const row of rows) console.log(row);
  console.log(`\n  READY ${ready} · NEEDS YOU ${needsYou} · SKIP ${skip}`);
  console.log(`  HANDS-OFF: ${ready}/${scored} fillable forms fully grounded${skip ? ` (+${skip} non-form URLs)` : ''}`);
  console.log('\n=== nothing submitted (executor never called) ===');
}

main().catch((e) => { console.error(e); process.exit(1); });
