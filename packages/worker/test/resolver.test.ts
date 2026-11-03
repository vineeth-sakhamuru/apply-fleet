import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { loadAnswers, loadProfile } from '@apply-fleet/data';
import { resolve, DECLINE, GROUNDED } from '../src/index.ts';
import type { FieldSpec, ResolveCtx } from '../src/index.ts';
import {
  llmConfigured,
  buildFacts,
  buildPrompt,
  factsAreClean,
  shouldFill,
  parseClaudeAnswer,
} from '../src/llm.ts';

// Hermetic: no live model call in unit tests, even with a real key in the
// Keychain. The LLM tier's live behaviour is proven by the live-pass sweep.
process.env.APPLY_FLEET_NO_LLM = '1';

const root = resolvePath(import.meta.dirname, '../../..');
const pick = (name: string) => {
  const real = resolvePath(root, `config/${name}.yml`);
  return existsSync(real) ? real : resolvePath(root, `config/${name}.example.yml`);
};

const ctx: ResolveCtx = {
  profile: loadProfile(pick('profile')),
  answers: loadAnswers(pick('answers')),
};
const A = ctx.answers as unknown as Record<string, any>;

const field = (o: Partial<FieldSpec> & { label: string; kind: FieldSpec['kind'] }): FieldSpec => ({
  name: 'x',
  selector: '#x',
  required: false,
  ...o,
});

test('identity + contact fields resolve from grounded sources', async () => {
  const first = await resolve(field({ label: 'First Name', kind: 'text', required: true }), ctx);
  assert.deepEqual(first, { status: 'resolved', value: A.identity.first_name, source: 'answers' });

  const email = await resolve(field({ label: 'Email', kind: 'email', required: true }), ctx);
  assert.equal(email.status, 'resolved');
  if (email.status === 'resolved') assert.equal(email.value, A.contact.email);
});

test('work authorization + sponsorship resolve to Yes/No', async () => {
  const auth = await resolve(
    field({ label: 'Are you legally authorized to work in the United States?', kind: 'select', options: ['Yes', 'No'], required: true }),
    ctx,
  );
  assert.deepEqual(auth, { status: 'resolved', value: 'Yes', source: 'answers' });

  const sponsor = await resolve(
    field({ label: 'Will you now or in the future require sponsorship?', kind: 'select', options: ['Yes', 'No'], required: true }),
    ctx,
  );
  assert.deepEqual(sponsor, { status: 'resolved', value: 'No', source: 'answers' });
});

test('EEO: provided self-ID fills; unset declines; free-text stays blank', async () => {
  // A value the user provided (his own self-ID) fills — here A.eeo.gender.
  const gender = await resolve(
    field({ label: 'Gender', kind: 'select', options: ['Male', 'Female', 'Decline to self-identify'] }),
    ctx,
  );
  assert.deepEqual(gender, { status: 'resolved', value: A.eeo.gender, source: 'answers' });

  // A demographic field the user did NOT set still declines — never guessed.
  const orientation = await resolve(
    field({ label: 'Sexual orientation', kind: 'select', options: ['Straight', 'Gay', 'Decline to self-identify'] }),
    ctx,
  );
  assert.deepEqual(orientation, { status: 'resolved', value: DECLINE, source: 'you' });

  // Free-text EEO stays blank (never write demographics into a prose box).
  const disabilityText = await resolve(field({ label: 'Describe any disability', kind: 'text' }), ctx);
  assert.equal(disabilityText.status, 'skip');
});

test('open-ended → HITL when drafting tier unconfigured; unmapped required → HITL', async () => {
  // With no provider key the open-ended field must fall to a human, never a
  // guess. (When a key IS present the drafting tier answers it — exercised
  // separately, and skipped here so the suite never makes a live API call.)
  if (!llmConfigured()) {
    const why = await resolve(field({ label: 'Why do you want to work here?', kind: 'textarea' }), ctx);
    assert.equal(why.status, 'hitl');
  }

  const unknown = await resolve(field({ label: 'Favorite programming color', kind: 'text', required: true }), ctx);
  assert.equal(unknown.status, 'hitl');
});

test('skill-list screeners resolve deterministically — never a human', async () => {
  const langs = await resolve(
    field({ label: 'Which programming languages are you proficient in?', kind: 'textarea' }),
    ctx,
  );
  assert.equal(langs.status, 'resolved');
  if (langs.status === 'resolved') {
    assert.match(langs.value, /Python/);
    assert.ok(GROUNDED.has(langs.source), `source ${langs.source} not grounded`);
  }

  const skills = await resolve(field({ label: 'List your technical skills', kind: 'text' }), ctx);
  assert.equal(skills.status, 'resolved');
  if (skills.status === 'resolved') assert.match(skills.value, /AWS|Docker|FastAPI/);
});

