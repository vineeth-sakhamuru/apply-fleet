import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSubmit, scoreSubmitCandidate, type SubmitCandidate } from '../src/submit.ts';

// Every candidate list below is taken from a LIVE form (2026-08-04) where the
// old `button[type="submit"]` selector picked the wrong control while the
// application sat marked 'ready'. These are regression tests for a click that
// would have been irreversible.

const c = (o: Partial<SubmitCandidate>): SubmitCandidate => ({
  text: '', cls: '', id: '', type: '', disabled: false, ...o,
});

test('Ashby: every control is type=submit — must not pick "Upload file"', () => {
  // Verbatim shape from jobs.ashbyhq.com/ramp/…/application
  const cands = [
    c({ text: 'Upload file', cls: '_button_zyh3g_28 _secondary_zyh3g_115 _cta', type: 'submit' }),
    c({ text: 'Upload File', cls: '_button_zyh3g_28 _secondary_zyh3g_115', type: 'submit' }),
    c({ text: 'Yes', cls: '_container_pjyt6_1 _option_1svni_32', type: 'submit' }),
    c({ text: 'No', cls: '_container_pjyt6_1 _option_1svni_32', type: 'submit' }),
    c({ text: 'Submit Application', cls: '_button_zyh3g_28 _primary_zyh3g_97 _greedy_z', type: 'submit' }),
  ];
  const i = pickSubmit(cands);
  assert.equal(i, 4);
  assert.equal(cands[i!].text, 'Submit Application');
});

test('Lever: real submit is type=button; cookie buttons must not win', () => {
  // Verbatim shape from jobs.lever.co/palantir/…/apply
  const cands = [
    c({ text: 'Deny', cls: 'button button-sm cc-btn cc-deny', type: 'submit' }),
    c({ text: 'Accept', cls: 'button button-sm button-primary cc-btn cc-all', type: 'submit' }),
    c({ text: 'Submit application', cls: 'postings-btn template-btn-submit black', id: 'btn-submit', type: 'button' }),
  ];
  const i = pickSubmit(cands);
  assert.equal(i, 2, 'must pick #btn-submit, not the consent banner');
  assert.equal(cands[i!].id, 'btn-submit');
});

test('Lever: "ATTACH RESUME/CV" is never a submit', () => {
  assert.equal(scoreSubmitCandidate(c({ text: 'ATTACH RESUME/CV', cls: 'postings-btn' })), null);
});

test('destructive and consent lookalikes are all refused', () => {
  for (const text of [
    'Upload file', 'Attach Resume', 'Choose File', 'Replace', 'Remove', 'Delete',
    'Cancel', 'Back', 'Save draft', 'Accept', 'Deny', 'I agree', 'Sign in',
    'Create account', 'Apply with LinkedIn', 'Autofill with resume',
  ]) {
    assert.equal(scoreSubmitCandidate(c({ text })), null, `"${text}" must never be clicked as submit`);
  }
});

test('a disabled submit is not clickable', () => {
  assert.equal(
    scoreSubmitCandidate(c({ text: 'Submit Application', type: 'submit', disabled: true })),
    null,
  );
});

test('no trustworthy control → null, never a "first button" fallback', () => {
  const cands = [
    c({ text: 'Upload file', type: 'submit' }),
    c({ text: 'Yes', type: 'submit' }),
    c({ text: 'No', type: 'submit' }),
  ];
  assert.equal(pickSubmit(cands), null);
  assert.equal(pickSubmit([]), null);
});

test('exact submit wording outranks a merely submit-ish button', () => {
  const cands = [
    c({ text: 'Submit another response', type: 'button' }),
    c({ text: 'Submit Application', cls: '_primary_', type: 'submit' }),
  ];
  assert.equal(pickSubmit(cands), 1);
});
