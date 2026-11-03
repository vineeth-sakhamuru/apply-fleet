import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchApify, APIFY_ACTORS, type ApifyRunner } from '../src/providers/apify.ts';

/**
 * Fixtures use the REAL documented output field names of each Actor (from the
 * Apify Store output examples) — values are representative. Both Actors are
 * paid with no free tier, so the live run is gated; this exercises the mapping
 * contract against the real schema, per the deliverable.
 */

// curious_coder/linkedin-jobs-scraper — real output keys.
const LINKEDIN_ITEMS = [
  {
    id: '3901234567',
    link: 'https://www.linkedin.com/jobs/view/3901234567',
    title: 'Software Engineer, Backend',
    companyName: 'Acme Corp',
    location: 'San Jose, CA',
    postedAt: '2026-07-29T10:00:00.000Z',
    postedAtTimestamp: 1785753600000,
    applyUrl: 'https://acme.com/careers/apply/3901234567',
  },
];

// fantastic-jobs/career-site-job-listing-api — real output keys.
const CAREER_SITE_ITEMS = [
  {
    id: 987654321,
    title: 'Backend Engineer',
    organization: 'Globex',
    url: 'https://boards.greenhouse.io/globex/jobs/987654321',
    date_posted: '2026-07-30T08:30:00Z',
    locations_derived: ['New York, NY, United States'],
    source: 'greenhouse',
    source_domain: 'boards.greenhouse.io',
  },
];

function runnerReturning(items: unknown[]): { runActor: ApifyRunner; seen: { actor?: string; input?: Record<string, unknown> } } {
  const seen: { actor?: string; input?: Record<string, unknown> } = {};
  const runActor: ApifyRunner = async (actor, input) => {
    seen.actor = actor;
    seen.input = input;
    return items;
  };
  return { runActor, seen };
}

test('apify: maps LinkedIn Actor items → DiscoveredJob[] and targets the right Actor', async () => {
  const { runActor, seen } = runnerReturning(LINKEDIN_ITEMS);
  const jobs = await fetchApify('software engineer', { actor: 'linkedin', runActor, location: 'San Jose' });

  assert.equal(seen.actor, APIFY_ACTORS.linkedin);
  // LinkedIn scraping is expressed as a LinkedIn search URL run ON the Actor.
  assert.ok(Array.isArray(seen.input?.urls));
  assert.ok(String((seen.input?.urls as string[])[0]).includes('linkedin.com/jobs/search'));

  assert.equal(jobs.length, 1);
  const j = jobs[0];
  assert.equal(j.ats, 'linkedin');
  assert.equal(j.company, 'Acme Corp');
  assert.equal(j.role, 'Software Engineer, Backend');
  assert.equal(j.externalId, '3901234567');
  assert.equal(j.applyUrl, 'https://acme.com/careers/apply/3901234567');
  assert.equal(j.location, 'San Jose, CA');
  assert.equal(j.postedAt, '2026-07-29T10:00:00.000Z');
});

test('apify: career-site Actor items keep their real employer ATS from `source`', async () => {
  const { runActor, seen } = runnerReturning(CAREER_SITE_ITEMS);
  const jobs = await fetchApify('backend engineer', { actor: 'career-site', runActor });

  assert.equal(seen.actor, APIFY_ACTORS['career-site']);
  assert.deepEqual(seen.input?.titleSearch, ['backend engineer']);

  const j = jobs[0];
  assert.equal(j.ats, 'greenhouse'); // source → native ATS, so it routes to the right fill map
  assert.equal(j.company, 'Globex');
  assert.equal(j.externalId, '987654321');
  assert.equal(j.applyUrl, 'https://boards.greenhouse.io/globex/jobs/987654321');
  assert.equal(j.location, 'New York, NY, United States');
  assert.equal(j.postedAt, '2026-07-30T08:30:00.000Z');
  assert.equal(j.source, 'boards.greenhouse.io');
});

test('apify: an unknown career-site source falls into the linkedin/aggregator bucket', async () => {
  const { runActor } = runnerReturning([
    { id: 1, title: 'X', organization: 'Y', url: 'https://y.com/j/1', date_posted: '2026-07-30T00:00:00Z', source: 'someobscureats' },
  ]);
  const jobs = await fetchApify('x', { actor: 'career-site', runActor });
  assert.equal(jobs[0].ats, 'linkedin');
});

test('apify: live run is GATED without a runActor (never silently empty)', async () => {
  await assert.rejects(() => fetchApify('software engineer', { actor: 'linkedin' }), /gated/);
  await assert.rejects(() => fetchApify('x', { actor: 'career-site' }), /paid Actor/);
});

test('apify: a non-array dataset is an error, not empty', async () => {
  const runActor = (async () => ({ notAnArray: true })) as unknown as ApifyRunner;
  await assert.rejects(() => fetchApify('x', { runActor }), /non-array/);
});
