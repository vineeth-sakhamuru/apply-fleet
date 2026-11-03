import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeLinks } from '../src/index.ts';

const applied = ['greenhouse.io', 'jobs.ashbyhq.com'];

test('only https links to applied-to hosts are safe to auto-open', () => {
  const { safe, blocked } = scopeLinks(
    [
      'https://boards.greenhouse.io/verify?token=1', // subdomain of applied → safe
      'https://jobs.ashbyhq.com/confirm', // exact applied → safe
      'https://evil.com/verify', // unknown host → blocked
      'http://greenhouse.io/insecure', // not https → blocked
      'not a url', // unparseable → blocked
    ],
    applied,
  );
  assert.deepEqual(safe.sort(), [
    'https://boards.greenhouse.io/verify?token=1',
    'https://jobs.ashbyhq.com/confirm',
  ]);
  assert.equal(blocked.length, 3);
});

test('suffix-spoofing does not pass the allowlist', () => {
  const { safe, blocked } = scopeLinks(
    ['https://greenhouse.io.evil.com/steal', 'https://notgreenhouse.io/x'],
    applied,
  );
  assert.equal(safe.length, 0);
  assert.equal(blocked.length, 2);
});
