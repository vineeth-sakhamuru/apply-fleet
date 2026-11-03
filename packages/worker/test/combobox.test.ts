import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreOption, pickOption } from '../src/index.ts';

// Typeahead comboboxes. Typing into one does NOT fill it — a live Ramp
// application sat at "San Jose, CA" with the dropdown open and nothing
// committed, which is why its submit bounced. Picking the right option is the
// whole job, and the list is adversarial: four other San Joses outrank
// California on a naive prefix match.

const RAMP_LOCATIONS = [
  'San Jose, Camarines Sur, Philippines',
  'San José, Caldas, Colombia',
  'San Jose, California, United States',
  'San José, Catamarca, Argentina',
  'San José Cancasque, Chalatenango, El Salvador',
];

test('picks the US city over identically-named cities abroad', () => {
  const idx = pickOption(RAMP_LOCATIONS, 'San Jose, CA');
  assert.equal(idx, 2);
  assert.equal(RAMP_LOCATIONS[idx!], 'San Jose, California, United States');
});

test('the state abbreviation is what breaks the tie', () => {
  const ca = scoreOption('San Jose, California, United States', 'San Jose, CA');
  const ph = scoreOption('San Jose, Camarines Sur, Philippines', 'San Jose, CA');
  assert.ok(ca! > ph!, 'CA must expand to California and outrank the Philippines');
});

test('an exact match wins outright', () => {
  assert.equal(scoreOption('San Jose, CA', 'San Jose, CA'), 200);
});

test('a non-match is null, never a fallback pick', () => {
  assert.equal(scoreOption('Austin, Texas, United States', 'San Jose, CA'), null);
  assert.equal(pickOption(['Austin, TX', 'Denver, CO'], 'San Jose, CA'), null);
});

test('an empty option list yields no pick — the field reports unfilled', () => {
  assert.equal(pickOption([], 'San Jose, CA'), null);
});

test('works for non-location typeaheads (school lists)', () => {
  const schools = ['Northeastern Illinois University', 'Northeastern University', 'Northwestern University'];
  const idx = pickOption(schools, 'Northeastern University');
  assert.equal(schools[idx!], 'Northeastern University', 'exact match beats a longer prefix match');
});
