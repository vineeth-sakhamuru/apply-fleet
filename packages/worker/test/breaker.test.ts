import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, domainOf } from '../src/breaker.ts';

// When a domain fails it fails for every application on it at once — we watched
// all 127 Workday tenants return zero under one burst. The breaker learns that
// fact once instead of 127 times.

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const CAPTCHA = new Error('hCaptcha challenge detected');   // permanent
const FLAKY = new Error('net::ERR_TIMED_OUT');              // transient
const url = (h: string) => `https://${h}/jobs/1/apply`;

test('groups by host', () => {
  assert.equal(domainOf('https://ACME.wd5.myworkdayjobs.com/x?y=1'), 'acme.wd5.myworkdayjobs.com');
  assert.equal(domainOf('not a url'), 'invalid');
});

test('opens after the threshold of PERMANENT failures', () => {
  const c = clock();
  const b = new CircuitBreaker({ threshold: 3, now: c.now });
  assert.equal(b.record(url('a.com'), CAPTCHA), false);
  assert.equal(b.record(url('a.com'), CAPTCHA), false);
  assert.equal(b.record(url('a.com'), CAPTCHA), true, 'the third trips it');
  assert.equal(b.isOpen(url('a.com')), true);
});

test('transient flakiness never trips it — that is what retries are for', () => {
  const b = new CircuitBreaker({ threshold: 2 });
  for (let i = 0; i < 10; i++) b.record(url('a.com'), FLAKY);
  assert.equal(b.isOpen(url('a.com')), false, 'ordinary network noise must not pause a domain');
});

test('one domain opening does not affect another', () => {
  const b = new CircuitBreaker({ threshold: 2 });
  b.record(url('a.com'), CAPTCHA);
  b.record(url('a.com'), CAPTCHA);
  assert.equal(b.isOpen(url('a.com')), true);
  assert.equal(b.isOpen(url('b.com')), false);
});

test('the circuit closes after the cooldown', () => {
  const c = clock();
  const b = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, now: c.now });
  b.record(url('a.com'), CAPTCHA);
  assert.equal(b.isOpen(url('a.com')), true);
  assert.equal(b.opensIn(url('a.com')), 60_000);
  c.advance(60_001);
  assert.equal(b.isOpen(url('a.com')), false);
});

test('failures outside the window do not accumulate', () => {
  const c = clock();
  const b = new CircuitBreaker({ threshold: 3, windowMs: 10_000, now: c.now });
  b.record(url('a.com'), CAPTCHA);
  c.advance(11_000);
  b.record(url('a.com'), CAPTCHA);
  c.advance(11_000);
  b.record(url('a.com'), CAPTCHA);
  assert.equal(b.isOpen(url('a.com')), false, 'three failures spread over 22s is not an outage');
});

test('a success closes it early — the domain is demonstrably back', () => {
  const b = new CircuitBreaker({ threshold: 1 });
  b.record(url('a.com'), CAPTCHA);
  assert.equal(b.isOpen(url('a.com')), true);
  b.recordSuccess(url('a.com'));
  assert.equal(b.isOpen(url('a.com')), false);
});

test('snapshot reports what tripped, for /api/metrics', () => {
  const b = new CircuitBreaker({ threshold: 1 });
  b.record(url('slow.com'), CAPTCHA);
  const [row] = b.snapshot();
  assert.equal(row.domain, 'slow.com');
  assert.equal(row.open, true);
  assert.equal(row.trips, 1);
});
