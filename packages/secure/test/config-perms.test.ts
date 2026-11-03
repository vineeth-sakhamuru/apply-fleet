import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertConfigPerms, lockFile } from '../src/index.ts';

test('flags group/world-readable config, ignores examples, and lockFile fixes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-config-'));
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(String(a[0]));
  try {
    const real = join(dir, 'profile.yml');
    const example = join(dir, 'profile.example.yml');
    writeFileSync(real, 'candidate: {}\n');
    writeFileSync(example, 'candidate: {}\n');
    chmodSync(real, 0o644); // group/world readable
    chmodSync(example, 0o644); // template — must be ignored

    const loose = assertConfigPerms(dir);
    assert.deepEqual(loose, [real], 'only the real, non-example, loose file is flagged');
    assert.equal(warned.length, 1);

    lockFile(real);
    assert.equal(statSync(real).mode & 0o777, 0o600);
    assert.deepEqual(assertConfigPerms(dir), [], 'nothing loose after chmod 600');
  } finally {
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing config dir returns [] without throwing', () => {
  assert.deepEqual(assertConfigPerms(join(tmpdir(), 'af-nope-does-not-exist')), []);
});
