import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite, SCHEMA, getApplication, append } from '@apply-fleet/data';
import type { Application } from '@apply-fleet/shared';
import type { PrepareResult, ReadySpec } from '@apply-fleet/worker';
import { Orchestrator, start, type DiscoveredInput } from '@apply-fleet/orchestrator';

const spec = (app: Application): ReadySpec => ({
  applicationId: app.id,
  url: app.applyUrl,
  submitSelector: 'button',
  values: [],
});
const prepare = async (app: Application): Promise<PrepareResult> => ({
  spec: spec(app),
  resolved: [{ label: 'Email', value: 'x@y.z', source: 'answers' }],
  hitl: [],
});
const j: DiscoveredInput = {
  company: 'Acme',
  role: 'SWE',
  location: 'Remote',
  ats: 'greenhouse',
  applyUrl: 'https://x/1',
  postedAt: new Date().toISOString(),
};

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, ms = 2500): Promise<string> {
  const dec = new TextDecoder();
  const timeout = new Promise<string>((_, rej) => setTimeout(() => rej(new Error('sse timeout')), ms));
  const read = reader.read().then((r) => (r.value ? dec.decode(r.value) : ''));
  return Promise.race([read, timeout]);
}

test('server exposes health, applications, SSE, and submit', async () => {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  const orch = new Orchestrator({ db, prepare, execute: async () => {} });
  await orch.discover([j]);
  await orch.runPipeline(); // → one ready app

  const { server, port } = await start(orch, 0);
  const base = `http://localhost:${port}`;
  try {
    // health
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health, { ok: true });

    // snapshot
    const snap = await (await fetch(`${base}/api/applications`)).json();
    assert.equal(snap.applications.length, 1);
    const id = snap.applications[0].id;

    // SSE: handshake, then a real event frame
    const ac = new AbortController();
    const sse = await fetch(`${base}/api/events`, { signal: ac.signal });
    const reader = sse.body!.getReader();
    assert.match(await readChunk(reader), /retry:/);
    await orch.discover([{ ...j, applyUrl: 'https://x/2' }]); // emits an event
    assert.match(await readChunk(reader), /data:/);
    ac.abort();

    // submit via API → submitted
    const r = await fetch(`${base}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    assert.equal((await r.json()).ok, true);
    assert.equal((await getApplication(db, id))?.status, 'submitted');
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    await db.close();
  }
});

test('server exposes the reply log joined to its application', async () => {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  const orch = new Orchestrator({ db, prepare, execute: async () => {} });
  await orch.discover([j]);
  const id = (await orch.snapshot()).applications[0].id;

  const { server, port } = await start(orch, 0);
  const base = `http://localhost:${port}`;
  try {
    // empty before any mail arrives
    assert.deepEqual(await (await fetch(`${base}/api/emails`)).json(), { emails: [] });

    // two inbound emails, oldest appended first
    for (const [emId, subject, at, kind] of [
      ['em_1', 'Thanks for applying to Acme', '2026-08-01T00:00:00.000Z', 'ack'],
      ['em_2', 'Schedule your phone screen', '2026-08-02T00:00:00.000Z', 'interview'],
    ]) {
      await append(db, {
        type: 'email.received',
        aggregate: 'email',
        aggregateId: emId,
        payload: {
          applicationId: id,
          alias: `apply+${id}@example.test`,
          direction: 'inbound',
          subject,
          fromAddr: 'no-reply@greenhouse.io',
          receivedAt: at,
          parsed: { kind, ats: 'greenhouse' },
        },
      });
    }

    const { emails } = await (await fetch(`${base}/api/emails`)).json();
    assert.equal(emails.length, 2);
    // newest first, with the joined company/role
    assert.equal(emails[0].id, 'em_2');
    assert.equal(emails[0].kind, 'interview');
    assert.equal(emails[0].company, 'Acme');
    assert.equal(emails[0].role, 'SWE');
    assert.equal(emails[0].applicationId, id);
    assert.equal(emails[1].id, 'em_1');
    assert.equal(emails[1].subject, 'Thanks for applying to Acme');
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    await db.close();
  }
});

test('token gate: mutations need the bearer token, reads stay open', async () => {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  const orch = new Orchestrator({ db, prepare, execute: async () => {} });
  await orch.discover([j]);
  await orch.runPipeline(); // → one ready app

  process.env.APPLY_FLEET_TOKEN = 'sekret-123';
  const { server, port } = await start(orch, 0);
  const base = `http://localhost:${port}`;
  let id = '';
  const post = (auth?: string) =>
    fetch(`${base}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ id }),
    });
  try {
    // reads stay open with no Authorization header
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const snap = await (await fetch(`${base}/api/applications`)).json();
    id = snap.applications[0].id;

    // mutation without / with wrong token → 401, state unchanged
    assert.equal((await post()).status, 401);
    assert.equal((await post('Bearer nope')).status, 401);
    assert.notEqual((await getApplication(db, id))?.status, 'submitted');

    // correct token → 200, state advances
    assert.equal((await post('Bearer sekret-123')).status, 200);
    assert.equal((await getApplication(db, id))?.status, 'submitted');
  } finally {
    delete process.env.APPLY_FLEET_TOKEN;
    await new Promise<void>((res) => server.close(() => res()));
    await db.close();
  }
});

test('GET /api/metrics reports per-ATS rates, breakers, and usage', async () => {
  const db = openSqlite(':memory:');
  await db.exec(SCHEMA);
  const orch = new Orchestrator({ db, prepare, execute: async () => {} });
  await orch.discover([j]);
  await orch.runPipeline();

  const { server, port } = await start(orch, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/metrics`);
    assert.equal(res.status, 200);
    const m = (await res.json()) as {
      ats: Array<{ ats: string; total: number; fillRate: number }>;
      breakers: unknown[];
      usage: { calls: number; byPurpose: Record<string, unknown> };
    };
    // The db comes from the orchestrator itself, not a second handle passed in —
    // a mismatched handle would silently report an empty fleet.
    assert.ok(Array.isArray(m.ats), 'ats must be an array, not undefined');
    assert.equal(m.ats.length, 1, 'the one discovered app must be counted');
    assert.ok(Array.isArray(m.breakers));
    assert.equal(typeof m.usage.calls, 'number');
    assert.ok(m.usage.byPurpose, 'usage must carry the per-purpose split');
  } finally {
    server.close();
  }
});
