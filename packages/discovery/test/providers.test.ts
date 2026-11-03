import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchGreenhouse, fetchLever, fetchAshby, fetchSmartRecruiters } from '../src/index.ts';

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

test('greenhouse: parses feed into DiscoveredJob[]', async () => {
  const jobs = await fetchGreenhouse('stripe', {
    fetchImpl: fixtureFetch('greenhouse.json'),
    company: 'Stripe',
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'Stripe');
  assert.equal(first.role, 'Software Engineer, Backend');
  assert.equal(first.location, 'Seattle, WA');
  assert.equal(first.ats, 'greenhouse');
  assert.equal(first.externalId, '5501234');
  assert.equal(first.source, 'stripe');
  assert.equal(first.applyUrl, 'https://boards.greenhouse.io/stripe/jobs/5501234');
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, '2026-07-20T22:30:00.000Z');
});

test('greenhouse: company defaults to the slug', async () => {
  const jobs = await fetchGreenhouse('stripe', {
    fetchImpl: fixtureFetch('greenhouse.json'),
  });
  assert.equal(jobs[0].company, 'stripe');
});

test('lever: parses feed into DiscoveredJob[] (ms epoch → ISO)', async () => {
  const jobs = await fetchLever('ramp', {
    fetchImpl: fixtureFetch('lever.json'),
    company: 'Ramp',
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'Ramp');
  assert.equal(first.role, 'Senior Backend Engineer');
  assert.equal(first.location, 'New York, NY');
  assert.equal(first.ats, 'lever');
  assert.equal(first.externalId, '0c1f2e3d-4a5b-6c7d-8e9f-0a1b2c3d4e5f');
  // applyUrl must point at the fillable form (/apply), not the posting page.
  assert.equal(first.applyUrl, 'https://jobs.lever.co/ramp/0c1f2e3d-4a5b-6c7d-8e9f-0a1b2c3d4e5f/apply');
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, new Date(1753021800000).toISOString());
});

test('ashby: parses feed into DiscoveredJob[] (application form url preferred)', async () => {
  const jobs = await fetchAshby('linear', {
    fetchImpl: fixtureFetch('ashby.json'),
    company: 'Linear',
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'Linear');
  assert.equal(first.role, 'Full Stack Engineer');
  assert.equal(first.location, 'Remote, US');
  assert.equal(first.ats, 'ashby');
  assert.equal(first.externalId, 'a1b2c3d4-0001-0002-0003-000400050006');
  // Prefer the application FORM url over the posting url.
  assert.equal(
    first.applyUrl,
    'https://jobs.ashbyhq.com/linear/a1b2c3d4-0001-0002-0003-000400050006/application',
  );
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, '2026-07-19T12:00:00.000Z');
});

test('smartrecruiters: parses postings feed into DiscoveredJob[] (real capture)', async () => {
  const jobs = await fetchSmartRecruiters('Visa', {
    fetchImpl: fixtureFetch('smartrecruiters.json'),
  });

  assert.equal(jobs.length, 2);
  const first = jobs[0];
  assert.equal(first.company, 'Visa'); // defaults to the feed's company name
  assert.equal(first.role, 'Sr. Manager');
  assert.equal(first.location, 'Austin, TX, United States');
  assert.equal(first.ats, 'smartrecruiters');
  assert.equal(first.externalId, '744000133907678');
  assert.equal(first.applyUrl, 'https://jobs.smartrecruiters.com/Visa/744000133907678');
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, '2026-06-24T10:00:11.853Z');
});

test('providers throw on a non-ok response', async () => {
  const badFetch = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  })) as unknown as typeof fetch;

  await assert.rejects(() => fetchGreenhouse('stripe', { fetchImpl: badFetch }), /503/);
});
