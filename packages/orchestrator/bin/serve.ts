import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openSqlite, SCHEMA, migrate, loadProfile, loadAnswers, loadTargets } from '@apply-fleet/data';
import type { Application } from '@apply-fleet/shared';
import { prepareApplication, executeSpec } from '@apply-fleet/worker';
import type { PrepareResult, ReadySpec, ResolveCtx } from '@apply-fleet/worker';
import { discoverAll, fetchEightfold, type DiscoveryTarget } from '@apply-fleet/discovery';
import { isEligible, relevanceScore } from '@apply-fleet/matching';
import { loadResume, buildTailoredResume, type ResumeSource } from '@apply-fleet/resume';
import { Orchestrator, SubmitBlocked, start, type DiscoveredInput } from '../src/index.ts';
import { rephraseBullet } from '../src/rephrase.ts';

/**
 * Runnable orchestrator + API/SSE server.
 *
 * DEMO mode (default): real event store, real orchestrator, real SSE — but a
 * fast in-process `prepare` stands in for the browser fleet, so the dashboard
 * shows live data flowing without launching Chromium. Set APPLY_FLEET_REAL=1 to
 * wire the real Patchright worker (prepareApplication) into the same seam.
 */

const dbPath =
  process.env.APPLY_FLEET_DB ??
  resolve(import.meta.dirname, '../../../data/demo.db');
mkdirSync(dirname(dbPath), { recursive: true });

// Filled-form previews live next to the db, keyed by application id, so the
// dashboard can serve one by id with no extra schema. These PNGs show the form
// with real PII in it — local-only (loopback server) and gitignored.
const PREVIEW_DIR = resolve(dirname(dbPath), 'previews');

const db = openSqlite(dbPath);
await db.exec(SCHEMA);
// SCHEMA is CREATE-IF-NOT-EXISTS, so a column added to an existing table never
// reaches a database that already exists. Migrations run every boot; additive
// and idempotent, so this needs no operator step.
const migrated = await migrate(db);
if (migrated.length) console.log(`schema: applied ${migrated.join(', ')}`);

const RESUME_VARIANTS = ['backend-distributed', 'fullstack', 'frontend-systems', 'ml-infra'];

const demoPrepare = async (app: Application): Promise<PrepareResult> => {
  await new Promise((r) => setTimeout(r, 300));
  const variant = RESUME_VARIANTS[Math.floor(Math.random() * RESUME_VARIANTS.length)];
  const resolved = [
    { label: 'Full name', value: 'Vineeth Sakhamuru', source: 'answers' as const },
    { label: 'Email', value: 'you@example.com', source: 'answers' as const },
    { label: 'Work authorization', value: 'U.S. Permanent Resident', source: 'answers' as const },
    { label: 'Requires sponsorship', value: 'No', source: 'answers' as const },
    { label: `Why ${app.company}?`, value: '(declined)', source: 'you' as const },
  ];
  const spec: ReadySpec = {
    applicationId: app.id,
    url: app.applyUrl,
    resumePath: `resume/${variant}.pdf`,
    submitSelector: 'button[type="submit"]',
    values: resolved.map((r, i) => ({ label: r.label, selector: `#f${i}`, kind: 'text', value: r.value, source: r.source })),
  };
  const hitl =
    Math.random() < 0.18
      ? [{ label: 'Earliest start date?', question: `${app.company} asks: earliest start date?`, severity: 'quick' as const }]
      : [];
  return { spec, resolved, hitl };
};

const demoExecute = async () => {
  await new Promise((r) => setTimeout(r, 500));
};

const SEED_DEMO: DiscoveredInput[] = [
  ['Stripe', 'New Grad SWE, Backend', 'Seattle, WA', 'greenhouse', 91],
  ['Ramp', 'Software Engineer, New Grad', 'New York, NY', 'ashby', 88],
  ['Notion', 'New Grad Software Engineer', 'San Francisco, CA', 'greenhouse', 85],
  ['Linear', 'Software Engineer, New Grad', 'Remote (US)', 'ashby', 87],
  ['Databricks', 'Software Engineer, University Grad', 'Mountain View, CA', 'greenhouse', 84],
  ['Figma', 'New Grad Product Engineer', 'San Francisco, CA', 'greenhouse', 82],
  ['Airbnb', 'Software Engineer, New Grad', 'San Francisco, CA', 'greenhouse', 81],
  ['Plaid', 'New Grad Software Engineer', 'San Francisco, CA', 'greenhouse', 80],
  ['Coinbase', 'New Grad Software Engineer', 'Remote (US)', 'greenhouse', 78],
  ['Reddit', 'New Grad SWE, Backend', 'Remote (US)', 'greenhouse', 75],
].map(([company, role, location, ats, matchScore], i) => ({
  company: String(company),
  role: String(role),
  location: String(location),
  ats: ats as Application['ats'],
  matchScore: Number(matchScore),
  applyUrl: `https://example.test/${company}/${i}`,
  postedAt: new Date(Date.now() - i * 12 * 60_000).toISOString(),
}));

