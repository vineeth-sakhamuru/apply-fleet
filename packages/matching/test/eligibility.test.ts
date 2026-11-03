import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiscoveredJob } from '@apply-fleet/discovery';
import { isEligible, classifyLocation, DEFAULT_RULES } from '../src/index.ts';

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

test('DEFAULT_RULES is U.S.-only', () => {
  assert.equal(DEFAULT_RULES.usOnly, true);
});

test('Senior Software Engineer is ineligible with a level reason', () => {
  const { eligible, reasons } = isEligible(job({ role: 'Senior Software Engineer' }));
  assert.equal(eligible, false);
  assert.ok(reasons.includes('level: senior'));
});

test('other blocked levels are rejected too', () => {
  for (const [role, word] of [
    ['Staff Software Engineer', 'staff'],
    ['Principal Backend Engineer', 'principal'],
    ['Engineering Manager', 'manager'],
    ['Software Architect', 'architect'],
    ['Tech Lead, Platform', 'lead'],
  ] as const) {
    const { eligible, reasons } = isEligible(job({ role }));
    assert.equal(eligible, false, role);
    assert.ok(reasons.includes(`level: ${word}`), `${role} -> level: ${word}`);
  }
});

test('Software Engineer in London, UK is ineligible on location', () => {
  const { eligible, reasons } = isEligible(
    job({ role: 'Software Engineer', location: 'London, UK' }),
  );
  assert.equal(eligible, false);
  assert.ok(reasons.includes('location: non-US'));
});

test('other clearly non-US locations are ineligible', () => {
  for (const location of ['Bangalore, India', 'Remote (EU)', 'Toronto, Canada']) {
    const { eligible, reasons } = isEligible(job({ location }));
    assert.equal(eligible, false, location);
    assert.ok(reasons.includes('location: non-US'), location);
  }
});

test('clearance requirement is ineligible', () => {
  const { eligible, reasons } = isEligible(
    job({ role: 'Software Engineer (TS/SCI clearance required)' }),
  );
  assert.equal(eligible, false);
  assert.ok(reasons.includes('requires citizenship/clearance'));
});

test('U.S. citizenship requirement is ineligible', () => {
  const { eligible, reasons } = isEligible(
    job({ role: 'Software Engineer, U.S. Citizens only' }),
  );
  assert.equal(eligible, false);
  assert.ok(reasons.includes('requires citizenship/clearance'));
});

test('"no sponsorship" does NOT make a role ineligible (PR needs none)', () => {
  const { eligible, reasons } = isEligible(
    job({ role: 'Software Engineer (no sponsorship available)', location: 'Austin, TX' }),
  );
  assert.equal(eligible, true, reasons.join(', '));
});

test('New Grad Software Engineer, Remote (US) is eligible', () => {
  const { eligible, reasons } = isEligible(
    job({ role: 'New Grad Software Engineer', location: 'Remote (US)' }),
  );
  assert.equal(eligible, true, reasons.join(', '));
  assert.deepEqual(reasons, []);
});

test('a non-SWE title is rejected with a title reason', () => {
  const { eligible, reasons } = isEligible(
    job({ role: 'Marketing Manager', location: 'Austin, TX' }),
  );
  assert.equal(eligible, false);
  assert.ok(reasons.includes('title: not a SWE role'));
});

test('classifyLocation recognizes US, non-US, and unknown', () => {
  assert.equal(classifyLocation('Seattle, WA'), 'us');
  assert.equal(classifyLocation('Remote (US)'), 'us');
  assert.equal(classifyLocation('United States'), 'us');
  assert.equal(classifyLocation('London, UK'), 'non-us');
  assert.equal(classifyLocation('Remote (EU)'), 'non-us');
  assert.equal(classifyLocation('Somewhere'), 'unknown');
});
