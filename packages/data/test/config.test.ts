import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProfile, loadAnswers } from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');

test('example templates load and validate', () => {
  const profile = loadProfile(resolve(root, 'config/profile.example.yml'));
  assert.ok(profile.candidate.full_name);

  const answers = loadAnswers(resolve(root, 'config/answers.example.yml'));
  assert.ok(answers.authorization);
  assert.ok(answers.eeo);
});

test('real config (if present) loads and validates', () => {
  const profilePath = resolve(root, 'config/profile.yml');
  const answersPath = resolve(root, 'config/answers.yml');
  if (existsSync(profilePath)) {
    const p = loadProfile(profilePath);
    assert.ok(p.candidate.email.includes('@'));
  }
  if (existsSync(answersPath)) {
    const a = loadAnswers(answersPath) as { eeo: Record<string, string> };
    // EEO holds the user's OWN confirmed self-ID (or '' to decline) — filled
    // per explicit instruction, never fabricated. Validate shape, not blankness.
    assert.equal(typeof a.eeo.gender, 'string');
    assert.equal(typeof a.eeo.race_ethnicity, 'string');
  }
});
