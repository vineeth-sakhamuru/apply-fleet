import test from 'node:test';
import assert from 'node:assert/strict';
import { isSubmitConfirmed } from '../src/executor.ts';

// The submit-confirmation predicate is what stops the system from recording a
// false receipt when a click silently fails (the exact way cloud-only
// auto-submitters break). It must say "confirmed" only on real acknowledgement.

test('confirmed when the URL moves to a thank-you / confirmation route', () => {
  assert.equal(isSubmitConfirmed('https://jobs.lever.co/x/apply', 'https://jobs.lever.co/x/thanks', ''), true);
  assert.equal(isSubmitConfirmed('https://boards.greenhouse.io/x', 'https://boards.greenhouse.io/x/confirmation', ''), true);
  assert.equal(isSubmitConfirmed('https://a/apply', 'https://a/application-sent', ''), true);
});

test('confirmed when the page text acknowledges the application', () => {
  assert.equal(isSubmitConfirmed('u', 'u', 'Thank you for applying! Your application has been received.'), true);
  assert.equal(isSubmitConfirmed('u', 'u', 'We have received your application.'), true);
  assert.equal(isSubmitConfirmed('u', 'u', 'Successfully submitted.'), true);
});

test('NOT confirmed when nothing changed and no acknowledgement — a silent failed submit', () => {
  assert.equal(isSubmitConfirmed('https://a/apply', 'https://a/apply', 'Please fix the errors below and resubmit.'), false);
  assert.equal(isSubmitConfirmed('https://a/apply', 'https://a/apply', ''), false);
  // A URL change alone is not enough — it must look like a confirmation route,
  // otherwise a redirect to a login wall would read as success.
  assert.equal(isSubmitConfirmed('https://a/apply', 'https://a/login', 'Sign in to continue'), false);
});
