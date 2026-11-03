import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchTeamtailor } from '../src/providers/teamtailor.ts';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

function fixtureFetch(name: string, calls: { url?: string } = {}): typeof fetch {
  const data = JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
  return (async (url: string) => {
    calls.url = url;
    return { ok: true, status: 200, json: async () => data };
  }) as unknown as typeof fetch;
}

function isIso(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && !Number.isNaN(Date.parse(s));
}

test('teamtailor: parses the JSON feed (real capture)', async () => {
  const calls: { url?: string } = {};
  const jobs = await fetchTeamtailor('career', { fetchImpl: fixtureFetch('teamtailor.json', calls) });

  assert.equal(calls.url, 'https://career.teamtailor.com/jobs.json');
  assert.ok(jobs.length >= 1);
  const first = jobs[0];
  assert.equal(first.ats, 'teamtailor');
  assert.equal(first.role, 'Group Financial Controller');
  assert.equal(first.externalId, '3ce2c88b-cbc6-4ae9-8ecb-000466c69037');
  assert.equal(first.applyUrl, 'https://career.teamtailor.com/jobs/8124573-group-financial-controller');
  assert.equal(first.company, 'Teamtailor'); // from _jobposting.hiringOrganization
  assert.equal(first.location, 'Stockholm, Sweden, SE');
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
});

test('teamtailor: company override wins', async () => {
  const jobs = await fetchTeamtailor('career', {
    fetchImpl: fixtureFetch('teamtailor.json'),
    company: 'TT Inc',
  });
  assert.equal(jobs[0].company, 'TT Inc');
});

test('teamtailor: throws on a non-ok response', async () => {
  const bad = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(() => fetchTeamtailor('career', { fetchImpl: bad }), /404/);
});
