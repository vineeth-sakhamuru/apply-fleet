import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchRippling } from '../src/providers/rippling.ts';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

function fixtureFetch(name: string): typeof fetch {
  const data = JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
  return (async () => ({ ok: true, status: 200, json: async () => data })) as unknown as typeof fetch;
}

test('rippling: parses the ATS board feed (real capture)', async () => {
  const jobs = await fetchRippling('rippling', { fetchImpl: fixtureFetch('rippling.json') });

  assert.ok(jobs.length >= 1);
  const first = jobs[0];
  assert.equal(first.ats, 'rippling');
  assert.equal(first.company, 'rippling');
  assert.equal(first.role, 'Account Executive - Accountants Channel (East Coast)');
  assert.equal(first.externalId, '2f0674e6-f01f-4ecd-b459-e947241c211f');
  assert.equal(first.applyUrl, 'https://ats.rippling.com/rippling/jobs/2f0674e6-f01f-4ecd-b459-e947241c211f');
  assert.ok(first.location.length > 0);
  assert.equal(first.postedAt, ''); // board feed has no date → kept downstream
});

test('rippling: collapses duplicate uuids (same job, many locations)', async () => {
  const data = [
    { uuid: 'u1', name: 'Eng', url: 'https://ats.rippling.com/x/jobs/u1', workLocation: { label: 'NYC' } },
    { uuid: 'u1', name: 'Eng', url: 'https://ats.rippling.com/x/jobs/u1', workLocation: { label: 'SF' } },
    { uuid: 'u2', name: 'PM', url: 'https://ats.rippling.com/x/jobs/u2', workLocation: { label: 'Remote' } },
  ];
  const stub = (async () => ({ ok: true, status: 200, json: async () => data })) as unknown as typeof fetch;
  const jobs = await fetchRippling('x', { fetchImpl: stub });
  assert.equal(jobs.length, 2);
});

test('rippling: throws on a non-ok response', async () => {
  const bad = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(() => fetchRippling('x', { fetchImpl: bad }), /500/);
});
