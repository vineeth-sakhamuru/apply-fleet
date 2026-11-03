import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite, SCHEMA, append } from '@apply-fleet/data';
import { reconcile, aliasFor } from '../src/index.ts';

async function seedApp(db: Awaited<ReturnType<typeof openSqlite>>, id: string) {
  await append(db, {
    type: 'application.discovered',
    aggregate: 'application',
    aggregateId: id,
    payload: {
      company: 'Stripe',
      role: 'New Grad SWE',
      location: 'Seattle, WA',
      ats: 'greenhouse',
      applyUrl: 'https://boards.greenhouse.io/stripe/jobs/1',
      postedAt: new Date().toISOString(),
      status: 'submitted',
    },
  });
}

test('an ack email auto-links to its application via the plus-alias', async () => {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  await seedApp(db, 'af_1');

  const res = await reconcile(db, {
    to: aliasFor('fleet@gmail.com', 'af_1'),
    from: 'no-reply@greenhouse.io',
    subject: 'Thank you for applying to Stripe',
    body: 'We have received your application.',
  });

  assert.equal(res.matched, 'af_1');
  assert.equal(res.kind, 'ack');
  assert.equal(res.recorded, true);

  const rows = await db.all<{ application_id: string; parsed: string }>(
    'SELECT application_id, parsed FROM emails',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].application_id, 'af_1');
  assert.match(rows[0].parsed, /ack/);
  await db.close();
});

test('an unknown alias records nothing', async () => {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  await seedApp(db, 'af_1');

  const res = await reconcile(db, {
    to: aliasFor('fleet@gmail.com', 'af_nope'),
    from: 'no-reply@greenhouse.io',
    subject: 'Thanks for applying',
    body: 'received your application',
  });

  assert.equal(res.matched, undefined);
  assert.equal(res.recorded, false);
  const rows = await db.all('SELECT * FROM emails');
  assert.equal(rows.length, 0);
  await db.close();
});
