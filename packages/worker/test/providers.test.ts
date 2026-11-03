import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  anyProviderConfigured,
  draftFromProviders,
  type Provider,
  type Prompt,
  type FetchLike,
} from '../src/providers.ts';

const prompt: Prompt = { system: 'sys', user: 'usr' };

/** A fake provider whose key presence and behavior are fully controlled. */
function fake(name: string, key: string | undefined, impl: (p: Prompt) => Promise<string>): Provider {
  return { name, key: () => key, draft: (p) => impl(p) };
}

test('real chain order is Groq -> Gemini -> Cerebras -> Anthropic', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.name), ['groq', 'gemini', 'cerebras', 'anthropic']);
});

test('first configured provider wins; later ones are not called', async () => {
  let geminiCalled = false;
  const providers = [
    fake('groq', 'k', async () => 'from-groq'),
    fake('gemini', 'k', async () => {
      geminiCalled = true;
      return 'from-gemini';
    }),
  ];
  const out = await draftFromProviders(prompt, undefined, providers);
  assert.equal(out, 'from-groq');
  assert.equal(geminiCalled, false);
});

test('skips unconfigured; falls through on error and on empty', async () => {
  const providers = [
    fake('groq', undefined, async () => 'never'), // no key -> skipped
    fake('gemini', 'k', async () => {
      throw new Error('boom'); // error -> fall through
    }),
    fake('cerebras', 'k', async () => '   '), // empty (whitespace) -> fall through
    fake('cohere', 'k', async () => 'from-the-last-one'), // unpriced == free
  ];
  const out = await draftFromProviders(prompt, undefined, providers);
  assert.equal(out, 'from-the-last-one');
});

// The spend cap. Default $0 means "free tiers only", which is what this fleet
// runs on — a paid provider must be opted into, never reached by accident.

test('a PAID provider is refused under the default $0 cap', async () => {
  let called = 0;
  const providers = [fake('anthropic', 'k', async () => { called++; return 'paid answer'; })];
  const out = await draftFromProviders(prompt, undefined, providers);
  assert.equal(out, null, 'must not silently spend money');
  assert.equal(called, 0, 'the call is refused BEFORE it is made, not after');
});

test('raising the cap allows the paid provider', async () => {
  const prev = process.env.APPLY_FLEET_COST_CAP_USD;
  process.env.APPLY_FLEET_COST_CAP_USD = '5';
  try {
    const providers = [fake('anthropic', 'k', async () => 'paid answer')];
    assert.equal(await draftFromProviders(prompt, undefined, providers), 'paid answer');
  } finally {
    if (prev === undefined) delete process.env.APPLY_FLEET_COST_CAP_USD;
    else process.env.APPLY_FLEET_COST_CAP_USD = prev;
  }
});

test('free providers are never gated by the cap', async () => {
  const providers = [fake('groq', 'k', async () => 'free answer')];
  assert.equal(await draftFromProviders(prompt, undefined, providers), 'free answer');
});

test('null when no provider is configured', async () => {
  const providers = [
    fake('groq', undefined, async () => 'x'),
    fake('gemini', undefined, async () => 'y'),
  ];
  assert.equal(await draftFromProviders(prompt, undefined, providers), null);
});

test('anyProviderConfigured reflects whether a key is present', () => {
  assert.equal(anyProviderConfigured([fake('groq', undefined, async () => '')]), false);
  assert.equal(anyProviderConfigured([fake('groq', 'k', async () => '')]), true);
});

test('a keyed provider returns its draft', async () => {
  const providers = [fake('groq', 'k', async () => 'the drafted answer')];
  assert.equal(await draftFromProviders(prompt, undefined, providers), 'the drafted answer');
});

test('Groq provider posts an OpenAI-compatible request and extracts content', async () => {
  const groq = PROVIDERS.find((p) => p.name === 'groq')!;
  let seenUrl = '';
  let seenAuth = '';
  const fakeFetch: FetchLike = async (url, init) => {
    seenUrl = String(url);
    seenAuth = String((init?.headers as Record<string, string>).authorization);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'drafted answer' } }] }),
    } as Response;
  };
  const out = await groq.draft(prompt, 'sekret', fakeFetch);
  assert.equal(out, 'drafted answer');
  assert.match(seenUrl, /api\.groq\.com\/openai\/v1\/chat\/completions/);
  assert.equal(seenAuth, 'Bearer sekret');
});

test('llmConfigured is true when a real env key is present (Groq)', async () => {
  const { llmConfigured } = await import('../src/llm.ts');
  const keys = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'ANTHROPIC_API_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.GROQ_API_KEY = 'test-key';
    assert.equal(llmConfigured(), true);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
});

// A rate-limited provider is not the same as an unconfigured one. Both used to
// return null with no explanation, so a 429'd Groq looked like an essay the
// system had quietly declined to answer.

