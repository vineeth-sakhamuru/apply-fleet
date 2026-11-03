import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tailor, verifyTraceable, loadResume } from '../src/index.ts';
import type { TailoredResume } from '../src/index.ts';

const source = loadResume(resolve(import.meta.dirname, '../../../config/resume.example.yml'));
const JD = 'backend software engineer python fastapi postgresql sql react docker';

async function legit(): Promise<TailoredResume> {
  return tailor(source, JD);
}

test('a legitimately tailored résumé traces cleanly', async () => {
  const { ok, violations } = verifyTraceable(await legit(), source);
  assert.ok(ok, JSON.stringify(violations));
});

test('flags an invented employer', async () => {
  const t = await legit();
  t.experience.push({
    company: 'Globex Industries',
    role: 'Software Engineer Intern', // real title, fake company
    start: '2022-01',
    end: '2022-06',
    bullets: [{ id: 'globex-1', text: 'Built Python services', matched: [] }],
  });
  const { ok, violations } = verifyTraceable(t, source);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => /invented employer/i.test(v) && /globex/i.test(v)), violations.join(' | '));
});

test('flags an invented skill added to the skills list', async () => {
  const t = await legit();
  t.skills = [...t.skills, 'Kubernetes'];
  const { ok, violations } = verifyTraceable(t, source);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => /unbacked skill/i.test(v) && /kubernetes/i.test(v)), violations.join(' | '));
});

test('flags an invented skill smuggled into a bullet under a real employer', async () => {
  const t = await legit();
  // acme-1 keeps its real id but is reworded to claim a skill the source never
  // evidences ANYWHERE — the whole-résumé check must still catch it.
  const b = t.experience.find((e) => e.company === 'Acme Corp')!.bullets[0];
  b.text = 'Deployed Kubernetes clusters serving the REST API';
  const { ok, violations } = verifyTraceable(t, source);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => /kubernetes/i.test(v) && new RegExp(b.id).test(v)), violations.join(' | '));
});

test('flags an invented degree', async () => {
  const t = await legit();
  t.education = [{ school: 'Fictional Institute', degree: 'PhD Astrophysics', start: '2019', end: '2023' }];
  const { ok, violations } = verifyTraceable(t, source);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => /invented education/i.test(v)), violations.join(' | '));
});
