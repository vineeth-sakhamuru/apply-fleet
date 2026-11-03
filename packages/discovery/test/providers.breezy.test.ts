import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchBreezy } from '../src/providers/breezy.ts';

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

test('breezy: parses positions feed into DiscoveredJob[] (real capture)', async () => {
  const jobs = await fetchBreezy('breezy', {
    fetchImpl: fixtureFetch('breezy.json'),
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'MS Breezy Trial'); // defaults to the feed's company name
  assert.equal(first.role, 'Employee #12');
  assert.equal(first.location, 'Chaos, FL');
  assert.equal(first.ats, 'breezy');
  assert.equal(first.externalId, '98323abf2296');
  assert.equal(first.source, 'breezy');
  assert.equal(first.applyUrl, 'https://breezy.breezy.hr/p/98323abf2296-employee-12');
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, '2024-02-15T14:37:22.684Z');
});

test('breezy: company override wins over the feed name', async () => {
  const jobs = await fetchBreezy('breezy', {
    fetchImpl: fixtureFetch('breezy.json'),
    company: 'Breezy HR',
  });
  assert.equal(jobs[0].company, 'Breezy HR');
});

test('breezy: throws on a non-ok response', async () => {
  const badFetch = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  })) as unknown as typeof fetch;

  await assert.rejects(() => fetchBreezy('breezy', { fetchImpl: badFetch }), /503/);
});
