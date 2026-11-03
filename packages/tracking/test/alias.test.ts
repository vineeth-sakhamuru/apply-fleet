import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasFor, appIdFromAddress } from '../src/index.ts';

test('aliasFor builds a plus-aliased address', () => {
  assert.equal(aliasFor('fleet@gmail.com', 'af_123'), 'fleet+af_123@gmail.com');
});

test('appIdFromAddress recovers the id, or undefined', () => {
  assert.equal(appIdFromAddress('fleet+af_123@gmail.com'), 'af_123');
  assert.equal(appIdFromAddress('plain@gmail.com'), undefined);
});

test('alias round-trips', () => {
  const a = aliasFor('fleet@gmail.com', 'af_xyz');
  assert.equal(appIdFromAddress(a), 'af_xyz');
});
