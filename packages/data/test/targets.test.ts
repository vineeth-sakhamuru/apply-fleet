import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { loadTargets } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'af-targets-'));
const write = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

test('flattens boards into {ats, slug, company} targets', () => {
  const p = write('t.yml', `
boards:
  greenhouse:
    - stripe
    - figma
  lever:
    - palantir
`);
  const t = loadTargets(p);
  assert.equal(t.boards.length, 3);
  assert.deepEqual(t.boards[0], { ats: 'greenhouse', slug: 'stripe', company: 'stripe' });
  assert.deepEqual(t.boards[2], { ats: 'lever', slug: 'palantir', company: 'palantir' });
});

test("workday's tenant:dc:site slug keeps the tenant as the company label", () => {
  const p = write('wd.yml', `
boards:
  workday:
    - nvidia:wd5:nvidiaexternalcareersite
`);
  const t = loadTargets(p);
  assert.equal(t.boards[0].slug, 'nvidia:wd5:nvidiaexternalcareersite');
  assert.equal(t.boards[0].company, 'nvidia');
});

test('eightfold entries load, and incomplete ones are dropped', () => {
  const p = write('ef.yml', `
boards:
  lever: [palantir]
eightfold:
  - host: apply.careers.microsoft.com
    company: Microsoft
    query: software engineer intern
    location: United States
  - host: broken.example.com
`);
  const t = loadTargets(p);
  assert.equal(t.eightfold.length, 1, 'entry missing company/query is dropped');
  assert.equal(t.eightfold[0].company, 'Microsoft');
  assert.equal(t.eightfold[0].location, 'United States');
});

test('settings default when absent and override when present', () => {
  const bare = loadTargets(write('bare.yml', 'boards:\n  lever: [palantir]\n'));
  assert.equal(bare.settings.concurrency, 8);
  assert.equal(bare.settings.maxAgeHours, 720);

  const set = loadTargets(write('set.yml', `
settings:
  max_age_hours: 24
  concurrency: 3
  poll_minutes: 5
boards:
  lever: [palantir]
`));
  assert.equal(set.settings.maxAgeHours, 24);
  assert.equal(set.settings.concurrency, 3);
  assert.equal(set.settings.pollMinutes, 5);
});

test('an empty registry throws rather than silently discovering nothing', () => {
  assert.throws(() => loadTargets(write('empty.yml', 'boards: {}\n')), /discover nothing/);
});

test('the shipped example config is valid and broad', () => {
  const root = resolvePath(import.meta.dirname, '../../..');
  const t = loadTargets(resolvePath(root, 'config/targets.example.yml'));
  // Guards the regression this file exists to prevent: coverage collapsing back
  // to a handful of hardcoded slugs.
  assert.ok(t.boards.length >= 40, `expected a broad board list, got ${t.boards.length}`);
  const atsFamilies = new Set(t.boards.map((b) => b.ats));
  assert.ok(atsFamilies.size >= 6, `expected 6+ ATS families, got ${atsFamilies.size}`);
  assert.ok(t.eightfold.length >= 1);
});