test('a 429 is retried once before the provider is given up on', async () => {
  let calls = 0;
  const flaky: Provider = {
    name: 'flaky',
    key: () => 'k',
    draft: async () => {
      calls++;
      if (calls === 1) throw new Error('https://x: HTTP 429');
      return 'recovered';
    },
  };
  const out = await draftFromProviders({ system: 's', user: 'u' }, fetch, [flaky]);
  assert.equal(out, 'recovered');
  assert.equal(calls, 2, 'exactly one retry, not a loop');
});

test('a persistent failure falls through to the next provider', async () => {
  const dead: Provider = { name: 'dead', key: () => 'k', draft: async () => { throw new Error('HTTP 500'); } };
  const good: Provider = { name: 'good', key: () => 'k', draft: async () => 'ok' };
  assert.equal(await draftFromProviders({ system: 's', user: 'u' }, fetch, [dead, good]), 'ok');
});

test('an unconfigured provider is skipped, not retried', async () => {
  let calls = 0;
  const keyless: Provider = { name: 'keyless', key: () => '', draft: async () => { calls++; return 'x'; } };
  assert.equal(await draftFromProviders({ system: 's', user: 'u' }, fetch, [keyless]), null);
  assert.equal(calls, 0);
});

// The limiter wired into the chain. These prove the behaviours that cost us a
// day of coverage: a daily wall must fail over instantly, a per-minute stall
// must wait the short exact time, and nothing may sleep for real in tests.

import { ProviderHttpError, limiter } from '../src/providers.ts';

const h = (o: Record<string, string> = {}) => new Headers(o);
const err429 = (body: string, hdrs: Record<string, string> = {}) =>
  new ProviderHttpError('https://x', 429, body, h(hdrs));

test('a per-DAY 429 fails over immediately instead of sleeping for hours', async () => {
  limiter.reset();
  const slept: number[] = [];
  let second = 0;
  const dead: Provider = {
    name: 'dead',
    key: () => 'k',
    models: ['llama-3.3-70b-versatile'],
    draft: async () => {
      throw err429(
        'on tokens per day (TPD): Limit 100000, Used 99518, Requested 14044. Please try again in 3h15m17.568s',
      );
    },
  };
  const alive: Provider = { name: 'alive', key: () => 'k', draft: async () => { second++; return 'ok'; } };

  const out = await draftFromProviders({ system: 's', user: 'u' }, fetch, [dead, alive], {
    sleep: async (ms) => { slept.push(ms); },
  });

  assert.equal(out, 'ok', 'must reach the next provider');
  assert.equal(second, 1);
  assert.deepEqual(slept, [], 'never sleep on a limit that is hours away');
});

test('a per-MINUTE 429 waits the short exact time and retries', async () => {
  limiter.reset();
  const slept: number[] = [];
  let calls = 0;
  const flaky: Provider = {
    name: 'flaky',
    key: () => 'k',
    draft: async () => {
      if (++calls === 1) throw err429('on requests per minute (RPM): Limit 30, Used 30, Requested 1. Please try again in 2s');
      return 'recovered';
    },
  };

  const out = await draftFromProviders({ system: 's', user: 'u' }, fetch, [flaky], {
    sleep: async (ms) => { slept.push(ms); },
  });

  assert.equal(out, 'recovered');
  assert.equal(calls, 2);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 2000 && slept[0] < 30_000, `expected a seconds-long wait, got ${slept[0]}ms`);
});

test('groq falls back to the model with the bigger daily budget', async () => {
  limiter.reset();
  const tried: string[] = [];
  const groqLike: Provider = {
    name: 'groq',
    key: () => 'k',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    draft: async (_p, _k, _f, model) => {
      tried.push(model!);
      if (model === 'llama-3.3-70b-versatile') {
        throw err429('on tokens per day (TPD): Limit 100000, Used 99999, Requested 500. Please try again in 3h');
      }
      return 'from the small model';
    },
  };

  const out = await draftFromProviders({ system: 's', user: 'u' }, fetch, [groqLike], {
    sleep: async () => {},
  });

  assert.equal(out, 'from the small model');
  assert.deepEqual(tried, ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
});

test('a model cooled down by a daily wall is not retried on the next call', async () => {
  limiter.reset();
  let hits = 0;
  const p: Provider = {
    name: 'groq',
    key: () => 'k',
    models: ['llama-3.3-70b-versatile'],
    draft: async () => {
      hits++;
      throw err429('on tokens per day (TPD). Please try again in 3h');
    },
  };
  await draftFromProviders({ system: 's', user: 'u' }, fetch, [p], { sleep: async () => {} });
  const after = hits;
  await draftFromProviders({ system: 's', user: 'u' }, fetch, [p], { sleep: async () => {} });
  assert.equal(hits, after, 'the cooldown must survive between calls — quota does not reset per call');
  assert.equal(limiter.isCooled('llama-3.3-70b-versatile'), true);
});
