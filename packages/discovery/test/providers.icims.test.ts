import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchIcims } from '../src/providers/icims.ts';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

/** iCIMS returns HTML, so the stub resolves `text()`, not `json()`. */
function fixtureFetch(name: string, calls: { url?: string } = {}): typeof fetch {
  const html = readFileSync(resolve(fixturesDir, name), 'utf8');
  return (async (url: string) => {
    calls.url = url;
    return { ok: true, status: 200, text: async () => html };
  }) as unknown as typeof fetch;
}

function isIso(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && !Number.isNaN(Date.parse(s));
}

test('icims: parses the career-portal iframe HTML (real GDMS capture)', async () => {
  const calls: { url?: string } = {};
  const jobs = await fetchIcims('gdms', { fetchImpl: fixtureFetch('icims.html', calls) });

  assert.equal(
    calls.url,
    'https://careers-gdms.icims.com/jobs/search?ss=1&searchKeyword=&in_iframe=1',
  );
  assert.equal(jobs.length, 3);
  const first = jobs[0];
  assert.equal(first.ats, 'icims');
  assert.equal(first.company, 'gdms');
  assert.equal(first.externalId, '73722');
  assert.equal(first.role, 'Traffic Modeling System Engineer for Missile Tracking (Space Force)');
  // apply URL keeps the real path, strips the ?in_iframe=1 query.
  assert.equal(
    first.applyUrl,
    'https://careers-gdms.icims.com/jobs/73722/traffic-modeling-system-engineer-for-missile-tracking-%28space-force%29/job',
  );
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  // every card yields a well-formed job
  for (const j of jobs) {
    assert.ok(j.externalId.length > 0);
    assert.ok(j.role.length > 0);
    assert.ok(j.applyUrl.startsWith('https://careers-gdms.icims.com/jobs/'));
  }
});

test('icims: throws on a non-ok response', async () => {
  const bad = (async () => ({ ok: false, status: 403, text: async () => '' })) as unknown as typeof fetch;
  await assert.rejects(() => fetchIcims('gdms', { fetchImpl: bad }), /403/);
});
