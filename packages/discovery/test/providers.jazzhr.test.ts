import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchJazzHr } from '../src/providers/jazzhr.ts';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

/** JazzHR returns HTML, so the stub resolves `text()`. */
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

test('jazzhr: parses the applytojob board HTML (real Labelmaster capture)', async () => {
  const calls: { url?: string } = {};
  const jobs = await fetchJazzHr('labelmaster', { fetchImpl: fixtureFetch('jazzhr.html', calls) });

  assert.equal(calls.url, 'https://labelmaster.applytojob.com/apply/jobs/');
  assert.equal(jobs.length, 4);
  const first = jobs[0];
  assert.equal(first.ats, 'jazzhr');
  assert.equal(first.company, 'labelmaster');
  assert.equal(first.externalId, 'sLkUs5aX1M');
  assert.equal(first.role, 'Industrial Machinery Mechanic/Maintenance Technician');
  assert.equal(first.location, 'Chicago, IL');
  assert.equal(first.applyUrl, 'https://labelmaster.applytojob.com/apply/jobs/details/sLkUs5aX1M');
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, '2026-07-17T20:03:10.000Z'); // from the row-id timestamp
  for (const j of jobs) {
    assert.ok(j.externalId.length > 0);
    assert.ok(j.role.length > 0);
    assert.ok(j.applyUrl.startsWith('https://labelmaster.applytojob.com/apply/jobs/details/'));
  }
});

test('jazzhr: throws on a non-ok response', async () => {
  const bad = (async () => ({ ok: false, status: 502, text: async () => '' })) as unknown as typeof fetch;
  await assert.rejects(() => fetchJazzHr('labelmaster', { fetchImpl: bad }), /502/);
});
