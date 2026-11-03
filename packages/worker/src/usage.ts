import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Real LLM usage + spend accounting.
 *
 * The dashboard used to display a hardcoded `costToday: 4.12` that drifted
 * upward on a demo timer — a number that had never touched an API bill. This
 * replaces it with counts of calls the fleet actually made, priced per
 * provider. Free-tier providers are priced at 0 on purpose: $0.00 is the
 * honest figure, and a fake non-zero one is worse than none.
 *
 * In-process and resets on restart, which matches what it claims to be
 * ("today"/this run). Durable per-tenant accounting belongs in the event store
 * if this ever needs billing-grade numbers.
 */

/** USD per 1M tokens, [input, output]. Free tiers are genuinely 0. */
const PRICING: Record<string, { in: number; out: number }> = {
  groq: { in: 0, out: 0 }, // free tier
  gemini: { in: 0, out: 0 }, // free tier
  cerebras: { in: 0, out: 0 }, // free tier
  anthropic: { in: 3, out: 15 }, // paid — Sonnet-class list price
};

export interface ProviderUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface UsageSnapshot {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  since: string;
  byProvider: Record<string, ProviderUsage>;
  /** Calls split by what asked for them — "why is the model being called 72
   *  times" is unanswerable from a single total. */
  byPurpose: Record<string, ProviderUsage>;
}

let since = new Date().toISOString();
const byProvider = new Map<string, ProviderUsage>();
const byPurpose = new Map<string, ProviderUsage>();

function bucket(map: Map<string, ProviderUsage>, key: string): ProviderUsage {
  let b = map.get(key);
  if (!b) {
    b = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    map.set(key, b);
  }
  return b;
}

/**
 * Record one completed model call. Token counts are whatever the provider
 * reported; when it reports none we still count the call, so "how many drafts
 * did the fleet write" stays accurate even where spend can't be derived.
 */
export function recordLlmCall(
  provider: string,
  tokensIn = 0,
  tokensOut = 0,
  purpose = 'unknown',
): void {
  const price = PRICING[provider] ?? { in: 0, out: 0 };
  const cost = (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
  for (const b of [bucket(byProvider, provider), bucket(byPurpose, purpose)]) {
    b.calls += 1;
    b.tokensIn += tokensIn;
    b.tokensOut += tokensOut;
    b.costUsd += cost;
  }
}

/**
 * What the current call is for. Set by the caller that owns the intent, read by
 * `recordLlmCall` deep in the provider — threading a parameter through five
 * layers to answer one accounting question isn't worth the churn.
 *
 * AsyncLocalStorage, not a module variable: with two prepares in flight, a
 * save/restore global has one call's cleanup wiping the label of another that's
 * still running. That mistagged real calls as 'unknown' the first time I ran it.
 */
const purposeStore = new AsyncLocalStorage<string>();

export function withPurpose<T>(purpose: string, fn: () => Promise<T>): Promise<T> {
  return purposeStore.run(purpose, fn);
}

export function activePurpose(): string {
  return purposeStore.getStore() ?? 'unknown';
}

/**
 * Hard spend ceiling for this process, in USD. Default 0 is not "unlimited" —
 * it's "free tiers only", which is what this fleet actually runs on. Raise it
 * deliberately (APPLY_FLEET_COST_CAP_USD=5) to allow paid models.
 *
 * The cap is checked BEFORE a paid call, not after, because "we already spent
 * it" is not a useful thing to learn from a bill.
 */
function costCap(): number {
  const v = Number(process.env.APPLY_FLEET_COST_CAP_USD);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * True unless we have a price on record showing this provider charges money.
 *
 * Unknown providers count as free on purpose: the cap exists to stop spend we
 * can actually measure. Treating unpriced ones as paid would block every new
 * free provider (and every test fake) behind a $0 cap.
 */
export function isFreeProvider(provider: string): boolean {
  const p = PRICING[provider];
  return !p || (p.in === 0 && p.out === 0);
}

/**
 * May we make a call to `provider` right now?
 *
 * Returns a reason string when blocked so the caller can log something
 * actionable instead of a silent skip. Alerts once per crossing, not per call —
 * a capped fleet would otherwise print the same line hundreds of times.
 */
let capAlerted = false;

export function costGate(provider: string): { ok: true } | { ok: false; reason: string } {
  if (isFreeProvider(provider)) return { ok: true };
  const cap = costCap();
  const spent = getUsage().costUsd;
  if (spent >= cap) {
    const reason =
      cap === 0
        ? `${provider} is a paid provider and the spend cap is $0 (free tiers only). Set APPLY_FLEET_COST_CAP_USD to allow it.`
        : `spend cap reached: $${spent.toFixed(4)} of $${cap.toFixed(2)}`;
    if (!capAlerted) {
      capAlerted = true;
      console.error(`llm cost cap · ${reason}`);
    }
    return { ok: false, reason };
  }
  return { ok: true };
}

export function getUsage(): UsageSnapshot {
  const total: UsageSnapshot = {
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    since,
    byProvider: {},
    byPurpose: {},
  };
  for (const [name, b] of byProvider) {
    total.calls += b.calls;
    total.tokensIn += b.tokensIn;
    total.tokensOut += b.tokensOut;
    total.costUsd += b.costUsd;
    total.byProvider[name] = { ...b };
  }
  for (const [name, b] of byPurpose) total.byPurpose[name] = { ...b };
  return total;
}

/** Test hook. */
export function resetUsage(): void {
  byProvider.clear();
  byPurpose.clear();
  since = new Date().toISOString();
}
