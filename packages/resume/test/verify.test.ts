import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tailor, verify, loadResume } from '../src/index.ts';
import type { TailoredResume } from '../src/index.ts';

const source = loadResume(resolve(import.meta.dirname, '../../../config/resume.example.yml'));
const JD = 'backend software engineer python fastapi postgresql sql';

async function legit(): Promise<TailoredResume> {
  return tailor(source, JD);
}

test('rejects a bullet whose id is not in the source', async () => {
  const t = await legit();
  t.experience[0].bullets.push({ id: 'ghost', text: 'Led a team of 5', matched: [] });
  const { ok, violations } = verify(t, source);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.bulletId === 'ghost' && /not in source/.test(v.reason)));
});

test('rejects a rewrite that introduces an unbacked skill', async () => {
  const t = await legit();
  // acme-1 evidences python/fastapi/rest — never kubernetes.
  const b = t.experience.find((e) => e.company === 'Acme Corp')!.bullets.find((x) => x.id === 'acme-1')!;
  b.text = 'Deployed Kubernetes clusters serving the REST API';
  const { ok, violations } = verify(t, source);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.bulletId === 'acme-1' && /kubernetes/.test(v.reason)));
});

test('accepts a rewrite that only rewords backed claims', async () => {
  const t = await legit();
  const b = t.experience.find((e) => e.company === 'Acme Corp')!.bullets.find((x) => x.id === 'acme-1')!;
  // Reword within what's backed (python, fastapi, rest, api all present in source).
  b.text = 'Designed and shipped Python FastAPI REST API endpoints';
  const { ok, violations } = verify(t, source);
  assert.ok(ok, JSON.stringify(violations));
});
