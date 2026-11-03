import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RateLimiter,
  GROQ_LIMITS,
  estimateTokens,
  backoffMs,
  parseRateLimit,
  MAX_INLINE_WAIT_MS,
} from '../src/ratelimit.ts';

// These numbers come from live measurement against Groq, not from the docs —
// the docs don't mention TPD at all, and TPD is what actually stopped the fleet.

const M = 'llama-3.3-70b-versatile';

/** A controllable clock, so nothing here sleeps for real. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('estimate reserves prompt + completion budget + template envelope', () => {
  // The server charges admission on prompt + max_tokens, so the reservation has
  // to include the completion budget even though the reply is usually shorter.
  assert.equal(estimateTokens(3500, 250), Math.ceil(3500 / 3.5) + 40 + 250);
  assert.ok(estimateTokens(3500, 250) > estimateTokens(3500, 0));
});

test('estimate is deliberately NOT chars/4 — structured text tokenizes denser', () => {
  // chars/4 under-counts markdown by ~35% and JSON by ~19% on the real Llama
  // tokenizer. Under-counting is what walks into a 429.
  const chars = 4000;
  assert.ok(
    estimateTokens(chars, 0) > Math.ceil(chars / 4),
    'must reserve more than the chars/4 folklore',
  );
});

test('admits until the per-minute token bucket is spent, then reports a short wait', () => {
  const c = clock();
  const lim = new RateLimiter({ now: c.now, headroom: 1 });
  const cost = 4000; // 3 fit in 12000, the 4th does not

  assert.deepEqual(lim.reserve(M, GROQ_LIMITS[M], cost), { ok: true });
  assert.deepEqual(lim.reserve(M, GROQ_LIMITS[M], cost), { ok: true });
  assert.deepEqual(lim.reserve(M, GROQ_LIMITS[M], cost), { ok: true });

  const gate = lim.reserve(M, GROQ_LIMITS[M], cost);
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  // Refill is continuous at 200 tok/s, so the wait is seconds — NOT a minute.
  // This is the fact the whole design turns on.
  assert.ok(gate.waitMs > 0 && gate.waitMs <= 21_000, `expected seconds, got ${gate.waitMs}ms`);
});

test('the bucket refills continuously — waiting the reported time admits the call', () => {
  const c = clock();
  const lim = new RateLimiter({ now: c.now, headroom: 1 });
  for (let i = 0; i < 3; i++) lim.reserve(M, GROQ_LIMITS[M], 4000);

  const gate = lim.reserve(M, GROQ_LIMITS[M], 4000);
  assert.equal(gate.ok, false);
  if (gate.ok) return;

  c.advance(gate.waitMs);
  assert.deepEqual(lim.reserve(M, GROQ_LIMITS[M], 4000), { ok: true }, 'the reported wait must be sufficient');
});

test('requests-per-minute is enforced even when tokens are plentiful', () => {
  const c = clock();
  const lim = new RateLimiter({ now: c.now, headroom: 1 });
  // RPM 30 with tiny calls: the 31st must be refused on requests, not tokens.
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(lim.reserve(M, GROQ_LIMITS[M], 1), { ok: true }, `call ${i + 1}`);
  }
  const gate = lim.reserve(M, GROQ_LIMITS[M], 1);
  assert.equal(gate.ok, false, 'RPM has no response header — it must be modelled locally');
});

test('the daily token bucket is modelled — it has no header to read', () => {
  const c = clock();
  const lim = new RateLimiter({ now: c.now, headroom: 1 });
  const { tpd } = GROQ_LIMITS[M];

  // Spend within a single day: step the clock only far enough to clear the
  // per-MINUTE stalls, never far enough to refill the daily bucket (which
  // trickles at 1.157 tok/s — 2.4 hours per 10k tokens).
  let spent = 0;
  const started = c.now();
  for (let i = 0; i < 200; i++) {
    const r = lim.reserve(M, GROQ_LIMITS[M], 10_000);
    if (r.ok) {
      spent += 10_000;
      continue;
    }
    if (r.waitMs < 0 || c.now() + r.waitMs - started > 3_600_000) break; // past an hour, we're done
    c.advance(r.waitMs);
  }

  assert.equal(spent, tpd, `the daily cap is the ceiling, not a suggestion (spent ${spent})`);
  // Not exactly 0 — it trickles back at 1.157 tok/s during the minute-stalls,
  // which is the point: it's a leaky bucket, not a calendar reset.
  assert.ok(lim.snapshot(M)!.tpd < 1000, 'daily bucket is spent, refilling only in a trickle');
  // And the wait to get more is hours, which is why the caller fails over to
  // another model instead of sleeping on it.
  const gate = lim.reserve(M, GROQ_LIMITS[M], 10_000);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.ok(gate.waitMs > MAX_INLINE_WAIT_MS, 'a daily wall is not something you wait out');
});

test('reconcile returns the over-reservation so the daily budget lasts', () => {
  const c = clock();
  const lim = new RateLimiter({ now: c.now, headroom: 1 });
  lim.reserve(M, GROQ_LIMITS[M], 1684); // what a 700-max_tokens call used to cost
  const before = lim.snapshot(M)!.tpd;
  lim.reconcile(M, 1684, 400); // the reply was actually short
  const after = lim.snapshot(M)!.tpd;
  assert.equal(after - before, 1284, 'the unused completion budget comes back');
});

test('a cooled-down model is refused without touching its buckets', () => {
  const c = clock();
  const lim = new RateLimiter({ now: c.now });
  lim.cooldown(M, c.now() + 3 * 3600_000); // a TPD wall: hours away
  const gate = lim.reserve(M, GROQ_LIMITS[M], 100);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.ok(gate.waitMs > MAX_INLINE_WAIT_MS, 'caller must fail over, not sleep');
  assert.equal(lim.isCooled(M), true);

  c.advance(3 * 3600_000 + 1);
  assert.equal(lim.isCooled(M), false, 'cooldown expires');
});

test('a call larger than the whole bucket returns -1 rather than an eternal wait', () => {
  const lim = new RateLimiter({ headroom: 1 });
  const gate = lim.reserve(M, GROQ_LIMITS[M], 99_999);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.waitMs, -1, 'unsatisfiable must be distinguishable from slow');
});

test('syncTokens trusts the authoritative per-minute header', () => {
  const c = clock();
  const lim = new RateLimiter({ now: c.now, headroom: 1 });
  lim.reserve(M, GROQ_LIMITS[M], 100);
  lim.syncTokens(M, 500); // server says we have far less than we thought
  assert.equal(lim.snapshot(M)!.tpm, 500);
});

// Parsing the 429. The dimension appears ONLY in the message string — `type`
// says tokens-vs-requests but not minute-vs-day, and that is the difference
// between a 2-second wait and a 3-hour one.

test('distinguishes a per-day wall from a per-minute stall', () => {
  const day = parseRateLimit(
    'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` on tokens per day (TPD): Limit 100000, Used 99518, Requested 14044. Please try again in 3h15m17.568s',
  );
  assert.equal(day?.window, 'day');
  assert.equal(day?.unit, 'tokens');
  assert.ok(day!.retryAfterMs > MAX_INLINE_WAIT_MS, 'a daily wall must never be slept through');

  const minute = parseRateLimit('…on requests per minute (RPM): Limit 30, Used 30, Requested 1. Please try again in 2s');
  assert.equal(minute?.window, 'minute');
  assert.equal(minute?.unit, 'requests');
  assert.equal(minute?.retryAfterMs, 2000);
});

test('the retry-after header wins over the message when present', () => {
  const r = parseRateLimit('…on tokens per minute (TPM)… Please try again in 9s', '4');
  assert.equal(r?.retryAfterMs, 4000);
});

test('parses the compound duration format exactly', () => {
  assert.equal(parseRateLimit('on tokens per day (TPD). Please try again in 1h2m3.5s')?.retryAfterMs, 3_723_500);
});

test('full jitter spreads retries instead of aligning them', () => {
  // AWS's study: random(0, min(cap, base * 2^n)). Every LLM SDK ships a
  // [0.75, 1.0) multiplier instead, which barely decorrelates a worker fleet.
  assert.equal(backoffMs(0, 500, 8000, () => 0), 0);
  assert.equal(backoffMs(0, 500, 8000, () => 0.999), 499);
  assert.equal(backoffMs(3, 500, 8000, () => 1) , 4000, 'grows exponentially');
  assert.equal(backoffMs(9, 500, 8000, () => 1), 8000, 'and is capped');
});
