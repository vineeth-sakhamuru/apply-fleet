/**
 * Client-side rate limiting for the model providers.
 *
 * WHY THIS EXISTS
 * Groq 429'd the fleet after one successful call, and the reason was not what
 * the headers said. Four facts drove this design, all verified against the live
 * API rather than inferred:
 *
 *  1. Every Groq limit is a continuously-refilling bucket, and
 *     `x-ratelimit-reset-*` is `(limit - remaining) / refill_rate` — time until
 *     the bucket is FULL again, not a window boundary. So after a token stall
 *     you wait `deficit / rate` seconds (a 944-token prompt: ~4.7s), never 60.
 *  2. TPD (tokens/day) and RPM have NO headers. A purely header-driven throttle
 *     is blind to both, and TPD is the real daily ceiling.
 *  3. Admission is charged on `prompt_tokens + max_tokens`, not actual usage —
 *     so an oversized `max_tokens` burns budget the reply never uses.
 *  4. `retry-after` ranges from 2s to over three hours. Honouring it blindly
 *     parks the whole pipeline for the afternoon.
 *
 * So we mirror the server's own algorithm client-side at a safety margin,
 * charge the pessimistic cost up front, and reconcile down once the real usage
 * comes back. Pure and clock-injectable — no sleeping happens in here, callers
 * are told how long to wait.
 */

/** A provider+model's published limits. */
export interface BucketSpec {
  /** Requests per minute. */
  rpm: number;
  /** Requests per day. */
  rpd: number;
  /** Tokens per minute. */
  tpm: number;
  /** Tokens per day. */
  tpd: number;
}

/** Groq free tier, per model. Buckets are per-MODEL and per-ORGANISATION, so a
 *  second API key on the same account buys nothing — a smaller model does. */
export const GROQ_LIMITS: Record<string, BucketSpec> = {
  'llama-3.3-70b-versatile': { rpm: 30, rpd: 1000, tpm: 12_000, tpd: 100_000 },
  // 5x the daily token budget of the 70b — the fallback that actually helps.
  'llama-3.1-8b-instant': { rpm: 30, rpd: 14_400, tpm: 6_000, tpd: 500_000 },
};

/**
 * Estimated admission cost of a call.
 *
 * NOT chars/4. Measured against the real Llama 3.3 tokenizer, chars/4 flips
 * sign by content type: it over-estimates on clean English prose (+6–28%, safe)
 * but UNDER-estimates on anything structured — JSON −19%, markdown −35%, and
 * URL/hash-heavy text −51%. Our prompts carry résumé bullets and vault
 * snippets, which are exactly that mixed shape, and an under-estimate is what
 * walks into a 429.
 *
 * 3.5 covers markdown and JSON without wildly over-reserving on prose; the
 * post-call `reconcile()` gives back whatever we over-reserved, so erring high
 * costs throughput for a few seconds, while erring low costs a 429.
 *
 * The +40 is the chat-template envelope (measured: a 31-char message costs 42
 * prompt tokens). `maxTokens` is included because the server charges ADMISSION
 * on prompt + max_tokens, not on what the reply actually uses.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(chars: number, maxTokens: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN) + 40 + maxTokens;
}

/**
 * Full jitter, per AWS's backoff study — `random(0, min(cap, base * 2^n))`.
 * Strictly better at decorrelating concurrent clients than the [0.75, 1.0)
 * multiplier every LLM SDK ships, which matters here because the fleet runs
 * several workers that would otherwise retry in lockstep.
 */
export function backoffMs(attempt: number, baseMs = 500, capMs = 8000, rand = Math.random): number {
  return Math.floor(rand() * Math.min(capMs, baseMs * 2 ** attempt));
}

interface Bucket {
  /** Capacity after headroom. */
  cap: number;
  /** Units per millisecond. */
  rate: number;
  level: number;
  at: number;
}

const mk = (limit: number, windowMs: number, headroom: number, now: number): Bucket => {
  const cap = Math.max(1, Math.floor(limit * headroom));
  return { cap, rate: cap / windowMs, level: cap, at: now };
};

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface LimiterOptions {
  /** Fraction of the published limit we allow ourselves. */
  headroom?: number;
  now?: () => number;
}

/**
 * Four mirrored buckets per model, plus a cooldown for limits we can't refill
 * our way out of (a TPD wall is hours away — fail over instead of waiting).
 */
export class RateLimiter {
  private buckets = new Map<string, { rpm: Bucket; rpd: Bucket; tpm: Bucket; tpd: Bucket }>();
  private cooldowns = new Map<string, number>();
  private headroom: number;
  private now: () => number;

  constructor(opts: LimiterOptions = {}) {
    // 15% is defensible because we mirror the server's exact algorithm rather
    // than guessing at it; the OpenAI cookbook uses 50% for a blind estimate.
    this.headroom = opts.headroom ?? 0.85;
    this.now = opts.now ?? (() => Date.now());
  }

  private get(key: string, spec: BucketSpec) {
    let b = this.buckets.get(key);
    if (!b) {
      const t = this.now();
      b = {
        rpm: mk(spec.rpm, MINUTE, this.headroom, t),
        rpd: mk(spec.rpd, DAY, this.headroom, t),
        tpm: mk(spec.tpm, MINUTE, this.headroom, t),
        tpd: mk(spec.tpd, DAY, this.headroom, t),
      };
      this.buckets.set(key, b);
    }
    return b;
  }

  private refill(b: Bucket): void {
    const t = this.now();
    if (t > b.at) {
      b.level = Math.min(b.cap, b.level + (t - b.at) * b.rate);
      b.at = t;
    }
  }