// Real apply URLs — actual fillable ATS forms — used only in REAL mode.
const REAL_SEED: DiscoveredInput[] = [
  { company: 'BrainCo', role: 'Machine Learning Engineer, Applied AI', location: 'San Francisco Bay Area', ats: 'ashby', matchScore: 82, applyUrl: 'https://jobs.ashbyhq.com/brainco/58cff031-5b0b-4b92-a1ea-2ebf2495d89d/application', postedAt: new Date().toISOString() },
  { company: 'Notion', role: 'Software Engineer, Early Career', location: 'San Francisco, CA', ats: 'ashby', matchScore: 85, applyUrl: 'https://jobs.ashbyhq.com/notion/297b4ece-765f-4eea-b1b8-46057cb6501f/application', postedAt: new Date().toISOString() },
  { company: 'Ramp', role: 'Software Engineer Intern, Android', location: 'New York, NY', ats: 'ashby', matchScore: 68, applyUrl: 'https://jobs.ashbyhq.com/ramp/67fadb77-43d8-4449-954b-d4cf2c6d3b8b/application', postedAt: new Date().toISOString() },
  { company: 'Palantir', role: 'Forward Deployed Software Engineer, Internship', location: 'Remote (US)', ats: 'lever', matchScore: 80, applyUrl: 'https://jobs.lever.co/palantir/d5486403-c050-4920-b2e0-91b69b61ebb2/apply', postedAt: new Date().toISOString() },
];



// Which boards to poll is DATA, not source — see config/targets.yml. This was
// five slugs hardcoded here, which capped the product's coverage at whatever
// someone had typed into this file.
const targetsPath = existsSync(resolve(import.meta.dirname, '../../../config/targets.yml'))
  ? resolve(import.meta.dirname, '../../../config/targets.yml')
  : resolve(import.meta.dirname, '../../../config/targets.example.yml');
const TARGETS = loadTargets(targetsPath);
const DISCOVERY_TARGETS: DiscoveryTarget[] = TARGETS.boards as DiscoveryTarget[];
const EIGHTFOLD_TARGETS = TARGETS.eightfold;

const REAL = !!process.env.APPLY_FLEET_REAL;
const ARM = !!process.env.APPLY_FLEET_ARM_SUBMIT;
// Hands-free submit is the PRODUCT DEFAULT: a fully-prepared application
// ('ready' = every field grounded, no open questions, a real submit control
// found) advances to submit without a human click. Opt OUT with
// APPLY_FLEET_AUTO_SUBMIT=0 to stage everything for review instead.
//
// ARM stays a separate, explicit switch and is NOT defaulted on: auto-submit
// decides the product's stance, ARM decides whether this machine may actually
// file irreversible applications. Auto without arm is the built-in dry run —
// it logs every application it WOULD file and touches nothing.
const AUTO_SUBMIT = process.env.APPLY_FLEET_AUTO_SUBMIT !== '0';

// Eightfold discovery needs a real browser (client-rendered board). Hold the
// fleet's browser so the discovery cycle can borrow a page instead of launching
// a second Chromium.
let sharedBrowser: { newPage: () => Promise<any> } | null = null;

let prepare: (app: Application) => Promise<PrepareResult> = demoPrepare;
let execute: (spec: ReadySpec) => Promise<void> = demoExecute;
let seed = SEED_DEMO;

