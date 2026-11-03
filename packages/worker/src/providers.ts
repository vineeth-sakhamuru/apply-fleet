import { recordLlmCall, activePurpose, costGate } from './usage.ts';
import { getSecret } from '@apply-fleet/data';

/**
 * Free-first LLM provider chain for the drafting tier.
 *
 * Order (first with a key present is tried; on error/empty, fall through to the
 * next configured one):
 *   1. Groq      — Llama 3.3 70B, OpenAI-compatible. Fast + free. Primary.
 *   2. Gemini    — Google Generative Language, free tier.
 *   3. Cerebras  — Llama 3.3 70B, OpenAI-compatible, free tier.
 *   4. Anthropic — Claude, last resort (paid; also reads the macOS Keychain).
 *
 * Keys come from process.env (UPPER_SNAKE), except Anthropic which also falls
 * back to the Keychain via getSecret. Raw fetch, no SDK deps. Providers only
 * relay the system+user prompt they are handed — PII discipline (buildFacts /
 * factsAreClean) lives in the caller; nothing personal is added here.
 *
 * ponytail: env/keychain only for now. Route through @apply-fleet/secure
 * (env → keychain → file) if the worker later needs the file tier.
 */

export interface Prompt {
  system: string;
  user: string;
  maxTokens?: number;
}

import { classifyFailure } from './failure.ts';
import {
  RateLimiter,
  GROQ_LIMITS,
  estimateTokens,
  backoffMs,
  parseRateLimit,
  MAX_INLINE_WAIT_MS,
} from './ratelimit.ts';

export type FetchLike = typeof fetch;

export interface Provider {
  name: string;
  /** The API key if configured, else undefined. */
  key(): string | undefined;
  /** Models to try in order. Rate-limit buckets are per-model, so a smaller
   *  model is a real second budget — not a workaround. */
  models?: string[];
  /** Call the provider. Throws on HTTP error; may return '' on an empty reply. */
  draft(prompt: Prompt, key: string, doFetch: FetchLike, model?: string): Promise<string>;
}

/**
 * 250, not 700.
 *
 * The server charges ADMISSION on `prompt_tokens + max_tokens`, so an oversized
 * cap burns budget the reply never uses: at 700 each call reserved ~1684 tokens
 * against a 12,000/min bucket, and eight in flight self-429'd before the first
 * one returned. Our replies are short JSON (`{"answer","confidence"}`) and
 * rephrase already caps itself at 200. Dropping this buys ~40% more calls per
 * day out of the same quota.
 */
const MAX_TOKENS = 250;

/**
 * An HTTP failure that kept its evidence.
 *
 * `throw new Error(\`HTTP ${status}\`)` discarded the body and headers, so
 * nothing downstream could see `retry-after`, or whether a 429 was the
 * per-minute bucket (seconds away) or the daily one (hours away). Those need
 * opposite responses, and telling them apart is only possible from the body.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfter: string | null;
  readonly remainingTokens: number;

  constructor(url: string, status: number, body: string, headers?: Headers) {
    super(`${url}: HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.body = body;
    this.retryAfter = headers?.get('retry-after') ?? null;
    this.remainingTokens = Number(headers?.get('x-ratelimit-remaining-tokens'));
  }
}

/** OpenAI-compatible chat completion — shared by Groq and Cerebras. */
async function openaiCompatDraft(
  providerName: string,
  url: string,
  model: string,
  prompt: Prompt,
  key: string,
  doFetch: FetchLike,
): Promise<string> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: prompt.maxTokens ?? MAX_TOKENS,
      temperature: 0.4,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text?.().catch(() => '') ?? '';
    throw new ProviderHttpError(url, res.status, body, res.headers);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  recordLlmCall(providerName, json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0, activePurpose());
  // Hand the limiter the truth so it can give back what we over-reserved.
  lastUsage.set(model, {
    total: json.usage?.total_tokens ?? 0,
    remaining: Number(res.headers?.get('x-ratelimit-remaining-tokens')),
  });
  return json.choices?.[0]?.message?.content ?? '';
}

