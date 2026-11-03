import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openSqlite,
  SCHEMA,
  append,
  getApplication,
  getReadySpec,
  type Db,
} from '@apply-fleet/data';
import type { PrepareResult, ReadySpec } from '@apply-fleet/worker';
import { Orchestrator, SubmitBlocked } from '@apply-fleet/orchestrator';

// A submit that was DECLINED on purpose (arm flag off, or a required field
// unfilled on replay) must not destroy a perfectly good prepared application.
// Before this, clicking Submit with the arm flag unset silently moved the app to
// 'failed' — indistinguishable from a real crash, and the ready spec was lost.

const mkSpec = (id: string): ReadySpec => ({
  applicationId: id,
  url: `https://x/${id}`,
  submitSelector: 'button[type="submit"]',
  values: [{ label: 'Email', selector: '#e', kind: 'email', value: 'a@b.c', source: 'answers' }],
});

async function seedReady(db: Db, id: string): Promise<void> {
  await append(db, {
    type: 'application.discovered',
    aggregate: 'application',
    aggregateId: id,
    payload: {
      company: 'Acme', role: 'SWE', location: 'Remote', ats: 'ashby',
      applyUrl: `https://x/${id}`, postedAt: new Date().toISOString(),
      status: 'queued', matchScore: 0,
    },
  });
  await append(db, {
    type: 'application.status_changed',
    aggregate: 'application',
    aggregateId: id,
    payload: { status: 'ready', spec: mkSpec(id) },
  });
}

async function setup(execute: (s: ReadySpec) => Promise<void>) {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  const prepare = async (): Promise<PrepareResult> => {
    throw new Error('prepare not used here');
  };
  return { db, orch: new Orchestrator({ db, prepare, execute, concurrency: 1 }) };
}

test('a BLOCKED submit returns the app to ready and keeps its spec', async () => {
  const { db, orch } = await setup(async () => {
    throw new SubmitBlocked('submit not armed — filled but did NOT submit.');
  });
  await seedReady(db, 'b1');

  await assert.rejects(() => orch.submit('b1'), /not armed/);

  const app = await getApplication(db, 'b1');
  assert.equal(app?.status, 'ready', 'a declined submit must NOT be marked failed');
  // The replayable spec must survive, or the app could never be submitted later.
  const spec = await getReadySpec(db, 'b1');
  assert.ok(spec, 'ready spec must survive a blocked submit');
});

test('a GENUINE error still marks the app failed, with the reason recorded', async () => {
  const { db, orch } = await setup(async () => {
    throw new Error('browser crashed');
  });
  await seedReady(db, 'b2');

  await assert.rejects(() => orch.submit('b2'), /browser crashed/);

  const app = await getApplication(db, 'b2');
  assert.equal(app?.status, 'failed', 'a real crash is still a failure');
});

test('a successful submit still reaches submitted', async () => {
  const { db, orch } = await setup(async () => {});
  await seedReady(db, 'b3');
  await orch.submit('b3');
  const app = await getApplication(db, 'b3');
  assert.equal(app?.status, 'submitted');
});

// Exactly-once. Filing the same application twice is unrecoverable, and with
// hands-free submit as the product default there are now several callers that
// could race for the same id (Submit-all, the auto-submit loop, a stray click).

test('concurrent submits of the same id execute exactly once', async () => {
  let executions = 0;
  const { db, orch } = await setup(async () => {
    executions++;
    await new Promise((r) => setTimeout(r, 40)); // hold the claim open
  });
  await seedReady(db, 'x1');

  await Promise.all([orch.submit('x1'), orch.submit('x1'), orch.submit('x1')]);

  assert.equal(executions, 1, 'the application must be filed exactly once');
  const app = await getApplication(db, 'x1');
  assert.equal(app?.status, 'submitted');
});

test('re-submitting an already-submitted application is a no-op', async () => {
  let executions = 0;
  const { db, orch } = await setup(async () => { executions++; });
  await seedReady(db, 'x2');

  await orch.submit('x2');
  await orch.submit('x2'); // e.g. the auto-submit loop ticking again

  assert.equal(executions, 1, 'never file a duplicate');
  assert.equal((await getApplication(db, 'x2'))?.status, 'submitted');
});

