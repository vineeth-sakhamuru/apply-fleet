import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openSqlite,
  SCHEMA,
  append,
  listApplications,
  getAnswer,
  normalizeQuestion,
  type Db,
} from '../src/index.ts';
import { openPglite } from './pgliteDb.ts';

const SPONSOR_Q = 'Will you now or in the future require sponsorship?';

/** Run the same event sequence against a Db and return a comparable snapshot. */
async function run(db: Db) {
  await db.exec(SCHEMA);

  await append(db, {
    type: 'application.discovered',
    aggregate: 'application',
    aggregateId: 'af_1',
    payload: {
      company: 'Stripe',
      role: 'New Grad SWE, Backend',
      location: 'Seattle, WA',
      ats: 'greenhouse',
      applyUrl: 'https://boards.greenhouse.io/stripe/jobs/af_1',
      postedAt: '2026-07-21T00:00:00.000Z',
      matchScore: 91,
      status: 'queued',
    },
  });
  await append(db, {
    type: 'application.discovered',
    aggregate: 'application',
    aggregateId: 'af_2',
    payload: {
      company: 'Ramp',
      role: 'Software Engineer, New Grad',
      location: 'New York, NY',
      ats: 'ashby',
      applyUrl: 'https://jobs.ashbyhq.com/ramp/af_2',
      postedAt: '2026-07-20T00:00:00.000Z',
      matchScore: 88,
      status: 'queued',
    },
  });
  await append(db, {
    type: 'application.status_changed',
    aggregate: 'application',
    aggregateId: 'af_1',
    payload: {
      status: 'ready',
      resumeVariant: 'backend-distributed',
      fields: [
        { label: 'Full name', value: 'First Middle Last', source: 'profile' },
      ],
    },
  });
  await append(db, {
    type: 'answer.cached',
    aggregate: 'answer',
    aggregateId: normalizeQuestion(SPONSOR_Q),
    payload: {
      questionNorm: normalizeQuestion(SPONSOR_Q),
      question: SPONSOR_Q,
      answer: 'No',
      source: 'profile',
    },
  });
  await append(db, {
    type: 'email.received',
    aggregate: 'email',
    aggregateId: 'em_1',
    payload: {
      applicationId: 'af_1',
      alias: 'app+af_1@apply-fleet',
      direction: 'inbound',
      subject: 'We received your application',
    },
  });

  const apps = (await listApplications(db)).map((a) => ({
    id: a.id,
    company: a.company,
    ats: a.ats,
    status: a.status,
    matchScore: a.matchScore,
    resumeVariant: a.resumeVariant ?? null,
    fields: a.fields ?? null,
  }));
  const ans = await getAnswer(db, SPONSOR_Q);
  const emails = await db.all<{ alias: string; direction: string; subject: string | null }>(
    'SELECT alias, direction, subject FROM emails ORDER BY id',
  );
  const events = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM events');

  return {
    apps,
    answer: ans ? { answer: ans.answer, source: ans.source } : null,
    emails,
    eventCount: Number(events[0]?.n ?? 0),
  };
}

test('same events → identical results on SQLite and Postgres', async () => {
  const s = openSqlite(':memory:');
  const sqliteSnap = await run(s);
  await s.close();

  const p = await openPglite();
  const pgSnap = await run(p);
  await p.close();

  // Compare logical data. (node:sqlite returns plain-object rows; PGlite
  // returns null-prototype rows — same values, so canonicalize via JSON.)
  const canon = (o: unknown) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(canon(pgSnap), canon(sqliteSnap));
});

test('projections + event log are correct', async () => {
  const s = openSqlite(':memory:');
  const snap = await run(s);
  await s.close();

  assert.equal(snap.apps.length, 2);
  assert.equal(snap.eventCount, 5);

  const stripe = snap.apps.find((a) => a.id === 'af_1')!;
  assert.equal(stripe.status, 'ready');
  assert.equal(stripe.resumeVariant, 'backend-distributed');
  assert.equal(stripe.fields?.[0].value, 'First Middle Last');

  // posted_at DESC → newest first
  assert.equal(snap.apps[0].id, 'af_1');
  assert.equal(snap.answer?.answer, 'No');
  assert.equal(snap.emails.length, 1);
});
