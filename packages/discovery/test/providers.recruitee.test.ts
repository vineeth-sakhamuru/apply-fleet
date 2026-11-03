import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchRecruitee } from '../src/providers/recruitee.ts';

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

test('recruitee: parses offers feed into DiscoveredJob[] (real capture)', async () => {
  const jobs = await fetchRecruitee('jobs', {
    fetchImpl: fixtureFetch('recruitee.json'),
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'Tellent'); // defaults to the feed's company name
  assert.equal(first.role, 'VP of Partnerships');
  assert.equal(first.location, 'Amsterdam, Noord-Holland, Netherlands');
  assert.equal(first.ats, 'recruitee');
  assert.equal(first.externalId, '2684910');
  assert.equal(first.source, 'jobs');
  // applyUrl comes straight from the feed's canonical apply URL (honors custom domains).
  assert.equal(first.applyUrl, 'https://careers.tellent.com/o/vp-of-partnerships/c/new');
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, '2026-07-21T17:02:27.000Z');
});

test('recruitee: company override wins over the feed name', async () => {
  const jobs = await fetchRecruitee('jobs', {
    fetchImpl: fixtureFetch('recruitee.json'),
    company: 'Tellent HR',
  });
  assert.equal(jobs[0].company, 'Tellent HR');
});

test('recruitee: throws on a non-ok response', async () => {
  const badFetch = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  })) as unknown as typeof fetch;

  await assert.rejects(() => fetchRecruitee('jobs', { fetchImpl: badFetch }), /503/);
});
