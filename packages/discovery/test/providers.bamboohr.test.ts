import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchBambooHr } from '../src/providers/bamboohr.ts';

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

test('bamboohr: parses careers/list into DiscoveredJob[] (real capture)', async () => {
  const jobs = await fetchBambooHr('canopy', {
    fetchImpl: fixtureFetch('bamboohr.json'),
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'canopy'); // defaults to slug (feed carries no company name)
  assert.equal(first.role, 'ACCOUNT MANAGER 2');
  assert.equal(first.location, 'Kingston'); // state is null in the feed
  assert.equal(first.ats, 'bamboohr');
  assert.equal(first.externalId, '42');
  assert.equal(first.source, 'canopy');
  assert.equal(first.applyUrl, 'https://canopy.bamboohr.com/careers/42');
  assert.equal(first.postedAt, ''); // the list feed exposes no posting date
});

test('bamboohr: company override is respected', async () => {
  const jobs = await fetchBambooHr('canopy', {
    fetchImpl: fixtureFetch('bamboohr.json'),
    company: 'Canopy',
  });
  assert.equal(jobs[0].company, 'Canopy');
});

test('bamboohr: throws on a non-ok response', async () => {
  const badFetch = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  })) as unknown as typeof fetch;

  await assert.rejects(() => fetchBambooHr('canopy', { fetchImpl: badFetch }), /503/);
});
