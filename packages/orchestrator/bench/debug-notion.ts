/** Run the full prepare on ONE Notion Ashby form and print the error/stack —
 *  to diagnose why Notion forms started failing. Halts at submit. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'patchright';
import { loadProfile, loadAnswers } from '@apply-fleet/data';
import { prepareApplication, type ResolveCtx } from '@apply-fleet/worker';
import { loadResume, buildTailoredResume, type ResumeSource } from '@apply-fleet/resume';
import { discoverAll, type DiscoveryTarget } from '@apply-fleet/discovery';
import type { Application } from '@apply-fleet/shared';

const ROOT = resolve(import.meta.dirname, '../../..');
const cfg = (n: string) => {
  const r = resolve(ROOT, `config/${n}.yml`);
  return existsSync(r) ? r : resolve(ROOT, `config/${n}.example.yml`);
};

async function main() {
  const jobs = await discoverAll([{ ats: 'ashby', slug: 'notion', company: 'Notion' } as DiscoveryTarget], { maxAgeHours: 24 * 90, onError: () => {} });
  const url = jobs[0]?.applyUrl;
  console.log('URL:', url);
  const ctx: ResolveCtx = { profile: loadProfile(cfg('profile')), answers: loadAnswers(cfg('answers')) };
  const rs: ResumeSource | undefined = existsSync(resolve(ROOT, 'config/resume.yml')) ? loadResume(resolve(ROOT, 'config/resume.yml')) : undefined;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1700 });
  const app: Application = {
    id: 'dbg', company: 'Notion', role: jobs[0].role, location: jobs[0].location, ats: 'ashby',
    applyUrl: url, postedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
    status: 'queued', matchScore: 20, updatedAt: new Date().toISOString(),
  };
  try {
    let resumePath: string | undefined;
    if (rs) {
      const rp = await browser.newPage();
      try { resumePath = (await buildTailoredResume(rs, `${app.role} — Notion`, { page: rp })).path; }
      catch (e) { console.error('resume build failed:', e instanceof Error ? e.message : e); }
      finally { await rp.close().catch(() => {}); }
    }
    const r = await prepareApplication(page, app, { ...ctx, company: 'Notion', resumePath });
    console.log(`FILLED ${r.spec.values.length} · NEEDS YOU ${r.hitl.length}`);
    for (const f of r.resolved) console.log('  •', f.label, '→', JSON.stringify(f.value).slice(0, 60), `(${f.source})`);
    for (const h of r.hitl) console.log('  ?', h.question.slice(0, 80));
  } catch (e) {
    console.error('PREPARE THREW:', e instanceof Error ? (e.stack || e.message) : e);
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
