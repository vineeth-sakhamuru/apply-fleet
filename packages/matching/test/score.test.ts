import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiscoveredJob } from '@apply-fleet/discovery';
import { scoreMatch } from '../src/index.ts';

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

const onTarget = job({
  role: 'Backend Software Engineer, Python API Platform',
  location: 'Remote (US)',
});
const weakMatch = job({ role: 'Python Developer', location: 'Austin, TX' });
const ineligible = job({ role: 'Senior Software Engineer', location: 'Seattle, WA' });

test('eligible on-target > eligible weak-match > ineligible (0)', async () => {
  const strong = await scoreMatch(onTarget);
  const weak = await scoreMatch(weakMatch);
  const bad = await scoreMatch(ineligible);

  assert.equal(bad, 0);
  assert.ok(weak > 0, `weak=${weak}`);
  assert.ok(strong > weak, `strong=${strong} weak=${weak}`);
});

test('ineligible stays 0 even if an llmScore is provided', async () => {
  const s = await scoreMatch(ineligible, { llmScore: async () => 100 });
  assert.equal(s, 0);
});

test('llmScore returning null falls back to the deterministic score', async () => {
  const base = await scoreMatch(onTarget);
  const withNull = await scoreMatch(onTarget, { llmScore: async () => null });
  assert.equal(withNull, base);
});

test('llmScore returning a number shifts the score', async () => {
  const base = await scoreMatch(onTarget);
  const high = await scoreMatch(onTarget, { llmScore: async () => 100 });
  const low = await scoreMatch(onTarget, { llmScore: async () => 0 });

  assert.ok(high > base, `high=${high} base=${base}`);
  assert.ok(low < base, `low=${low} base=${base}`);
});
