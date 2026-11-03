import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const tracked = () => git(['ls-files', '-z']).split('\0').filter(Boolean);

test('real PII configs are gitignored and untracked', () => {
  const pii = ['config/profile.yml', 'config/answers.yml', 'config/resume.yml'];
  const ignored = git(['check-ignore', ...pii]).split('\n').filter(Boolean);
  assert.deepEqual(ignored.sort(), pii.slice().sort(), 'every real config must be gitignored');

  const inTree = tracked();
  for (const p of pii) assert.ok(!inTree.includes(p), `${p} must not be tracked`);
});

test('no obvious secret is tracked by git', () => {
  // Files that legitimately contain secret-shaped strings and are NOT secrets:
  // the lockfile (integrity hashes) and this security package's own tests +
  // redact rules (fabricated example patterns).
  const skip = (p: string) =>
    p === 'package-lock.json' ||
    p.startsWith('packages/secure/test/') ||
    p === 'packages/secure/src/redact.ts';

  const checks: Array<[RegExp, string]> = [
    [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key header'],
    // provider-key prefixes with real length — anchored so lockfile hashes miss.
    [/\b(?:sk|gsk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}/, 'provider api key'],
    [/\bAKIA[A-Z0-9]{16}\b/, 'aws access key id'],
  ];
  // `password:`/`token:` with a real value — scoped to tracked config YAML.
  const valued =
    /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*(["']?)(?!\s|$|changeme|example|xxx|placeholder|redacted|null|none|todo|your[-_])[^\s"']{6,}\1/i;

  const nul = String.fromCharCode(0);
  const offenders: string[] = [];
  for (const rel of tracked()) {
    if (skip(rel)) continue;
    let body: string;
    try {
      body = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue; // unreadable
    }
    if (body.includes(nul)) continue; // skip binary files
    for (const [re, label] of checks) {
      if (re.test(body)) offenders.push(`${rel}: ${label}`);
    }
    if (/\.ya?ml$/i.test(rel) && valued.test(body)) {
      offenders.push(`${rel}: password/secret with a value`);
    }
  }
  assert.deepEqual(offenders, [], `tracked secrets found:\n${offenders.join('\n')}`);
});
