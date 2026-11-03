import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchPersonio } from '../src/providers/personio.ts';

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

test('personio: parses search.json into DiscoveredJob[] (real capture)', async () => {
  const jobs = await fetchPersonio('hometogo', {
    fetchImpl: fixtureFetch('personio.json'),
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'hometogo'); // defaults to slug (feed carries no company name)
  assert.equal(first.role, 'Senior Software Engineer & Team Lead');
  assert.equal(first.location, 'Kaunas, Vilnius, Kaunas/Vilnius');
  assert.equal(first.ats, 'personio');
  assert.equal(first.externalId, '2578538');
  assert.equal(first.source, 'hometogo');
  assert.equal(first.applyUrl, 'https://hometogo.jobs.personio.de/job/2578538');
  assert.equal(first.postedAt, ''); // search.json exposes no posting date
});

test('personio: company override is respected', async () => {
  const jobs = await fetchPersonio('hometogo', {
    fetchImpl: fixtureFetch('personio.json'),
    company: 'HomeToGo',
  });
  assert.equal(jobs[0].company, 'HomeToGo');
});

test('personio: throws on a non-ok response', async () => {
  const badFetch = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  })) as unknown as typeof fetch;

  await assert.rejects(() => fetchPersonio('hometogo', { fetchImpl: badFetch }), /503/);
});
