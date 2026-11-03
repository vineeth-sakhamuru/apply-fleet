import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tailor, verify, loadResume, extractKeywords, renderLatex } from '../src/index.ts';

const source = loadResume(resolve(import.meta.dirname, '../../../config/resume.example.yml'));
const JD =
  'We are hiring a backend software engineer to build Python and FastAPI microservices ' +
  'and REST APIs backed by PostgreSQL. Strong SQL skills required.';

test('extractKeywords surfaces JD tech terms', () => {
  const kw = extractKeywords(JD);
  for (const t of ['python', 'fastapi', 'postgresql', 'sql', 'backend']) {
    assert.ok(kw.includes(t), `expected keyword ${t}`);
  }
});

test('tailor orders each role by JD relevance, only from source bullets', async () => {
  const tailored = await tailor(source, JD, { maxBulletsPerRole: 4 });

  // Acme's most JD-relevant bullet (python/fastapi/rest) leads.
  const acme = tailored.experience.find((e) => e.company === 'Acme Corp')!;
  assert.equal(acme.bullets[0].id, 'acme-1');
  assert.ok(acme.bullets[0].matched.includes('python'));

  // Every tailored bullet id exists in the source (no invention).
  const sourceIds = new Set(source.experience.flatMap((e) => e.bullets.map((b) => b.id)));
  for (const e of tailored.experience)
    for (const b of e.bullets) assert.ok(sourceIds.has(b.id));

  // JD-overlapping skills float to the front.
  assert.ok(['Python', 'FastAPI', 'PostgreSQL', 'SQL'].includes(tailored.skills[0]));
});

test('a legit tailoring passes the no-fabrication verifier', async () => {
  const tailored = await tailor(source, JD);
  const { ok, violations } = verify(tailored, source);
  assert.ok(ok, JSON.stringify(violations));
});

test('renderLatex produces a compilable-looking .tex with real content', async () => {
  const tailored = await tailor(source, JD);
  const tex = renderLatex(tailored);
  assert.match(tex, /\\documentclass/);
  assert.match(tex, /Jordan Example/);
  assert.match(tex, /FastAPI/);
});
