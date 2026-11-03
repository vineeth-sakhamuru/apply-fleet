import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiscoveredJob } from '@apply-fleet/discovery';
import {
  rankByRelevance,
  relevanceScore,
  lexicalPreRanker,
  DEFAULT_KEYWORDS,
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

test('a Backend Software Engineer ranks strictly above an off-target role', () => {
  const onTarget = job({ externalId: 'on', role: 'Backend Software Engineer' });
  const offTarget = job({ externalId: 'off', role: 'Marketing Manager' });

  const ranked = rankByRelevance([offTarget, onTarget], DEFAULT_KEYWORDS);
  assert.equal(ranked[0].job.externalId, 'on');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('relevance scores stay within 0..1', () => {
  for (const role of ['Backend Software Engineer', 'Marketing Manager', 'Platform Python API Engineer']) {
    const s = relevanceScore(role);
    assert.ok(s >= 0 && s <= 1, `${role} -> ${s}`);
  }
  assert.equal(relevanceScore('Marketing Manager'), 0);
});

test('rank is stable for equal scores and does not mutate input', () => {
  const a = job({ externalId: 'a', role: 'Data Entry Clerk' });
  const b = job({ externalId: 'b', role: 'Office Assistant' });
  const input = [a, b];
  const ranked = rankByRelevance(input);
  assert.equal(ranked[0].score, ranked[1].score);
  assert.deepEqual(ranked.map((r) => r.job.externalId), ['a', 'b']);
  assert.deepEqual(input.map((j) => j.externalId), ['a', 'b']);
});

test('lexicalPreRanker implements PreRanker and matches rankByRelevance', async () => {
  const jobs = [
    job({ externalId: 'off', role: 'Marketing Manager' }),
    job({ externalId: 'on', role: 'Backend Software Engineer' }),
  ];
  const viaPreRanker = await lexicalPreRanker.rank(jobs);
  const viaFn = rankByRelevance(jobs);
  assert.deepEqual(
    viaPreRanker.map((r) => [r.job.externalId, r.score]),
    viaFn.map((r) => [r.job.externalId, r.score]),
  );
});
