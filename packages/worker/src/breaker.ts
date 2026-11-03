import { classifyFailure } from './failure.ts';

/**
 * Per-domain circuit breaker.
 *
 * Why a breaker and not just retries: when a domain fails, it usually fails for
 * every application on it at once. We watched all 127 Workday tenants return
 * zero under a burst — retrying each posting individually just deepened the
 * hole and cost minutes of browser time to learn the same fact 127 times. One
 * open circuit answers it once.
 *
 * Only PERMANENT failures trip it (`classifyFailure`): a captcha wall, a missing
 * form, a 403. Transient flakiness is what retries are for, and counting it here
 * would trip the breaker on ordinary network noise.
 *
 * Fails OPEN, deliberately: an open circuit skips work, it never marks an
 * application failed. Applications stay queued and get picked up when the
 * cooldown expires, so a breaker can't silently drop anything.
 */

export interface BreakerOptions {
  /** Permanent failures within `windowMs` before the circuit opens. */
  threshold?: number;
  /** Rolling window for counting failures. */
  windowMs?: number;
  /** How long the circuit stays open. */
  cooldownMs?: number;
  now?: () => number;
}

/** Group by registrable host — one ATS domain, one circuit. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'invalid';
  }
}

interface State {
  /** Timestamps of recent permanent failures. */
  fails: number[];
  openUntil: number;
  /** Cumulative, for the metrics endpoint. */
  totalFails: number;
  trips: number;
}

export class CircuitBreaker {
  private state = new Map<string, State>();
  private threshold: number;
  private windowMs: number;
  private cooldownMs: number;
  private now: () => number;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.windowMs = opts.windowMs ?? 120_000;
    this.cooldownMs = opts.cooldownMs ?? 300_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private get(domain: string): State {
    let s = this.state.get(domain);
    if (!s) {
      s = { fails: [], openUntil: 0, totalFails: 0, trips: 0 };
      this.state.set(domain, s);
    }
    return s;
  }

  /** True when work against this domain should be skipped right now. */
  isOpen(url: string): boolean {
    const s = this.state.get(domainOf(url));
    return !!s && s.openUntil > this.now();
  }

  /** ms until the circuit closes, 0 if already closed. */
  opensIn(url: string): number {
    const s = this.state.get(domainOf(url));
    return s ? Math.max(0, s.openUntil - this.now()) : 0;
  }

  /**
   * Feed an outcome in. Returns true if this call tripped the circuit, so the
   * caller can log the transition once instead of on every failure.
   */
  record(url: string, error: unknown): boolean {
    if (classifyFailure(error) !== 'permanent') return false;
    const t = this.now();
    const s = this.get(domainOf(url));
    s.totalFails++;
    s.fails = s.fails.filter((at) => t - at < this.windowMs);
    s.fails.push(t);
    if (s.fails.length >= this.threshold && s.openUntil <= t) {
      s.openUntil = t + this.cooldownMs;
      s.trips++;
      s.fails = []; // start the next window clean
      return true;
    }
    return false;
  }

  /** A success closes the circuit early — the domain is demonstrably back. */
  recordSuccess(url: string): void {
    const s = this.state.get(domainOf(url));
    if (!s) return;
    s.fails = [];
    s.openUntil = 0;
  }

  /** For /api/metrics: which domains are tripped and how often they have been. */
  snapshot(): Array<{ domain: string; open: boolean; opensInMs: number; fails: number; trips: number }> {
    const t = this.now();
    return [...this.state.entries()]
      .map(([domain, s]) => ({
        domain,
        open: s.openUntil > t,
        opensInMs: Math.max(0, s.openUntil - t),
        fails: s.totalFails,
        trips: s.trips,
      }))
      .sort((a, b) => b.fails - a.fails);
  }

  reset(): void {
    this.state.clear();
  }
}
