import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite, SCHEMA, append, listEmails, type Db } from '../src/index.ts';

const app = (id: string, company: string, role: string) => ({
  type: 'application.discovered' as const,
  aggregate: 'application' as const,
  aggregateId: id,
  payload: {
    company,
    role,
    location: 'Remote (US)',
    ats: 'greenhouse',
    applyUrl: `https://boards.greenhouse.io/x/${id}`,
    postedAt: '2026-07-01T00:00:00.000Z',
    status: 'submitted',
  },
});

const email = (
  id: string,
  appId: string | null,
  subject: string,
  receivedAt: string,
  kind: string,
) => ({
  type: 'email.received' as const,
  aggregate: 'email' as const,
  aggregateId: id,
  payload: {
    applicationId: appId,
    alias: `apply+${appId ?? 'unknown'}@example.test`,
    direction: 'inbound',
    subject,
    fromAddr: 'no-reply@greenhouse.io',
    receivedAt,
    parsed: { kind, ats: 'greenhouse' },
  },
});

async function seeded(): Promise<Db> {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  await append(db, app('af_1', 'Stripe', 'New Grad SWE, Backend'));
  await append(db, app('af_2', 'Ramp', 'Software Engineer, New Grad'));
  // Deliberately out of order so the ORDER BY is what fixes it.
  await append(db, email('em_a', 'af_1', 'We received your application', '2026-08-01T10:00:00.000Z', 'ack'));
  await append(db, email('em_c', 'af_2', 'Schedule your phone screen', '2026-08-03T09:00:00.000Z', 'interview'));
  await append(db, email('em_b', 'af_1', 'Verify your email', '2026-08-02T12:00:00.000Z', 'verify'));
  return db;
}

test('listEmails joins the application and returns newest first', async () => {
  const db = await seeded();
  try {
    const rows = await listEmails(db);

    assert.deepEqual(
      rows.map((r) => r.id),
      ['em_c', 'em_b', 'em_a'],
    );

    const [interview] = rows;
    assert.equal(interview.company, 'Ramp');
    assert.equal(interview.role, 'Software Engineer, New Grad');
    assert.equal(interview.applicationId, 'af_2');
    assert.equal(interview.subject, 'Schedule your phone screen');
    assert.equal(interview.kind, 'interview');
    assert.equal(interview.direction, 'inbound');
    assert.equal(interview.fromAddr, 'no-reply@greenhouse.io');
    assert.equal(interview.receivedAt, '2026-08-03T09:00:00.000Z');

    // Both of af_1's emails resolve to the same joined application.
    assert.deepEqual(
      rows.filter((r) => r.applicationId === 'af_1').map((r) => r.company),
      ['Stripe', 'Stripe'],
    );
  } finally {
    await db.close();
  }
});

test('an unmatched alias still lists, with no company/role', async () => {
  const db = await seeded();
  try {
    await append(db, email('em_z', null, 'Are you still interested?', '2026-08-04T00:00:00.000Z', 'other'));
    const rows = await listEmails(db);

    assert.equal(rows.length, 4);
    const first = rows[0];
    assert.equal(first.id, 'em_z');
    assert.equal(first.applicationId, undefined);
    assert.equal(first.company, undefined);
    assert.equal(first.role, undefined);
    assert.equal(first.alias, 'apply+unknown@example.test');
  } finally {
    await db.close();
  }
});

test('limit caps the reply log', async () => {
  const db = await seeded();
  try {
    const rows = await listEmails(db, { limit: 2 });
    assert.deepEqual(
      rows.map((r) => r.id),
      ['em_c', 'em_b'],
    );
  } finally {
    await db.close();
  }
});