if (REAL) {
  const { chromium } = await import('patchright');
  const cfg = (n: string) => {
    const real = resolve(import.meta.dirname, `../../../config/${n}.yml`);
    return existsSync(real) ? real : resolve(import.meta.dirname, `../../../config/${n}.example.yml`);
  };
  const ctx: ResolveCtx = { profile: loadProfile(cfg('profile')), answers: loadAnswers(cfg('answers')) };
  const browser = await chromium.launch({ headless: true });
  sharedBrowser = browser;
  process.on('SIGINT', () => { browser.close().finally(() => process.exit(0)); });

  // Per-JD tailored résumé — ONLY if a real source is seeded. Never fabricate:
  // with no config/resume.yml, applications simply halt at the upload field.
  const resumeCfgPath = resolve(import.meta.dirname, '../../../config/resume.yml');
  const resumeSource: ResumeSource | undefined = existsSync(resumeCfgPath) ? loadResume(resumeCfgPath) : undefined;
  if (!resumeSource) console.log('resume: config/resume.yml not seeded — no résumé attached (halts at upload)');

  prepare = async (app) => {
    const page = await browser.newPage();
    let resumePath: string | undefined;
    try {
      if (resumeSource) {
        // Render the tailored PDF on its own page (Chromium print — no LaTeX),
        // so it never disturbs the application form page.
        const rpage = await browser.newPage();
        try {
          // reword: per-JD bullet rewording via the free provider chain. Every
          // rewrite is gated by the no-fabrication verifier; a rejected one (or
          // no API key, or APPLY_FLEET_NO_LLM) falls back to the verbatim source
          // bullet, so this can only change wording, never claims.
          // The real JD when discovery captured one. Passing just the title
          // matched almost no keywords, so the per-JD rewording never fired and
          // every résumé silently fell back to verbatim source bullets.
          const jdText = app.description
            ? `${app.role} — ${app.company}\n\n${app.description}`
            : `${app.role} — ${app.company}`;
          const built = await buildTailoredResume(resumeSource, jdText, {
            page: rpage,
            reword: true,
            rephrase: rephraseBullet,
          });
          resumePath = built.path;
        } catch (e) {
          console.error('resume build failed for', app.company, e instanceof Error ? e.message : e);
        } finally {
          await rpage.close().catch(() => {});
        }
      }
      return await prepareApplication(page, app, {
        ...ctx,
        company: app.company,
        resumePath,
        previewDir: PREVIEW_DIR,
      });
    } finally {
      await page.close().catch(() => {});
    }
  };
  execute = async (spec) => {
    const page = await browser.newPage();
    try {
      // Post-click evidence lands next to the pre-submit preview, so the drawer
      // can show "what we filled" and "what happened when we clicked" together.
      mkdirSync(PREVIEW_DIR, { recursive: true });
      const r = await executeSpec(page, spec, {
        arm: ARM,
        evidencePath: join(PREVIEW_DIR, `${spec.applicationId}-submit.png`),
      });
      // Refuse to record a submit that didn't really land. Each of these leaves
      // the app OUT of 'submitted' so a human can look — never a false receipt.
      // These two DECLINED to submit on purpose — the application is still good,
      // so SubmitBlocked sends it back to 'ready' instead of burning it as failed.
      if (r.incomplete.length) {
        throw new SubmitBlocked(
          `did NOT submit — ${r.incomplete.length} required field(s) unfilled on replay (${r.incomplete.slice(0, 3).join(', ')}). The form likely changed since prepare; re-prepare it.`,
        );
      }
      if (!r.submitted) {
        throw new SubmitBlocked(
          'submit not armed — filled but did NOT submit. Set APPLY_FLEET_ARM_SUBMIT=1 to file a real application (human click + arm flag both required).',
        );
      }
      if (!r.confirmed) {
        // Say WHY, not just "no confirmation". The ATS's own validation text is
        // the actionable part; the screenshot is the proof.
        const why = r.errors?.length ? ` The form is showing: ${r.errors.slice(0, 3).join(' · ')}.` : '';
        throw new Error(
          `submit clicked but NO confirmation detected — treating as NOT submitted.${why} Post-click screenshot: ${r.evidencePath ?? 'none'}. Check it before retrying (guards against a silent failed submit).`,
        );
      }
    } finally {
      await page.close().catch(() => {});
    }
  };
}

const orch = new Orchestrator({ db, prepare, execute, concurrency: REAL ? 2 : 3 });

await orch.resume();

// REAL discovery: poll live ATS feeds, keep only eligible SWE/US roles, score
// by lexical relevance, and hand them to the orchestrator. Returns count added.
async function realDiscoveryCycle(): Promise<number> {
  const jobs = await discoverAll(DISCOVERY_TARGETS, {
    maxAgeHours: TARGETS.settings.maxAgeHours,
    concurrency: TARGETS.settings.concurrency,
    onError: (t, e) => console.error('discover', t.ats, t.slug, e instanceof Error ? e.message : e),
  });

  // Self-hosted Eightfold boards (Microsoft et al.) never appear in the
  // third-party ATS feeds above, so they get their own browser-driven pass —
  // without it the fleet is structurally blind to some of the biggest
  // employers. Per-board failures are isolated so one dead board can't sink
  // the cycle.
  if (sharedBrowser) {
    for (const t of EIGHTFOLD_TARGETS) {
      const page = await sharedBrowser.newPage();
      try {
        const found = await fetchEightfold(page, t);
        jobs.push(...found);
        console.log(`discover eightfold ${t.company}: ${found.length} roles`);
      } catch (e) {
        console.error('discover eightfold', t.company, e instanceof Error ? e.message : e);
      } finally {
        await page.close().catch(() => {});
      }
    }
  }

  const inputs: DiscoveredInput[] = jobs
    .filter((j) => isEligible(j).eligible)
    .map((j) => ({
      company: j.company,
      role: j.role,
      location: j.location,
      ats: j.ats,
      applyUrl: j.applyUrl,
      postedAt: j.postedAt,
      matchScore: Math.round(relevanceScore(j.role) * 100),
      description: j.description,
    }));
  return orch.discover(inputs);
}

