import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVerifyLink } from '../src/index.ts';

test('returns the confirm link from a Greenhouse-style html email (in-scope)', () => {
  const html = `<p>Thanks for applying! Please
    <a href="https://app.greenhouse.io/confirm_email?token=abc123">confirm your email address</a>
    to finish your application.</p>
    <a href="https://boards.greenhouse.io/unsubscribe">unsubscribe</a>`;
  const link = extractVerifyLink({ subject: 'Confirm your email', html }, [
    'greenhouse.io',
  ]);
  assert.equal(link, 'https://app.greenhouse.io/confirm_email?token=abc123');
});

test('returns the verify link from a Lever-style text email (in-scope)', () => {
  const text =
    'Please verify your email address: https://hire.lever.co/verify/xyz-789\nThanks, Lever';
  const link = extractVerifyLink({ subject: 'Verify your email', text }, [
    'lever.co',
  ]);
  assert.equal(link, 'https://hire.lever.co/verify/xyz-789');
});

test('returns null for a phishing email to an unrelated look-alike domain', () => {
  const html = `<a href="https://secure-greenh0use-verify.com/verify?u=you">Verify your account now</a>`;
  const link = extractVerifyLink(
    { subject: 'Verify your account', html },
    ['greenhouse.io'],
  );
  assert.equal(link, null);
});

test('suffix-spoofed host does not pass the allowlist', () => {
  const html = `<a href="https://greenhouse.io.evil.com/confirm">confirm your email</a>`;
  assert.equal(extractVerifyLink({ html }, ['greenhouse.io']), null);
});

test('a non-https verify link is never returned', () => {
  const text = 'confirm your email: http://app.greenhouse.io/confirm?t=1';
  assert.equal(
    extractVerifyLink({ subject: 'confirm your email', text }, ['greenhouse.io']),
    null,
  );
});

test('ambiguous in-scope links with no verify hint return null', () => {
  const html = `<a href="https://app.greenhouse.io/jobs">jobs</a> <a href="https://app.greenhouse.io/help">help</a>`;
  assert.equal(
    extractVerifyLink({ subject: 'Application received', html }, ['greenhouse.io']),
    null,
  );
});
