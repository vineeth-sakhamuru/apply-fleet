import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAnswers, loadProfile } from '@apply-fleet/data';
import { resolve } from '../src/resolver.ts';
import { resolve as rp } from 'node:path';

process.env.APPLY_FLEET_NO_LLM = '1';
const cfg = (n: string) => rp(import.meta.dirname, `../../../config/${n}.yml`);

// 2026-10-19 Inversion Space: "authorized ... without sponsorship" was answered No.
test('authorized-without-sponsorship wording answers Yes; sponsorship need answers No', async () => {
  const ctx: any = { answers: loadAnswers(cfg('answers')), profile: loadProfile(cfg('profile')) };
  const r1: any = await resolve({ label: 'Are you legally authorized to work in the United States without sponsorship?', kind: 'select' } as any, ctx);
  assert.equal(r1.value, 'Yes');
  const r2: any = await resolve({ label: 'Will you now or in the future require sponsorship for employment visa status?', kind: 'select' } as any, ctx);
  assert.equal(r2.value, 'No');
});
