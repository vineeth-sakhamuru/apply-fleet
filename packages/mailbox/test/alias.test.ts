import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasFor } from '../src/index.ts';

test('aliasFor is deterministic — same id ⇒ same alias', () => {
  assert.equal(
    aliasFor('fleet@gmail.com', 'af_123'),
    aliasFor('fleet@gmail.com', 'af_123'),
  );
});

test('aliasFor preserves the base local-part and domain', () => {
  const a = aliasFor('fleet.jobs@gmail.com', 'af_123');
  const [local, domain] = a.split('@');
  assert.ok(local.startsWith('fleet.jobs+'), local);
  assert.equal(domain, 'gmail.com');
});

test('distinct ids give distinct aliases', () => {
  assert.notEqual(
    aliasFor('fleet@gmail.com', 'af_1'),
    aliasFor('fleet@gmail.com', 'af_2'),
  );
});

test('aliasFor rejects a malformed base address', () => {
  assert.throws(() => aliasFor('not-an-email', 'af_1'));
  assert.throws(() => aliasFor('@gmail.com', 'af_1'));
  assert.throws(() => aliasFor('fleet@', 'af_1'));
});
