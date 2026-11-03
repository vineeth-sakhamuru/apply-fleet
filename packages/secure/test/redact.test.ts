import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactString, safeLog } from '../src/index.ts';

test('scrubs each PII / credential kind', () => {
  const cases: Array<[string, string]> = [
    ['reach me at jane.doe@example.com today', 'email'],
    ['call 408-555-0142 or (408) 555-0199', 'phone'],
    ['ssn 123-45-6789 on file', 'ssn'],
    ['ssn 123456789 on file', 'ssn'],
    ['Authorization: Bearer abc123.DEF-456_ghi', 'bearer'],
    ['groq key gsk_ABCdef0123456789ghjk', 'key'],
    ['aws AKIAIOSFODNN7EXAMPLE here', 'key'],
    ['password: hunter2super', 'key'],
    ['api_key=sk-not-a-real-value-000', 'key'],
    ['hash 0123456789abcdef0123456789abcdef01234567 end', 'token'],
    ['lives at 123 Main Street Apt 4', 'address'],
  ];
  for (const [input, kind] of cases) {
    const out = redactString(input);
    assert.match(out, new RegExp(`‹redacted:${kind}›`), `${kind}: ${input} → ${out}`);
  }
});

test('does not mangle clean text', () => {
  const clean = 'Software Engineer role at Acme, remote in the US.';
  assert.equal(redactString(clean), clean);
});

test('phone rule keeps the label but drops the number', () => {
  assert.equal(redactString('call 408-555-0142'), 'call ‹redacted:phone›');
});

test('password rule keeps the label, redacts only the value', () => {
  assert.equal(redactString('password: hunter2super'), 'password: ‹redacted:key›');
});

test('redact walks objects/arrays and preserves structure + non-strings', () => {
  const out = redact({
    name: 'jane.doe@example.com',
    age: 30,
    phones: ['408-555-0142'],
    nested: { ssn: '123-45-6789' },
  });
  assert.deepEqual(out, {
    name: '‹redacted:email›',
    age: 30,
    phones: ['‹redacted:phone›'],
    nested: { ssn: '‹redacted:ssn›' },
  });
});

test('safeLog redacts every argument before printing', () => {
  const orig = console.log;
  const seen: unknown[] = [];
  console.log = (...a: unknown[]) => void seen.push(a);
  try {
    safeLog('token for', 'jane.doe@example.com', { phone: '408-555-0142' });
  } finally {
    console.log = orig;
  }
  assert.deepEqual(seen[0], ['token for', '‹redacted:email›', { phone: '‹redacted:phone›' }]);
});
