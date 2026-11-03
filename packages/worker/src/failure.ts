/**
 * Failure taxonomy + bounded retry for the worker/orchestrator.
 *
 * Two buckets:
 *   - `transient`  — the site is reachable but flaky: navigation aborts,
 *     timeouts, DNS/socket resets, 5xx/429. Worth a bounded backoff retry.
 *   - `permanent`  — retrying is pointless or harmful: the form is gone, a
 *     selector no longer matches, or we hit a captcha / anti-bot wall. The
 *     caller routes these to HITL / dead-letter (and a per-domain breaker can
 *     trip on a run of them).
 *
 * Pure utilities — no worker state, no side effects — so any pool can adopt
 * them without coupling.
 */

export type FailureKind = 'transient' | 'permanent';

// Reachable-but-flaky signals: retry these.
const TRANSIENT: RegExp[] = [
  /\btime(?:d)?\s*-?\s*out\b|\btimeout\b/i,
  /\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEPIPE\b|\bENETUNREACH\b|\bECONNABORTED\b/i,
  /\bnetwork\b|\bsocket hang ?up\b|\bconnection (?:reset|refused|closed|aborted)\b/i,
  /\bnavigat/i, // navigation / page.goto interrupted
  /net::ERR_(?:TIMED_OUT|CONNECTION|NETWORK|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ABORTED)/i,
  /\b(?:429|500|502|503|504)\b/,
  /\btoo many requests\b|\btemporarily unavailable\b|\bservice unavailable\b|\btry again\b/i,
];

// Won't-fix-by-retrying signals: route to human / dead-letter.
const PERMANENT: RegExp[] = [
  /\bcaptcha\b|\brecaptcha\b|\bhcaptcha\b|\bturnstile\b/i,
  /\banti[-\s]?bot\b|\bbot (?:detection|wall|challenge|check)\b|\bare you (?:a )?human\b/i,
  /\bcloudflare\b|\baccess denied\b|\bforbidden\b|\b403\b|\bblocked\b/i,
  /\bform (?:not found|missing|gone)\b|\bno (?:apply )?form (?:found|present)\b/i,
  /\b(?:selector|element|node|locator)\b[^.\n]{0,30}?\b(?:not found|no longer|gone|missing|detached|not attached|stale)\b/i,
  /\bno (?:element|match(?:es)?)\b[^.\n]{0,20}?\b(?:found|for|matching)\b/i,
  /\b(?:401|404|410)\b/,
];

function errorText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return `${err.name} ${err.message} ${typeof code === 'string' ? code : ''}`;
  }
  try {
    return String(err);
  } catch {
    return '';
  }
}

/**
 * Bucket an error for the retry / circuit-breaker policy.
 *
 * Permanent signals win over transient ones (a timeout *waiting for a captcha*
 * is still a captcha wall). Unrecognized errors default to 'permanent' so we
 * surface them to human review rather than silently retry-loop — this honors
 * the never-silent-fail invariant. Widen the pattern lists as real errors show
 * up in the logs.
 *
 * ponytail: string/pattern matching over error messages, not typed error
 * classes. Ceiling: brittle if a dependency reworders its messages. Upgrade
 * path: key off structured error names/codes once the worker throws typed
 * errors instead of bare Error.
 */
export function classifyFailure(err: unknown): FailureKind {
  const hay = errorText(err);
  if (PERMANENT.some((re) => re.test(hay))) return 'permanent';
  if (TRANSIENT.some((re) => re.test(hay))) return 'transient';
  return 'permanent';
}

export interface RetryOptions {
  /** Additional attempts after the first. Total attempts = retries + 1. */
  retries?: number;
  /** Base backoff in ms; delay for attempt n is baseMs * 2**n. */
  baseMs?: number;
  /** Ceiling on any single backoff delay. */
  maxMs?: number;
  /** Observed on each retry (for logging / metrics). */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  /** Injectable sleep so tests run without real delays. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `fn`, retrying only `transient` failures with bounded exponential
 * backoff. `permanent` failures throw immediately so the caller can route them
 * to HITL / dead-letter. Gives up (re-throws the last error) after `retries`.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 3);
  const baseMs = Math.max(0, opts.baseMs ?? 200);
  const maxMs = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (classifyFailure(err) === 'permanent') throw err;
      if (attempt >= retries) throw err;
      const delayMs = Math.min(maxMs, baseMs * 2 ** attempt);
      opts.onRetry?.({ attempt: attempt + 1, error: err, delayMs });
      await sleep(delayMs);
      attempt++;
    }
  }
}