if (REAL) {
  const added = await realDiscoveryCycle().catch((e) => {
    console.error('initial discovery failed', e);
    return 0;
  });
  console.log(`discovery: ${added} eligible roles from ${DISCOVERY_TARGETS.length} boards`);
  if (added === 0 && (await orch.snapshot()).applications.length === 0) {
    console.log('discovery empty — falling back to known apply URLs');
    await orch.discover(REAL_SEED);
  }
  // Re-poll for freshness.
  setInterval(() => realDiscoveryCycle().catch((e) => console.error('discovery', e)), TARGETS.settings.pollMinutes * 60_000);
} else if ((await orch.snapshot()).applications.length === 0) {
  await orch.discover(seed);
}

setInterval(() => {
  orch.runPipeline().catch((e) => console.error('pipeline', e));
}, REAL ? 4000 : 2500);

// Hands-free auto-submit loop. ON by default (the product stance); opt out
// with APPLY_FLEET_AUTO_SUBMIT=0. Without APPLY_FLEET_ARM_SUBMIT this is a DRY
// RUN: it logs 'would submit <id>' once per app and files nothing. Only with
// ARM set does it actually file — and every path goes through orch.submit(),
// which is exactly-once.
if (AUTO_SUBMIT) {
  const dryLogged = new Set<string>();
  setInterval(() => {
    orch
      .autoSubmitReady({
        log: (m) => {
          if (dryLogged.has(m)) return;
          dryLogged.add(m);
          console.log(m);
        },
      })
      .catch((e) => console.error('auto-submit', e));
  }, REAL ? 5000 : 3000);
}

// Trickle in fresh (fake) discoveries so the DEMO view keeps moving. Off in
// REAL mode, where discoveries are real apply URLs, not example.test.
const POOL: Array<[string, string, string, Application['ats'], number]> = [
  ['Cloudflare', 'New Grad Systems Engineer', 'Austin, TX', 'greenhouse', 79],
  ['Airtable', 'Software Engineer I', 'San Francisco, CA', 'greenhouse', 78],
  ['Instacart', 'Software Engineer, New Grad', 'Remote (US)', 'greenhouse', 72],
  ['Affirm', 'Software Engineer I', 'Remote (US)', 'greenhouse', 74],
  ['Samsara', 'Software Engineer, University Grad', 'San Francisco, CA', 'lever', 73],
  ['Verkada', 'Software Engineer, New Grad', 'San Mateo, CA', 'lever', 70],
];
let discoveryIdx = 0;
if (!REAL) {
  setInterval(async () => {
    if ((await orch.snapshot()).applications.length >= 22) return;
    const [company, role, location, ats, matchScore] = POOL[discoveryIdx++ % POOL.length];
    await orch
      .discover([
        {
          company,
          role,
          location,
          ats,
          matchScore,
          applyUrl: `https://example.test/${company}/${Date.now()}`,
          postedAt: new Date().toISOString(),
        },
      ])
      .catch(() => {});
  }, 9000);
}

const { port } = await start(orch, Number(process.env.PORT ?? 4317), { previewDir: PREVIEW_DIR });
console.log(`apply-fleet orchestrator on http://localhost:${port}  (db: ${dbPath})`);
console.log('mode:', process.env.APPLY_FLEET_REAL ? 'REAL worker' : 'DEMO prepare');
// Say the submit stance out loud at boot. Nobody should have to read the source
// to know whether this process is about to file real applications.
console.log(
  'submit:',
  !AUTO_SUBMIT
    ? 'staged for review (APPLY_FLEET_AUTO_SUBMIT=0)'
    : ARM
      ? `LIVE — auto-submit ARMED, cap ${process.env.APPLY_FLEET_MAX_SUBMITS ?? 'none'}`
      : 'auto-submit ON, dry run (set APPLY_FLEET_ARM_SUBMIT=1 to file for real)',
);
