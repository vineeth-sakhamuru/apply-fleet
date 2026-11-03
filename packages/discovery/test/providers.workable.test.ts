import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchWorkable } from '../src/providers/workable.ts';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

/** Build a `fetch`-shaped stub that returns the named fixture as JSON. */
function fixtureFetch(name: string): typeof fetch {
  const data = JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => data,
  })) as unknown as typeof fetch;
}

/** A parsed ISO string round-trips through Date without becoming NaN. */
function isIso(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && !Number.isNaN(Date.parse(s));
}

test('workable: parses widget feed into DiscoveredJob[] (real capture)', async () => {
  const jobs = await fetchWorkable('zego', {
    fetchImpl: fixtureFetch('workable.json'),
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'Zego'); // defaults to the feed's account name
  assert.equal(first.role, 'Analytics Engineer');
  assert.equal(first.location, 'London, England, United Kingdom');
  assert.equal(first.ats, 'workable');
  assert.equal(first.externalId, 'B76C11B977');
  assert.equal(first.source, 'zego');
  assert.equal(first.applyUrl, 'https://apply.workable.com/zego/j/B76C11B977/apply');
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, '2026-07-10T00:00:00.000Z');
});

test('workable: company override wins over the feed name', async () => {
  const jobs = await fetchWorkable('zego', {
    fetchImpl: fixtureFetch('workable.json'),
    company: 'Zego Ltd',
  });
  assert.equal(jobs[0].company, 'Zego Ltd');
});

test('workable: throws on a non-ok response', async () => {
  const badFetch = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  })) as unknown as typeof fetch;

  await assert.rejects(() => fetchWorkable('zego', { fetchImpl: badFetch }), /503/);
});