test('consent policy: yes to recording + background check, decline data-sharing', async () => {
  const notetaker = await resolve(
    field({ label: 'As part of our interview process, we may use AI notetakers to transcribe conversations. Do you consent?', kind: 'choice', options: ['Yes, I consent', 'No, I do not consent'], required: true }),
    ctx,
  );
  assert.deepEqual(notetaker, { status: 'resolved', value: 'Yes', source: 'you' });

  const bg = await resolve(
    field({ label: 'Do you consent to a background check and reference verification?', kind: 'choice', options: ['Yes', 'No'], required: true }),
    ctx,
  );
  assert.deepEqual(bg, { status: 'resolved', value: 'Yes', source: 'you' });

  // Data-sharing consent is declined per his policy — never auto-consented.
  const share = await resolve(
    field({ label: 'Do you consent to sharing your personal data with our third-party partners for marketing?', kind: 'choice', options: ['Yes', 'No'], required: true }),
    ctx,
  );
  assert.deepEqual(share, { status: 'resolved', value: 'No', source: 'you' });

  const pool = await resolve(
    field({ label: 'Add me to your talent community to receive future opportunities', kind: 'choice', options: ['Yes', 'No'] }),
    ctx,
  );
  assert.deepEqual(pool, { status: 'resolved', value: 'No', source: 'you' });
});

test('llm grounding facts carry résumé + vault substance and leak no PII', () => {
  // Vault snippets = the candidate's own writing (trusted context). A benign
  // snippet flows through; one carrying a PII value (his phone) is dropped.
  const phone = A.contact.phone as string;
  const snippets = [
    'Built a job-application fleet: Groq drafting + vault grounding.',
    `Call me at ${phone} about the RAG project.`, // must be dropped
  ];
  const facts = buildFacts(ctx, snippets);

  assert.ok(facts.skills.includes('Python'), 'skills should include Python');
  assert.ok(facts.bullets.length > 0, 'résumé bullets should load');
  assert.ok(facts.vault.some((s) => /application fleet/.test(s)), 'benign vault snippet kept');
  assert.ok(!facts.vault.some((s) => s.includes(phone)), 'PII-bearing snippet dropped');
  assert.ok(factsAreClean(facts, ctx), 'facts must not contain DOB/phone/address/legal name');

  // The kept snippet actually reaches the model prompt as trusted context,
  // and no PII rides along.
  const { user } = buildPrompt(
    field({ label: 'What have you built recently?', kind: 'textarea' }),
    facts,
  );
  assert.match(user, /application fleet/);
  assert.ok(!user.includes(phone), 'no PII in the prompt');
});

test('answer gate rejects low confidence, empty, and INSUFFICIENT', () => {
  assert.equal(shouldFill(null), false);
  assert.equal(shouldFill({ answer: 'INSUFFICIENT', confidence: 1 }), false);
  assert.equal(shouldFill({ answer: '', confidence: 1 }), false);
  assert.equal(shouldFill({ answer: 'I built RAG pipelines end to end.', confidence: 0.5 }), false);
  assert.equal(shouldFill({ answer: 'I built RAG pipelines end to end.', confidence: 0.9 }), true);
});

test('parseClaudeAnswer parses strict JSON and rejects garbage', () => {
  assert.deepEqual(parseClaudeAnswer('{"answer":"hi","confidence":0.9}'), { answer: 'hi', confidence: 0.9 });
  assert.deepEqual(parseClaudeAnswer('noise {"answer":"x","confidence":0.8} tail'), { answer: 'x', confidence: 0.8 });
  assert.equal(parseClaudeAnswer('not json at all'), null);
  assert.equal(parseClaudeAnswer('{"confidence":0.9}'), null);
});

test('every resolved value carries a grounded source', async () => {
  const labels: Array<[string, FieldSpec['kind']]> = [
    ['First Name', 'text'],
    ['Last Name', 'text'],
    ['Email', 'email'],
    ['Phone', 'tel'],
    ['Gender', 'select'],
  ];
  for (const [label, kind] of labels) {
    const r = await resolve(field({ label, kind, options: ['Decline to self-identify'] }), ctx);
    if (r.status === 'resolved') assert.ok(GROUNDED.has(r.source), `${label} source ${r.source} not grounded`);
  }
});

