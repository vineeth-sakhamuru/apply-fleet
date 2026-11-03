import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverAll, type DiscoveryTarget } from '../src/index.ts';

const fx = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `fixtures/${name}.json`), 'utf8'));
const G = fx('greenhouse');
const L = fx('lever');
const A = fx('ashby');

function fakeFetch(url: string | URL): Promise<Response> {
  const u = String(url);
  const payload = u.includes('greenhouse') ? G : u.includes('lever') ? L : u.includes('ashby') ? A : {};
  return Promise.resolve({ ok: true, json: async () => payload } as Response);
}

const targets: DiscoveryTarget[] = [
  { ats: 'greenhouse', slug: 'stripe', company: 'Stripe' },
  { ats: 'lever', slug: 'palantir', company: 'Palantir' },
  { ats: 'ashby', slug: 'ramp', company: 'Ramp' },
];

const FOREVER = 24 * 365 * 100;

test('discoverAll fans across providers, combines, sorts newest-first', async () => {
  const jobs = await discoverAll(targets, { fetchImpl: fakeFetch as typeof fetch, maxAgeHours: FOREVER });
  assert.ok(jobs.length >= 3);
  const ats = new Set(jobs.map((j) => j.ats));
  assert.ok(ats.has('greenhouse') && ats.has('lever') && ats.has('ashby'));
  for (let i = 1; i < jobs.length; i++) {
    assert.ok(Date.parse(jobs[i - 1].postedAt) >= Date.parse(jobs[i].postedAt));
  }
});

test('a failing target is isolated; others still return', async () => {
  const errs: string[] = [];
  const fetchImpl = ((url: string | URL) =>
    String(url).includes('/boom/') || String(url).includes('boom')
      ? Promise.reject(new Error('down'))
      : fakeFetch(url)) as typeof fetch;

  const jobs = await discoverAll([...targets, { ats: 'greenhouse', slug: 'boom', company: 'Boom' }], {
    fetchImpl,
    maxAgeHours: FOREVER,
    onError: (t) => errs.push(t.slug),
  });

  assert.ok(jobs.length >= 3);
  assert.deepEqual(errs, ['boom']);
});
