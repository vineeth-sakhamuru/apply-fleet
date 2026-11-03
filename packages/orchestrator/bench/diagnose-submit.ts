/** Why did an armed submit fail to confirm?
 *
 *  Replays the stored spec on the live form EXACTLY as the executor does, then
 *  stops right before the click and reports what the executor would have been
 *  looking at: which required fields the scan found, whether each got filled,
 *  which control findSubmit would click, and any validation the ATS is already
 *  showing. Never clicks — this is the safe half of the submit path.
 *
 *  usage: node packages/orchestrator/bench/diagnose-submit.ts <applicationId>
 */
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { chromium } from 'patchright';
import { openSqlite, SCHEMA, getReadySpec, getApplication, listByStatus, loadProfile, loadAnswers } from '@apply-fleet/data';
import { scanFormWithFallback, fillField, submitCandidates, pickSubmit, readValidationErrors, resolve as resolveField, type ResolveCtx } from '@apply-fleet/worker';

const cfg = (n: string): string => {
  const real = resolve(import.meta.dirname, `../../../config/${n}.yml`);
  return existsSync(real) ? real : resolve(import.meta.dirname, `../../../config/${n}.example.yml`);
};

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const id = process.argv[2];
const dbPath = process.env.APPLY_FLEET_DB ?? resolve(import.meta.dirname, '../../../data/live.db');
const db = openSqlite(dbPath);
await db.exec(SCHEMA);

if (!id) {
  console.log('pass an application id. ready apps:');
  for (const a of await listByStatus(db, 'ready')) console.log(`  ${a.id}  ${a.company} — ${a.role}`);
  process.exit(1);
}

const app = await getApplication(db, id);
if (!app) { console.log(`no app ${id}`); process.exit(1); }
// An app that never reached 'ready' has no stored spec — resolve its answers
// live instead, so the fields that BLOCKED it are exactly what we inspect.
let spec: any = await getReadySpec(db, id);
if (!spec) spec = { url: app.applyUrl, values: [], live: true };
console.log(`${app.company} — ${app.role}  [${app.ats}]${spec.live ? '  (live resolve — no stored spec)' : ''}\n${spec.url}\n`);

const outDir = resolve(import.meta.dirname, '../../../data/previews');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input,select,textarea', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const byLabel = new Map(spec.values.map((v: any) => [norm(v.label), v]));
  const { fields } = await scanFormWithFallback(page);
  if (spec.live) {
    const ctx: ResolveCtx = { profile: loadProfile(cfg('profile')), answers: loadAnswers(cfg('answers')) };
    for (const f of fields) {
      const r = await resolveField(f, ctx);
      if (r.status === 'resolved') byLabel.set(norm(f.label), { label: f.label, value: r.value });
    }
  }
  console.log(`FIELDS (${fields.length} scanned, ${fields.filter((f) => f.required).length} required)`);
  for (const f of fields) {
    if (f.kind === 'file') { console.log(`  ${f.required ? 'REQ' : '   '} [file] ${f.label}`); continue; }
    const v: any = byLabel.get(norm(f.label));
    if (!v) { console.log(`  ${f.required ? 'REQ' : '   '} [${f.kind}] ${f.label} — NOT IN SPEC`); continue; }
    const ok = await fillField(page, f, v.value);
    console.log(`  ${f.required ? 'REQ' : '   '} [${f.kind}] ${f.label} = ${String(v.value).slice(0, 40)} ${ok ? '' : '<< FILL FAILED'}`);
  }

  // What the executor would click, and what it deliberately refuses to.
  await page.waitForTimeout(800);
  const cands = await submitCandidates(page);
  const pick = pickSubmit(cands);
  console.log(`\nSUBMIT CANDIDATES (${cands.length} visible controls)`);
  cands.forEach((c, i) => {
    const mark = i === pick ? '>>' : '  ';
    console.log(`  ${mark} [${i}] "${c.text.slice(0, 40)}" type=${c.type} disabled=${c.disabled} cls=${c.cls.slice(0, 40)}`);
  });
  console.log(pick == null ? '\n  NO trustworthy submit control' : `\n  would click [${pick}] "${cands[pick].text}"`);

  const errs = await readValidationErrors(page);
  console.log(`\nVALIDATION ON PAGE (${errs.length})`);
  for (const e of errs) console.log(`  • ${e.replace(/\s+/g, ' ').slice(0, 120)}`);

  const shot = join(outDir, `${id}-diagnose.png`);
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`\nfilled form: ${shot}`);
} finally {
  await page.close().catch(() => {});
  await browser.close();
}
