import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { existsSync, statSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildTailoredResume, loadResume, resumeFileBase } from '../src/index.ts';
import type { Bullet } from '../src/index.ts';

const source = loadResume(resolve(import.meta.dirname, '../../../config/resume.example.yml'));

// A representative backend JD. "kubernetes" is deliberately NOT in the source —
// it must never surface as a bullet no matter how prominent it is in the JD.
const JD =
  'Backend software engineer to build Python and FastAPI microservices and REST APIs ' +
  'backed by PostgreSQL. Strong SQL skills required. Kubernetes kubernetes kubernetes.';

test('buildTailoredResume writes a non-empty artifact from source bullets only', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'af-resume-'));
  try {
    const res = await buildTailoredResume(source, JD, { outDir });

    // A file exists at the returned path and is non-empty.
    assert.ok(existsSync(res.path), `expected artifact at ${res.path}`);
    assert.ok(statSync(res.path).size > 0, 'artifact should be non-empty');
    assert.ok(['pdf', 'tex'].includes(res.format), `unexpected format ${res.format}`);
    assert.ok(res.path.startsWith(outDir), 'artifact should land in outDir');

    // Every used bullet id traces back to the source (no invention).
    const sourceIds = new Set(source.experience.flatMap((e) => e.bullets.map((b) => b.id)));
    assert.ok(res.usedBulletIds.length > 0, 'expected at least one bullet used');
    for (const id of res.usedBulletIds) assert.ok(sourceIds.has(id), `unknown bullet id ${id}`);

    // A fabricated JD keyword must not appear as a new bullet. Sanity-check the
    // fixture (kubernetes truly unbacked), then confirm it's absent from output.
    const kubBacked = source.experience.some((e) =>
      e.bullets.some(
        (b) => /kubernetes/i.test(b.text) || b.tags.some((t) => /kubernetes/i.test(t)),
      ),
    );
    assert.equal(kubBacked, false, 'fixture invalid: kubernetes should be unbacked');
    if (res.format === 'tex') {
      const tex = readFileSync(res.path, 'utf8');
      assert.match(tex, /FastAPI/, 'expected real source content in the .tex');
      assert.doesNotMatch(tex, /Kubernetes/i, 'fabricated keyword leaked into the résumé');
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('buildTailoredResume throws when a reword introduces an unbacked skill', async () => {
  // acme-1 evidences python/fastapi/rest — never kubernetes.
  const rephrase = async (b: Bullet): Promise<string | null> =>
    b.id === 'acme-1' ? 'Deployed Kubernetes clusters serving the REST API' : null;

  await assert.rejects(
    () => buildTailoredResume(source, JD, { reword: true, rephrase }),
    (err: Error) => /acme-1/.test(err.message) && /kubernetes/i.test(err.message),
  );
});

// The filename a recruiter reads before opening anything. It shipped as
// `resume-1785961311376-3t1k1m.pdf` on a real application.

test('the résumé filename carries the candidate name and role', () => {
  const base = resumeFileBase('Vineeth Sakhamuru', 'Software Engineer, Forward Deployed AI — Ramp\n\nWe are hiring...');
  assert.match(base, /^Vineeth-Sakhamuru-Resume-Software-Engineer/);
  assert.ok(!base.includes('—'), 'no em dash in a filename');
  assert.ok(!/\s/.test(base), 'no spaces in a filename');
  assert.ok(!base.includes('Ramp'), 'the company half of "Role — Company" is dropped');
});

test('the filename survives odd names and empty JDs', () => {
  assert.match(resumeFileBase('Vineeth Sakhamuru', ''), /^Vineeth-Sakhamuru-Resume/);
  // No path separators or dots that could escape the output directory.
  const nasty = resumeFileBase('../../etc/passwd', 'Role/../..');
  assert.ok(!nasty.includes('/'), `path separator leaked: ${nasty}`);
  assert.ok(!nasty.includes('..'), `traversal leaked: ${nasty}`);
});

test('two builds for the same role do not collide', () => {
  const a = resumeFileBase('V S', 'Backend Engineer — X');
  assert.match(a, /-[a-z0-9]{4}$/, 'a short version suffix stays, at the end');
});
