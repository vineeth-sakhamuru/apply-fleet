import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchJobvite } from '../src/providers/jobvite.ts';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

/** Jobvite returns XML, so the stub resolves `text()`. */
function fixtureFetch(name: string, calls: { url?: string } = {}): typeof fetch {
  const xml = readFileSync(resolve(fixturesDir, name), 'utf8');
  return (async (url: string) => {
    calls.url = url;
    return { ok: true, status: 200, text: async () => xml };
  }) as unknown as typeof fetch;
}

function isIso(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && !Number.isNaN(Date.parse(s));
}

test('jobvite: parses the CompanyJobs XML feed (real NinjaOne capture)', async () => {
  const calls: { url?: string } = {};
  const jobs = await fetchJobvite('quYbVfwi', { fetchImpl: fixtureFetch('jobvite.xml', calls) });

  assert.equal(calls.url, 'https://app.jobvite.com/CompanyJobs/xml.aspx?c=quYbVfwi');
  assert.equal(jobs.length, 3);
  const first = jobs[0];
  assert.equal(first.ats, 'jobvite');
  assert.equal(first.externalId, 'o6z5zfw3');
  assert.equal(first.role, 'Manager, Mid-Market Sales');
  assert.equal(first.location, 'Sydney, New South Wales, Australia');
  // apply URL is the feed's own, upgraded to https.
  assert.equal(
    first.applyUrl,
    'https://app.jobvite.com/CompanyJobs/Careers.aspx?c=quYbVfwi&j=o6z5zfw3&k=Apply',
  );
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  for (const j of jobs) {
    assert.ok(j.externalId.length > 0);
    assert.ok(j.role.length > 0);
    assert.ok(j.applyUrl.startsWith('https://'));
  }
});

test('jobvite: throws on a non-ok response', async () => {
  const bad = (async () => ({ ok: false, status: 500, text: async () => '' })) as unknown as typeof fetch;
  await assert.rejects(() => fetchJobvite('quYbVfwi', { fetchImpl: bad }), /500/);
});