  /** ms until this bucket can cover `cost`, or 0 if it can now. */
  private waitFor(b: Bucket, cost: number): number {
    this.refill(b);
    if (b.level >= cost) return 0;
    // Unsatisfiable even when full — don't return an infinite wait, let the
    // caller fail over. (A single call larger than the whole per-minute budget.)
    if (cost > b.cap) return -1;
    return Math.ceil((cost - b.level) / b.rate);
  }

  /**
   * Try to admit a call costing `tokens`.
   *
   * Returns `{ ok: true }` having DEDUCTED the cost, or `{ ok: false, waitMs }`
   * having deducted nothing. `waitMs < 0` means this model can never serve the
   * call — fail over rather than sleep.
   */
  reserve(
    key: string,
    spec: BucketSpec,
    tokens: number,
  ): { ok: true } | { ok: false; waitMs: number } {
    const cooled = this.cooldowns.get(key) ?? 0;
    if (cooled > this.now()) return { ok: false, waitMs: cooled - this.now() };

    const b = this.get(key, spec);
    const waits = [
      this.waitFor(b.rpm, 1),
      this.waitFor(b.rpd, 1),
      this.waitFor(b.tpm, tokens),
      this.waitFor(b.tpd, tokens),
    ];
    if (waits.some((w) => w < 0)) return { ok: false, waitMs: -1 };
    const waitMs = Math.max(...waits);
    if (waitMs > 0) return { ok: false, waitMs };

    b.rpm.level -= 1;
    b.rpd.level -= 1;
    b.tpm.level -= tokens;
    b.tpd.level -= tokens;
    return { ok: true };
  }

  /**
   * Give back the difference once the provider reports real usage. We reserved
   * `prompt + max_tokens`; a short reply means most of that is owed back, and
   * without this the daily budget drains several times faster than it should.
   */
  reconcile(key: string, reserved: number, actual: number): void {
    const b = this.buckets.get(key);
    if (!b || actual >= reserved) return;
    const refund = reserved - actual;
    b.tpm.level = Math.min(b.tpm.cap, b.tpm.level + refund);
    b.tpd.level = Math.min(b.tpd.cap, b.tpd.level + refund);
  }

  /** Hard-sync the per-minute token bucket from `x-ratelimit-remaining-tokens`,
   *  which is authoritative and free. There is no such header for the daily
   *  bucket, which is exactly why we model it ourselves. */
  syncTokens(key: string, remaining: number): void {
    const b = this.buckets.get(key);
    if (!b || !Number.isFinite(remaining)) return;
    b.tpm.level = Math.min(b.tpm.cap, Math.max(0, remaining * this.headroom));
    b.tpm.at = this.now();
  }

  /** Park a model until `untilMs` (a TPD wall, or an absurd retry-after). */
  cooldown(key: string, untilMs: number): void {
    this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, untilMs));
  }

  isCooled(key: string): boolean {
    return (this.cooldowns.get(key) ?? 0) > this.now();
  }

  /** Drop all state. The limiter is process-global on purpose — one budget
   *  however many workers — so tests must be able to start from a clean slate. */
  reset(): void {
    this.buckets.clear();
    this.cooldowns.clear();
  }

  /** Test/observability hook. */
  snapshot(key: string): Record<string, number> | null {
    const b = this.buckets.get(key);
    if (!b) return null;
    for (const x of [b.rpm, b.rpd, b.tpm, b.tpd]) this.refill(x);
    return {
      rpm: Math.floor(b.rpm.level),
      rpd: Math.floor(b.rpd.level),
      tpm: Math.floor(b.tpm.level),
      tpd: Math.floor(b.tpd.level),
      cooledMs: Math.max(0, (this.cooldowns.get(key) ?? 0) - this.now()),
    };
  }
}

/** Which limit a 429 hit. `day` limits are hours away; `minute` limits are seconds. */
export interface RateLimitInfo {
  unit: 'tokens' | 'requests';
  window: 'minute' | 'day';
  retryAfterMs: number;
}

/**
 * Read the dimension out of a 429.
 *
 * Groq puts it ONLY in the message string — `error.type` distinguishes tokens
 * from requests but not minute from day, and that difference is the difference
 * between a 2-second wait and a 3-hour one.
 */
export function parseRateLimit(body: string, retryAfterHeader?: string | null): RateLimitInfo | null {
  const m = /on (tokens|requests) per (minute|day)/i.exec(body || '');
  const unit = (m?.[1]?.toLowerCase() as 'tokens' | 'requests') ?? 'tokens';
  const window = (m?.[2]?.toLowerCase() as 'minute' | 'day') ?? 'minute';
  let retryAfterMs = 0;
  const hdr = Number(retryAfterHeader);
  if (Number.isFinite(hdr) && hdr > 0) retryAfterMs = hdr * 1000;
  else {
    // "Please try again in 3h15m17.568s" / "in 2s"
    const t = /try again in\s*(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(body || '');
    if (t) {
      const h = Number(t[1] ?? 0), mi = Number(t[2] ?? 0), s = Number(t[3] ?? 0);
      retryAfterMs = Math.round((h * 3600 + mi * 60 + s) * 1000);
    }
  }
  if (!m && !retryAfterMs) return null;
  return { unit, window, retryAfterMs };
}

/** Longest we will ever sleep in-line for a 429. Past this we fail over to the
 *  next model/provider — openai-python refuses above 120s for the same reason. */
export const MAX_INLINE_WAIT_MS = 30_000;
