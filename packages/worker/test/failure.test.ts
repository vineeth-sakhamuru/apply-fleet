import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, withRetry } from '../src/failure.ts';

const noSleep = () => Promise.resolve();

test('classifyFailure buckets transient errors', () => {
  const transient = [
    new Error('Navigation timeout of 30000 ms exceeded'),
    new Error('net::ERR_CONNECTION_RESET at https://jobs.example.com'),
    Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
    new Error('getaddrinfo ENOTFOUND jobs.example.com'),
    new Error('socket hang up'),
    new Error('503 Service Unavailable'),
    new Error('429 Too Many Requests'),
    'network error while loading page',
  ];
  for (const e of transient) {
    assert.equal(classifyFailure(e), 'transient', `expected transient: ${e}`);
  }
});

test('classifyFailure buckets permanent errors', () => {
  const permanent = [
    new Error('Cloudflare Turnstile captcha challenge detected'),
    new Error('Are you a human? Please verify (anti-bot wall)'),
    new Error('Apply form not found on page'),
    new Error('locator not found: #apply-button no longer in DOM'),
    new Error('element is detached from the document'),
    new Error('HTTP 403 Access Denied'),
    new Error('HTTP 404 posting closed'),
  ];
  for (const e of permanent) {
    assert.equal(classifyFailure(e), 'permanent', `expected permanent: ${e}`);
  }
});

test('classifyFailure: permanent signal wins over an accompanying timeout', () => {
  // A timeout WAITING for a captcha is still a wall — do not retry it.
  assert.equal(classifyFailure(new Error('Timeout waiting for captcha iframe')), 'permanent');
});

test('classifyFailure: unrecognized errors default to permanent (surface to human)', () => {
  assert.equal(classifyFailure(new Error('totally novel unexpected condition')), 'permanent');
  assert.equal(classifyFailure(null), 'permanent');
  assert.equal(classifyFailure(undefined), 'permanent');
});

test('withRetry returns the value on first success without retrying', async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      return 'ok';
    },
    { retries: 3, sleep: noSleep },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries a transient failure then succeeds', async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('ETIMEDOUT');
      return 'recovered';
    },
    { retries: 5, baseMs: 1, sleep: noSleep },
  );
  assert.equal(out, 'recovered');
  assert.equal(calls, 3);
});

test('withRetry gives up after N retries on a persistent transient failure', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error('network unreachable');
        },
        { retries: 2, baseMs: 1, sleep: noSleep },
      ),
    /network unreachable/,
  );
  assert.equal(calls, 3, 'first attempt + 2 retries');
});

test('withRetry does not retry a permanent failure', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error('captcha challenge');
        },
        { retries: 5, baseMs: 1, sleep: noSleep },
      ),
    /captcha/,
  );
  assert.equal(calls, 1, 'permanent errors throw immediately');
});

test('withRetry computes bounded exponential backoff delays', async () => {
  const delays: number[] = [];
  let calls = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls++;
        throw new Error('timeout');
      },
      {
        retries: 3,
        baseMs: 10,
        maxMs: 50,
        sleep: noSleep,
        onRetry: ({ delayMs }) => delays.push(delayMs),
      },
    ),
  );
  // attempts 0,1,2 -> 10, 20, 40 (all under the 50ms cap).
  assert.deepEqual(delays, [10, 20, 40]);
});
