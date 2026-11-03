import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEightfoldRow,
  parseRelativeAge,
  eightfoldSearchUrl,
  fetchEightfold,
  type EightfoldRow,
  type EightfoldOpts,
} from '../src/providers/eightfold.ts';

// Card strings below are VERBATIM from a live Microsoft Eightfold board
// (apply.careers.microsoft.com, 2026-08-04), so the parser is tested against
// the markup it actually has to survive.

const NOW = Date.parse('2026-08-04T20:00:00.000Z');
const opts: EightfoldOpts = {
  host: 'apply.careers.microsoft.com',
  company: 'Microsoft',
  query: 'software engineer intern',
  now: () => NOW,
};

test('parseRelativeAge handles the phrasings the board emits', () => {
  assert.equal(parseRelativeAge('Posted 21 hours ago', NOW), NOW - 21 * 3_600_000);
  assert.equal(parseRelativeAge('Posted 2 days ago', NOW), NOW - 2 * 86_400_000);
  assert.equal(parseRelativeAge('Posted a day ago', NOW), NOW - 86_400_000);
  assert.equal(parseRelativeAge('Posted 2 months ago', NOW), NOW - 2 * 2_592_000_000);
  // Unrecognized → null, so the caller drops the row instead of inventing a date.
  assert.equal(parseRelativeAge('Posted recently', NOW), null);
  assert.equal(parseRelativeAge('', NOW), null);
});

test('normalizes a real intern card into a job with location and postedAt', () => {
  const row: EightfoldRow = {
    id: '1970393556922930',
    title: 'Software Engineer: Security & Identity Intern Opportunities for University Students, Redmond',
    location: 'United States, Washington, Redmond',
    posted: 'Posted 21 hours ago',
  };
  const job = normalizeEightfoldRow(row, opts)!;
  assert.ok(job, 'should normalize');
  assert.equal(job.company, 'Microsoft');
  assert.equal(job.ats, 'eightfold');
  assert.equal(job.externalId, '1970393556922930');
  assert.match(job.role, /Security & Identity Intern/);
  assert.equal(job.location, 'United States, Washington, Redmond');
  assert.equal(job.applyUrl, 'https://apply.careers.microsoft.com/careers/job/1970393556922930');
  assert.equal(job.postedAt, new Date(NOW - 21 * 3_600_000).toISOString());
  // Regression: the location must never swallow the role, and the role must
  // never carry the location or the 'Posted …' suffix. A first cut read the
  // anchor's combined textContent, which concatenates all three with no
  // separator, and produced exactly that corruption live.
  assert.ok(!job.location.includes('Software Engineer'), 'role must not bleed into location');
  assert.ok(!/Posted/i.test(job.role), 'date must not bleed into role');
  assert.ok(!/United States/.test(job.role), 'location must not bleed into role');
});

test('role and location stay separate for every scraped card', () => {
  const row: EightfoldRow = {
    id: '1970393556951950',
    title: 'Software Engineer: Intern Opportunities for University Students - CoreAI',
    location: 'United States, Washington, Redmond',
    posted: 'Posted 2 days ago',
  };
  const job = normalizeEightfoldRow(row, opts)!;
  assert.equal(job.location, 'United States, Washington, Redmond');
  assert.equal(job.role, 'Software Engineer: Intern Opportunities for University Students - CoreAI');
});

test('untrustworthy cards are dropped, never fabricated', () => {
  assert.equal(normalizeEightfoldRow({ id: '', title: 'x', location: 'US', posted: 'Posted 1 day ago' }, opts), null);
  assert.equal(normalizeEightfoldRow({ id: '1', title: '', location: 'US', posted: 'Posted 1 day ago' }, opts), null);
  // No parseable date → dropped, because a wrong postedAt corrupts freshness order.
  assert.equal(normalizeEightfoldRow({ id: '1', title: 'SWE Intern', location: 'Redmond', posted: '' }, opts), null);
});

test('search URL uses the query form that actually returns hits', () => {
  const u = new URL(eightfoldSearchUrl(opts));
  assert.equal(u.host, 'apply.careers.microsoft.com');
  assert.equal(u.pathname, '/careers');
  assert.equal(u.searchParams.get('query'), 'software engineer intern');
  assert.equal(u.searchParams.get('location'), 'United States');
});

test('fetchEightfold maps scraped rows through the normalizer', async () => {
  const rows: EightfoldRow[] = [
    { id: '111', title: 'Software Engineer: AI/ML & LLM Intern Opportunities', location: 'United States, Washington, Redmond', posted: 'Posted 21 hours ago' },
    { id: '222', title: 'Bad row', location: 'US', posted: 'no date here' },
  ];
  let visited = '';
  const page = {
    goto: async (url: string) => { visited = url; },
    waitForTimeout: async () => {},
    evaluate: async <T>() => rows as unknown as T,
  };
  const jobs = await fetchEightfold(page, { ...opts, settleMs: 0 });
  assert.match(visited, /\/careers\?query=/);
  assert.equal(jobs.length, 1, 'the undated row is dropped');
  assert.equal(jobs[0].externalId, '111');
  assert.equal(jobs[0].ats, 'eightfold');
});
