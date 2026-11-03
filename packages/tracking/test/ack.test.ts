import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifySubmitOutcome } from '../src/index.ts';

test('classifies a Greenhouse acknowledgement and recovers app + ats', () => {
  const c = classify({
    to: 'fleet+af_1@gmail.com',
    from: 'no-reply@greenhouse.io',
    subject: 'Thank you for applying to Stripe',
    body: 'We have received your application and will be in touch.',
  });
  assert.equal(c.kind, 'ack');
  assert.equal(c.appId, 'af_1');
  assert.equal(c.ats, 'greenhouse');
});

test('classifies verify / reject / interview', () => {
  assert.equal(
    classify({ to: 'x+a@g.com', from: 'a@ashbyhq.com', subject: 'Verify your email', body: 'click to confirm your email' }).kind,
    'verify',
  );
  assert.equal(
    classify({ to: 'x+a@g.com', from: 'a@lever.co', subject: 'Your application', body: 'Unfortunately we will not be moving forward.' }).kind,
    'reject',
  );
  assert.equal(
    classify({ to: 'x+a@g.com', from: 'a@greenhouse.io', subject: 'Schedule your phone screen', body: 'share your availability' }).kind,
    'interview',
  );
});

test('submit-time success signal only trusts explicit confirmation', () => {
  assert.equal(classifySubmitOutcome({ bodyText: 'Thank you for applying!' }), 'submitted');
  assert.equal(classifySubmitOutcome({ url: 'https://x/confirmation' }), 'submitted');
  assert.equal(classifySubmitOutcome({ httpStatus: 500 }), 'failed');
  assert.equal(classifySubmitOutcome({ httpStatus: 200, bodyText: 'loading' }), 'unknown');
});
