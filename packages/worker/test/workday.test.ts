import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuestion, bestOption } from '../bin/run-workday.ts';

test('sponsorship and authorization never flip', () => {
  // The two that sink an application if inverted.
  assert.equal(resolveQuestion('Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status, spouse visa, etc)?'), 'No');
  assert.equal(resolveQuestion('Do you need visa sponsorship to work in the US?'), 'No');
  assert.equal(resolveQuestion('Are you legally authorized to work in the United States?'), 'Yes');
  assert.equal(resolveQuestion('Do you have the right to work in the country where this role is based?'), 'Yes');
});

test('"authorized" and "sponsorship" in one question resolve to sponsorship', () => {
  // Ordering matters: the sponsorship rule is listed first on purpose.
  assert.equal(
    resolveQuestion('Are you legally authorized to work in the US, and will you require sponsorship now or in the future?'),
    'No',
  );
});

test('standard screeners resolve deterministically', () => {
  assert.equal(resolveQuestion('Are you of legal age to work in the country in which this position will be based?'), 'Yes');
  assert.equal(resolveQuestion('Are you willing to submit a background check during the hiring process?'), 'Yes');
  assert.equal(resolveQuestion('Have you ever worked at Adobe in the following capacity:'), 'No');
  assert.equal(resolveQuestion('Do you have any competing offer deadlines?'), 'No');
  assert.equal(resolveQuestion('What is your current estimated graduation date (please enter in this format MM/YYYY)?'), '04/2027');
  assert.match(resolveQuestion('What is your degree major and/or minor?') ?? '', /Computer Science/);
});

test('unknown questions are refused, not guessed', () => {
  assert.equal(resolveQuestion('Describe a time you disagreed with your manager.'), null);
  assert.equal(resolveQuestion('What is your favourite Adobe product and why?'), null);
  assert.equal(resolveQuestion('For PhD candidates, what is your focus area or research statement?'), null);
});

test('bestOption prefers the exact label over longer near-matches', () => {
  // Real Adobe taxonomy rows that bit us: "SQL Tools" and "Restify" must lose.
  assert.equal(bestOption(['SQL Tools', 'Structured Query Language (SQL)', 'U-SQL'], 'Structured Query Language (SQL)'), 1);
  assert.equal(bestOption(['Restify', 'RESTful APIs', 'RESTful Web API'], 'RESTful APIs'), 1);
  assert.equal(bestOption(['Flask-RESTful', 'Flask (Web Framework)'], 'Flask (Web Framework)'), 1);
  assert.equal(bestOption(['Select One', 'Yes', 'No'], 'No'), 2);
});

test('bestOption never picks American Indian for an Asian self-ID', () => {
  const rows = [
    'American Indian or Alaska Native (Not Hispanic or Latino) (United States of America)',
    'Asian (Not Hispanic or Latino) (United States of America)',
  ];
  assert.equal(bestOption(rows, 'Asian'), 1);
});

test('bestOption returns -1 rather than a wrong row', () => {
  assert.equal(bestOption(['Select One', 'No Items.'], 'Docker'), -1);
  assert.equal(bestOption(['Glassdoor', 'Indeed'], ''), -1);
});