/** Per-model actuals from the most recent successful call, for reconciliation. */
const lastUsage = new Map<string, { total: number; remaining: number }>();

/** Key from env (UPPER_SNAKE) first, then the macOS Keychain (service
 *  "apply-fleet", account = the given name). One keychain entry lights up every
 *  process — the key never touches shell history, an env file, or my hands. */
function keyFrom(envVar: string, account: string): string | undefined {
  if (process.env[envVar]) return process.env[envVar];
  try {
    return getSecret(account) || undefined;
  } catch {
    return undefined;
  }
}

const groq: Provider = {
  name: 'groq',
  key: () => keyFrom('GROQ_API_KEY', 'GROQ_API_KEY'),
  // Buckets are per-model AND per-organisation, so a second API key on the same
  // account buys nothing — a second model does. 8b-instant carries a 500K daily
  // token budget against 70b's 100K, which is the difference between the fleet
  // running all day and stopping before lunch.
  models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  draft: (p, key, f, model) =>
    openaiCompatDraft(
      'groq',
      'https://api.groq.com/openai/v1/chat/completions',
      model ?? 'llama-3.3-70b-versatile',
      p,
      key,
      f,
    ),
};

const gemini: Provider = {
  name: 'gemini',
  key: () => keyFrom('GEMINI_API_KEY', 'GEMINI_API_KEY'),
  draft: async (p, key, f) => {
    const model = 'gemini-2.0-flash';
    const res = await f(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: p.system }] },
          contents: [{ role: 'user', parts: [{ text: p.user }] }],
          generationConfig: {
            maxOutputTokens: p.maxTokens ?? MAX_TOKENS,
            temperature: 0.4,
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`gemini: HTTP ${res.status}`);
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    recordLlmCall('gemini', json.usageMetadata?.promptTokenCount ?? 0, json.usageMetadata?.candidatesTokenCount ?? 0, activePurpose());
    return json.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') ?? '';
  },
};

const cerebras: Provider = {
  name: 'cerebras',
  key: () => keyFrom('CEREBRAS_API_KEY', 'CEREBRAS_API_KEY'),
  draft: (p, key, f) =>
    openaiCompatDraft('cerebras', 'https://api.cerebras.ai/v1/chat/completions', 'llama-3.3-70b', p, key, f),
};

