import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupe,
  filterFresh,
  sortNewestFirst,
  type DiscoveredJob,
} from '../src/index.ts';

function job(overrides: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    source: 'stripe',
    externalId: '1',
    company: 'Stripe',
    role: 'Software Engineer',
    location: 'Seattle, WA',
    ats: 'greenhouse',
    applyUrl: 'https://boards.greenhouse.io/stripe/jobs/1',
    postedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

test('dedupe: collapses URLs differing only by query / trailing slash / host case', () => {
  const jobs = [
    job({ externalId: 'a', applyUrl: 'https://boards.greenhouse.io/stripe/jobs/1' }),
    job({ externalId: 'b', applyUrl: 'https://boards.greenhouse.io/stripe/jobs/1/' }),
    job({ externalId: 'c', applyUrl: 'https://boards.greenhouse.io/stripe/jobs/1?gh_src=abc' }),
    job({ externalId: 'd', applyUrl: 'https://BOARDS.greenhouse.io/stripe/jobs/1' }),
  ];
  const out = dedupe(jobs);
  assert.equal(out.length, 1);
  // first occurrence wins
  assert.equal(out[0].externalId, 'a');
});

test('dedupe: keeps genuinely distinct URLs', () => {
  const jobs = [
    job({ externalId: 'a', applyUrl: 'https://boards.greenhouse.io/stripe/jobs/1' }),
    job({ externalId: 'b', applyUrl: 'https://boards.greenhouse.io/stripe/jobs/2' }),
  ];
  assert.equal(dedupe(jobs).length, 2);
});

test('filterFresh: drops a 48h-old job, keeps a 2h-old one', () => {
  const now = Date.parse('2026-07-21T12:00:00.000Z');
  const fresh = job({
    externalId: 'fresh',
    postedAt: new Date(now - 2 * 3600 * 1000).toISOString(),
  });
  const stale = job({
    externalId: 'stale',
    postedAt: new Date(now - 48 * 3600 * 1000).toISOString(),
  });

  const out = filterFresh([fresh, stale], 24, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].externalId, 'fresh');
});

test('filterFresh: keeps jobs with no parseable postedAt (never silent-drop a feed)', () => {
  const now = Date.parse('2026-07-21T12:00:00.000Z');
  // Feeds like Personio/BambooHR/Workday give no date — keep, don't erase them.
  const out = filterFresh([job({ postedAt: '' }), job({ postedAt: 'not-a-date' })], 24, now);
  assert.equal(out.length, 2);
});

test('sortNewestFirst: orders by postedAt descending', () => {
  const oldest = job({ externalId: 'old', postedAt: '2026-07-18T00:00:00.000Z' });
  const middle = job({ externalId: 'mid', postedAt: '2026-07-20T00:00:00.000Z' });
  const newest = job({ externalId: 'new', postedAt: '2026-07-21T00:00:00.000Z' });

  const out = sortNewestFirst([oldest, newest, middle]);
  assert.deepEqual(
    out.map((j) => j.externalId),
    ['new', 'mid', 'old'],
  );
});

test('sortNewestFirst: does not mutate its input', () => {
  const input = [
    job({ externalId: 'old', postedAt: '2026-07-18T00:00:00.000Z' }),
    job({ externalId: 'new', postedAt: '2026-07-21T00:00:00.000Z' }),
  ];
  const before = input.map((j) => j.externalId);
  sortNewestFirst(input);
  assert.deepEqual(input.map((j) => j.externalId), before);
});