// Regressions from a real Ramp/Ashby application that reported 'ready', clicked
// Submit, and bounced off the ATS's own validation. Each of these was a field
// the resolver either answered WRONG or left for a human on a required field.

test('a narrative question never gets a canned skills list', async () => {
  // This shipped: "How'd you get into programming?" was filled with
  // "Python, Java, JavaScript, SQL" by the semantic tier, on a live application.
  const r = await resolve(
    field({ label: "How'd you get into programming?", kind: 'text', required: true }),
    ctx,
  );
  assert.notEqual(r.status, 'resolved', 'a story prompt is not a grounded field');
  if (r.status === 'resolved') return;
  assert.equal(r.status, 'hitl', 'it belongs to the human (or the LLM tier when configured)');
});

test('factual how/what/where questions still resolve — the guard is not a blanket', async () => {
  const heard = await resolve(
    field({ label: 'How did you hear about this role?', kind: 'select', options: ['LinkedIn', 'Other'] }),
    ctx,
  );
  assert.deepEqual(heard, { status: 'resolved', value: 'LinkedIn', source: 'you' });

  const school = await resolve(
    field({ label: 'What university are you currently attending?', kind: 'text', required: true }),
    ctx,
  );
  assert.equal(school.status, 'resolved');
});

test('SMS opt-in declines', async () => {
  const r = await resolve(
    field({
      label:
        'Check Yes or No to indicate your agreement to receive text message updates from Ramp Business Corporation regarding your job application.',
      kind: 'radio',
      options: ['Yes - I consent to receiving text messages', 'No - I do not consent to receiving text messages'],
      required: true,
    }),
    ctx,
  );
  assert.deepEqual(r, { status: 'resolved', value: 'No', source: 'you' });
});

test('"where do you plan on working from" resolves to his city, not HITL', async () => {
  const r = await resolve(
    field({ label: 'Where do you plan on working from (for payroll tax purposes)?', kind: 'text', required: true }),
    ctx,
  );
  assert.equal(r.status, 'resolved', 'a required location field must not block submit');
  if (r.status === 'resolved') assert.match(String(r.value), new RegExp(A.contact.city, 'i'));
});

// Coverage buckets from a live 89-application sweep. Each of these left a
// required field unanswered on real forms while the answer sat in answers.yml.

test('country fields resolve — the largest HITL bucket in the sweep', async () => {
  for (const label of ['Country', 'Country*', 'What is your country of residence?', 'Passport Country']) {
    const r = await resolve(field({ label, kind: 'text', required: true }), ctx);
    assert.equal(r.status, 'resolved', `"${label}" must not stall an application`);
    if (r.status === 'resolved') assert.equal(r.value, A.contact.country);
  }
});

test('in-person office questions resolve like the other willingness prompts', async () => {
  const r = await resolve(
    field({ label: 'Are you open to working in-person in one of our offices?', kind: 'select', options: ['Yes', 'No'], required: true }),
    ctx,
  );
  assert.deepEqual(r, { status: 'resolved', value: 'Yes', source: 'answers' });
});

test('a question-form graduation date resolves past the essay guard', async () => {
  const r = await resolve(
    field({ label: "If you're less than 3 years out of school, what's your graduation date?", kind: 'text', required: true }),
    ctx,
  );
  assert.equal(r.status, 'resolved');
  // Same value the plain "Graduation" label resolves to — the point is that the
  // question form reaches the rule at all, not what the date happens to be.
  const plain = await resolve(field({ label: 'Graduation Date', kind: 'text' }), ctx);
  assert.equal(plain.status, 'resolved');
  if (r.status === 'resolved' && plain.status === 'resolved') assert.equal(r.value, plain.value);
});

test('start-date questions resolve in their question form too', async () => {
  for (const label of [
    'When is the earliest you would want to start working?',
    'When can you start?',
    'Earliest start date',
  ]) {
    const r = await resolve(field({ label, kind: 'text', required: true }), ctx);
    assert.equal(r.status, 'resolved', `"${label}" must not stall an application`);
  }
});

// Google Careers, live 2026-10-12. "...sponsor work authorization for you to
// work..." also matches the work-authorization pattern, which answered Yes.
test('a sponsorship question that mentions work authorization still answers No', async () => {
  const r = await resolve(
    field({ label: 'Do you currently need, or will you someday require, Google to sponsor work authorization for you to work in the country of employment? *', kind: 'radio', options: ['Yes', 'No'], required: true }),
    ctx,
  );
  assert.equal(r.status === 'resolved' && r.value, 'No');
});