const anthropic: Provider = {
  name: 'anthropic',
  key: () => keyFrom('ANTHROPIC_API_KEY', 'anthropic-api-key'),
  draft: async (p, key, f) => {
    const model = process.env.APPLY_FLEET_LLM_MODEL || 'claude-sonnet-5';
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: p.maxTokens ?? MAX_TOKENS,
        system: p.system,
        messages: [{ role: 'user', content: p.user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic: HTTP ${res.status}`);
    const json = (await res.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    recordLlmCall('anthropic', json.usage?.input_tokens ?? 0, json.usage?.output_tokens ?? 0, activePurpose());
    return json.content?.map((c) => c.text ?? '').join('') ?? '';
  },
};

/** The chain, in priority order: Groq first, Anthropic last. */
export const PROVIDERS: Provider[] = [groq, gemini, cerebras, anthropic];

/** True if any provider in `providers` has a key configured. `APPLY_FLEET_NO_LLM`
 *  forces this off so unit tests stay hermetic (no live model call) regardless of
 *  whether a real key sits in the environment/Keychain. */
export function anyProviderConfigured(providers: Provider[] = PROVIDERS): boolean {
  if (process.env.APPLY_FLEET_NO_LLM) return false;
  return providers.some((p) => !!p.key());
}

/**
 * Draft from the first configured provider; on error or empty reply, fall
 * through to the next configured one. Returns null when none is configured or
 * all fail — the keyless-safe path that routes the field to HITL.
 */
/** Shared across the whole process — one budget, however many workers. */
export const limiter = new RateLimiter();

export interface DraftOptions {
  doFetch?: FetchLike;
  providers?: Provider[];
  /** Injectable clock so tests never sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries per model before failing over. Google SRE's guidance is to stop at
   *  three and let the failure surface rather than deepen the retry stack. */
  attempts?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function draftFromProviders(
  prompt: Prompt,
  doFetch: FetchLike = fetch,
  providers: Provider[] = PROVIDERS,
  opts: DraftOptions = {},
): Promise<string | null> {
  if (process.env.APPLY_FLEET_NO_LLM) return null;
  const sleep = opts.sleep ?? realSleep;
  const attempts = opts.attempts ?? 2;
  const failures: string[] = [];
  const chars = prompt.system.length + prompt.user.length;
  const cost = estimateTokens(chars, prompt.maxTokens ?? MAX_TOKENS);

  for (const p of providers) {
    const key = p.key();
    if (!key) continue;
    // Spend ceiling. Free providers pass straight through; a paid one is
    // refused before the call, because "we already spent it" is not a useful
    // thing to learn from a bill.
    const gate = costGate(p.name);
    if (!gate.ok) {
      failures.push(`${p.name}: ${gate.reason}`);
      continue;
    }
    for (const model of p.models ?? [p.name]) {
      const spec = GROQ_LIMITS[model];
      let done = false;

      for (let attempt = 0; attempt < attempts && !done; attempt++) {
        // Ask permission BEFORE spending. This is the whole point: a 429 you
        // never provoke costs nothing, and the daily bucket has no header to
        // warn you, so it must be modelled locally or not at all.
        if (spec) {
          const gate = limiter.reserve(model, spec, cost);
          if (!gate.ok) {
            if (gate.waitMs < 0 || gate.waitMs > MAX_INLINE_WAIT_MS) {
              failures.push(`${p.name}/${model}: budget exhausted (${Math.round(gate.waitMs / 1000)}s)`);
              break; // next model / provider — never park the pipeline
            }
            await sleep(gate.waitMs);
            attempt--; // waiting is not a failed attempt
            continue;
          }
        }
        try {
          const out = (await p.draft(prompt, key, doFetch, model)).trim();
          const seen = lastUsage.get(model);
          if (spec && seen) {
            if (seen.total) limiter.reconcile(model, cost, seen.total);
            // The per-minute header is authoritative and free; the daily one
            // doesn't exist, which is why we keep our own.
            if (Number.isFinite(seen.remaining)) limiter.syncTokens(model, seen.remaining);
          }
          if (out) return out;
          failures.push(`${p.name}/${model}: empty reply`);
          done = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (e instanceof ProviderHttpError && e.status === 429) {
            const info = parseRateLimit(e.body, e.retryAfter);
            // A daily wall is hours out. Park the model and fail over now —
            // honouring retry-after here would stall the fleet until evening.
            if (info?.window === 'day' || (info?.retryAfterMs ?? 0) > MAX_INLINE_WAIT_MS) {
              limiter.cooldown(model, Date.now() + (info?.retryAfterMs ?? 60_000));
              failures.push(`${p.name}/${model}: ${info?.unit ?? 'quota'}-per-${info?.window ?? '?'} exhausted`);
              break;
            }
            // A per-minute stall refills continuously — the exact wait is
            // short, and full jitter keeps concurrent workers from lockstep.
            await sleep(Math.max(info?.retryAfterMs ?? 0, backoffMs(attempt)));
            continue;
          }
          if (classifyFailure(e) === 'transient' && attempt < attempts - 1) {
            await sleep(backoffMs(attempt));
            continue;
          }
          failures.push(`${p.name}/${model}: ${msg}`);
          done = true;
        }
      }
    }
  }
  // Never swallow this. "All providers failed" and "no key configured" look
  // identical downstream (both route to HITL), but one needs a key and the
  // other needs quota — and a silent catch made a rate-limited Groq look like
  // an essay the system had simply decided not to answer.
  if (failures.length) console.error(`llm: no draft — ${failures.join('; ')}`);
  return null;
}
