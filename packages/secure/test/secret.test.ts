import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecret } from '../src/index.ts';

test('env var takes priority (verbatim name)', () => {
  process.env['af-test-secret'] = 'from-env';
  try {
    assert.equal(loadSecret('af-test-secret'), 'from-env');
  } finally {
    delete process.env['af-test-secret'];
  }
});

test('env var matched via UPPER_SNAKE form', () => {
  process.env.AF_TEST_KEY = 'snake-env';
  try {
    assert.equal(loadSecret('af-test-key'), 'snake-env');
  } finally {
    delete process.env.AF_TEST_KEY;
  }
});

test('falls back to ~/.config/apply-fleet/<name> file', () => {
  const home = mkdtempSync(join(tmpdir(), 'af-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, '.config', 'apply-fleet'), { recursive: true });
    writeFileSync(join(home, '.config', 'apply-fleet', 'af-file-secret'), 'from-file\n');
    // name not in env, not in keychain → resolves from the file (trimmed).
    assert.equal(loadSecret('af-file-secret'), 'from-file');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing secret returns undefined (never throws)', () => {
  assert.equal(loadSecret('af-definitely-absent-secret-xyz'), undefined);
});