// Blast radius. Auto-submit is the default now, so the cap is the thing that
// keeps a loop bug from turning one armed run into fifty filed applications.

test('the submit cap stops real filings and holds the rest at ready', async () => {
  let executions = 0;
  const { db, orch } = await setup(async () => { executions++; });
  for (const id of ['c1', 'c2', 'c3', 'c4']) await seedReady(db, id);

  const r = await orch.autoSubmitReady({ arm: true, auto: true, maxSubmits: 2, log: () => {} });

  assert.equal(executions, 2, 'exactly the cap, no more');
  assert.equal(r.submitted.length, 2);
  assert.equal(r.wouldSubmit.length, 2, 'the capped apps are reported, not dropped');
  assert.equal((await getApplication(db, r.wouldSubmit[0]))?.status, 'ready');
});

test('the cap counts across loop ticks, not per call', async () => {
  let executions = 0;
  const { db, orch } = await setup(async () => { executions++; });
  for (const id of ['d1', 'd2', 'd3']) await seedReady(db, id);

  // Two ticks of the interval loop, cap 1. A per-call cap would file twice.
  await orch.autoSubmitReady({ arm: true, auto: true, maxSubmits: 1, log: () => {} });
  await orch.autoSubmitReady({ arm: true, auto: true, maxSubmits: 1, log: () => {} });

  assert.equal(executions, 1, 'the cap is for the life of the process');
});

test('auto defaults ON but an unarmed run still files nothing', async () => {
  let executions = 0;
  const { db, orch } = await setup(async () => { executions++; });
  await seedReady(db, 'e1');

  const r = await orch.autoSubmitReady({ arm: false, log: () => {} }); // auto left to the default

  assert.equal(executions, 0, 'no ARM means no real filing, ever');
  assert.deepEqual(r.wouldSubmit, ['e1'], 'the default is a dry run of the real path');
  assert.equal((await getApplication(db, 'e1'))?.status, 'ready');
});

test('submitAllReady cannot double-file when it overlaps the auto-submit loop', async () => {
  let executions = 0;
  const { db, orch } = await setup(async () => {
    executions++;
    await new Promise((r) => setTimeout(r, 30));
  });
  await seedReady(db, 'y1');
  await seedReady(db, 'y2');

  await Promise.all([orch.submitAllReady(), orch.autoSubmitReady({ arm: true, auto: true })]);

  assert.equal(executions, 2, 'two apps, two submissions — not four');
});

// HITL SLA. A `needs_you` app is invisible pressure: nothing retries it and
// nothing escalates, so one unanswered question parks an application forever.

test('hitlOverdue reports only apps waiting past the threshold, oldest first', async () => {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  const orch = new Orchestrator({
    db,
    prepare: async () => { throw new Error('unused'); },
    execute: async () => {},
  });

  const ask = async (id: string, agoMs: number) => {
    await append(db, {
      type: 'application.discovered', aggregate: 'application', aggregateId: id,
      payload: {
        company: 'Acme', role: 'SWE', location: 'Remote', ats: 'ashby',
        applyUrl: `https://x/${id}`, postedAt: new Date().toISOString(),
        status: 'queued', matchScore: 0,
      },
    });
    await append(db, {
      type: 'application.status_changed', aggregate: 'application', aggregateId: id,
      payload: { status: 'needs_you', hitl: { severity: 'quick', question: `q-${id}` } },
    });
    // Backdate the projection's clock the way real waiting would.
    await db.run('UPDATE applications SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - agoMs).toISOString(), id,
    ]);
  };

  await ask('fresh', 60_000);            // a minute
  await ask('stale', 3 * 24 * 3600_000); // three days
  await ask('older', 5 * 24 * 3600_000); // five days

  const overdue = await orch.hitlOverdue(24 * 3600_000);
  assert.deepEqual(overdue.map((r) => r.id), ['older', 'stale'], 'oldest first, fresh excluded');
  assert.equal(overdue[0].question, 'q-older', 'the question must come along, not just the id');

  // Reporting must never re-queue: auto-clearing an unanswered question would
  // mean filing a form with a guessed value in it.
  assert.equal((await getApplication(db, 'stale'))?.status, 'needs_you');
});
