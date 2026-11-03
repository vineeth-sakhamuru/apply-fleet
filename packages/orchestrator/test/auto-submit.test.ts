import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openSqlite,
  SCHEMA,
  append,
  getApplication,
  type Db,
} from '@apply-fleet/data';
import type { PrepareResult, ReadySpec } from '@apply-fleet/worker';
import { Orchestrator } from '@apply-fleet/orchestrator';

const mkSpec = (id: string): ReadySpec => ({
  applicationId: id,
  url: `https://x/${id}`,
  submitSelector: 'button[type="submit"]',
  values: [],
});

/** Fabricate an application straight into `status`, with a replayable spec. */
async function seedApp(db: Db, id: string, status: string): Promise<void> {
  await append(db, {
    type: 'application.discovered',
    aggregate: 'application',
    aggregateId: id,
    payload: {
      company: 'Acme',
      role: 'SWE',
      location: 'Remote',
      ats: 'greenhouse',
      applyUrl: `https://x/${id}`,
      postedAt: new Date().toISOString(),
      status: 'queued',
      matchScore: 0,
    },
  });
  await append(db, {
    type: 'application.status_changed',
    aggregate: 'application',
    aggregateId: id,
    payload: { status, spec: mkSpec(id) },
  });
}

/** Orchestrator with an injected fake submit (deps.execute) that records ids. */
async function setup() {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  const executed: string[] = [];
  const execute = async (spec: ReadySpec) => {
    executed.push(spec.applicationId);
  };
  const prepare = async (): Promise<PrepareResult> => {
    throw new Error('prepare not used in auto-submit tests');
  };
  const orch = new Orchestrator({ db, prepare, execute, concurrency: 3 });
  return { db, orch, executed };
}

test('(a) flags unset → dry run: submit NOT called, "would submit" produced', async () => {
  delete process.env.APPLY_FLEET_ARM_SUBMIT;
  delete process.env.APPLY_FLEET_AUTO_SUBMIT;
  const { db, orch, executed } = await setup();
  await seedApp(db, 'a1', 'ready');
  await seedApp(db, 'a2', 'ready');

  const logs: string[] = [];
  const res = await orch.autoSubmitReady({ log: (m) => logs.push(m) });

  assert.equal(executed.length, 0, 'no real submit on a dry run');
  assert.deepEqual(res.submitted, []);
  assert.equal(res.wouldSubmit.length, 2);
  assert.ok(logs.includes('would submit a1'));
  assert.ok(logs.includes('would submit a2'));

  // dryRun override forces a dry run even if both gates are on.
  const forced = await orch.autoSubmitReady({ arm: true, auto: true, dryRun: true });
  assert.equal(executed.length, 0, 'dryRun override never submits');
  assert.equal(forced.wouldSubmit.length, 2);
  await db.close();
});

test('(b) both flags set → submit called exactly once per ready app', async () => {
  const { db, orch, executed } = await setup();
  await seedApp(db, 'b1', 'ready');
  await seedApp(db, 'b2', 'ready');

  const res = await orch.autoSubmitReady({ arm: true, auto: true });

  assert.deepEqual(executed.sort(), ['b1', 'b2']);
  assert.deepEqual(res.submitted.sort(), ['b1', 'b2']);
  assert.deepEqual(res.wouldSubmit, []);
  assert.equal((await getApplication(db, 'b1'))?.status, 'submitted');
  assert.equal((await getApplication(db, 'b2'))?.status, 'submitted');
  await db.close();
});

test('(c) idempotent → a second live call re-submits nothing', async () => {
  const { db, orch, executed } = await setup();
  await seedApp(db, 'c1', 'ready');

  await orch.autoSubmitReady({ arm: true, auto: true });
  assert.deepEqual(executed, ['c1']);

  const again = await orch.autoSubmitReady({ arm: true, auto: true });
  assert.deepEqual(executed, ['c1'], 'already-submitted app is not re-submitted');
  assert.deepEqual(again.submitted, []);
  await db.close();
});

test('(d) only ready apps submit; queued/needs_you/submitted are never touched', async () => {
  const { db, orch, executed } = await setup();
  await seedApp(db, 'd_ready', 'ready');
  await seedApp(db, 'd_queued', 'queued');
  await seedApp(db, 'd_needs', 'needs_you');
  await seedApp(db, 'd_done', 'submitted');

  const res = await orch.autoSubmitReady({ arm: true, auto: true });

  assert.deepEqual(executed, ['d_ready'], 'only the ready app is submitted');
  assert.deepEqual(res.submitted, ['d_ready']);
  assert.equal((await getApplication(db, 'd_queued'))?.status, 'queued');
  assert.equal((await getApplication(db, 'd_needs'))?.status, 'needs_you');
  await db.close();
});
