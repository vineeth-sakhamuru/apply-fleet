import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { matchLabel } from '../src/index.ts';

/**
 * Guard the model-loading assertions so the suite NEVER downloads MiniLM on a
 * machine without it cached (mirrors how resolver.test.ts guards the live LLM
 * call). The offline-safe null paths below never touch the model, so they run
 * everywhere; the ranking assertion runs only when the model is already cached.
 */
const root = resolvePath(import.meta.dirname, '../../..');
const MODEL_CACHED = existsSync(
  resolvePath(root, 'node_modules/@huggingface/transformers/.cache/Xenova/all-MiniLM-L6-v2'),
);

const CANDIDATES: Record<string, string[]> = {
  languages: ['programming languages', 'coding languages you know', 'languages you are proficient in'],
  work_authorization: ['are you legally authorized to work', 'work authorization'],
  salary: ['salary expectations', 'desired compensation'],
  relocation: ['are you willing to relocate'],
};

test('offline-safe: empty label and empty candidates return null without loading the model', async () => {
  // Neither call reaches the embedder (short-circuits before load), so this is
  // safe on a machine with no model cached and no network.
  assert.equal(await matchLabel('', CANDIDATES), null);
  assert.equal(await matchLabel('Full Name', {}), null);
});

test('ambiguous label maps to the languages key with high confidence', { skip: !MODEL_CACHED }, async () => {
  const m = await matchLabel('Which coding languages are you fluent in?', CANDIDATES);
  assert.ok(m, 'a confident match is returned');
  assert.equal(m!.key, 'languages', 'maps to the languages/skills prototype, not authorization/salary');
  assert.ok(m!.score >= 0.55, `score ${m!.score} clears the gate`);
});

test('unrelated label stays below the gate and returns null', { skip: !MODEL_CACHED }, async () => {
  // A prose/essay prompt must not be forced onto a grounded key.
  const m = await matchLabel('Describe a time you overcame a difficult challenge', CANDIDATES);
  assert.equal(m, null);
});
