import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openSqlite,
  SCHEMA,
  append,
  getApplication,
  getReadySpec,
  getAnswer,
  type Db,
} from '@apply-fleet/data';
import type { Application } from '@apply-fleet/shared';
import type { PrepareResult, ReadySpec } from '@apply-fleet/worker';
import { Orchestrator, type DiscoveredInput } from '@apply-fleet/orchestrator';

function mkSpec(app: Application): ReadySpec {
  return {
    applicationId: app.id,
    url: app.applyUrl,
    resumePath: '/tmp/r.pdf',
    submitSelector: 'button[type="submit"]',
    values: [{ label: 'Email', selector: '#email', kind: 'email', value: 'x@y.z', source: 'answers' }],
  };
}

/** Fake pipeline: HitlCo needs a human until its question is answered. */
function makePrepare(db: Db) {
  return async (app: Application): Promise<PrepareResult> => {
    const resolved = [{ label: 'Email', value: 'x@y.z', source: 'answers' as const }];
    if (app.company === 'HitlCo' && !(await getAnswer(db, 'Why us?'))) {
      return { spec: mkSpec(app), resolved, hitl: [{ label: 'Why us?', question: 'Why us?', severity: 'quick' }] };
    }
    return { spec: mkSpec(app), resolved, hitl: [] };
  };
}

const job = (over: Partial<DiscoveredInput>): DiscoveredInput => ({
  company: 'Acme',
  role: 'New Grad SWE',
  location: 'Remote (US)',
  ats: 'greenhouse',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  postedAt: new Date().toISOString(),
  ...over,
});

async function setup() {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  const execute = async () => {};
  const orch = new Orchestrator({ db, prepare: makePrepare(db), execute, concurrency: 3 });
  return { db, orch };
}

test('discovery dedupes; pipeline fills to ready and persists the spec', async () => {
  const { db, orch } = await setup();

  assert.equal(await orch.discover([job({ applyUrl: 'https://x/1' }), job({ applyUrl: 'https://x/2' })]), 2);
  assert.equal(await orch.discover([job({ applyUrl: 'https://x/1' })]), 0); // dedupe

  await orch.runPipeline();
  const apps = (await orch.snapshot()).applications;
  assert.equal(apps.length, 2);
  for (const a of apps) {
    assert.equal(a.status, 'ready');
    assert.ok(await getReadySpec(db, a.id), 'ready spec persisted');
  }
  await db.close();
});

test('submit is the human gate: ready → submitting → submitted', async () => {
  const { db, orch } = await setup();
  await orch.discover([job({ applyUrl: 'https://x/1' })]);
  await orch.runPipeline();
  const [app] = (await orch.snapshot()).applications;

  await orch.submit(app.id);
  assert.equal((await getApplication(db, app.id))?.status, 'submitted');
  await db.close();
});

test('HITL: needs_you → answer caches + re-queues → ready', async () => {
  const { db, orch } = await setup();
  await orch.discover([job({ company: 'HitlCo', applyUrl: 'https://x/hitl' })]);
  await orch.runPipeline();

  let [app] = (await orch.snapshot()).applications;
  assert.equal(app.status, 'needs_you');
  assert.equal(app.hitl?.question, 'Why us?');

  await orch.answerHitl(app.id, 'Why us?', 'Because distributed systems.');
  assert.ok(await getAnswer(db, 'Why us?'), 'answer cached');
  app = (await getApplication(db, app.id))!;
  assert.equal(app.status, 'queued');
  assert.equal(app.hitl, undefined);

  await orch.runPipeline(); // now resolves (answer cached)
  assert.equal((await getApplication(db, app.id))?.status, 'ready');
  await db.close();
});

test('resume: mid-flight work is recovered to the queue after a crash', async () => {
  const { db, orch } = await setup();
  await orch.discover([job({ applyUrl: 'https://x/1' })]);
  const [app] = (await orch.snapshot()).applications;

  // Simulate a crash mid-prepare: the app is left in 'filling'.
  await append(db, {
    type: 'application.status_changed',
    aggregate: 'application',
    aggregateId: app.id,
    payload: { status: 'filling' },
  });
  assert.equal((await getApplication(db, app.id))?.status, 'filling');

  // A fresh orchestrator resumes from state.
  const fresh = new Orchestrator({ db, prepare: makePrepare(db), execute: async () => {} });
  assert.equal(await fresh.resume(), 1);
  assert.equal((await getApplication(db, app.id))?.status, 'queued');
  await db.close();
});
