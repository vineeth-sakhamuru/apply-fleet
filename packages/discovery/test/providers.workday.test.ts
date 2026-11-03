import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchWorkday } from '../src/providers/workday.ts';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

/** Build a `fetch` stub returning the named fixture as JSON, capturing args. */
function fixtureFetch(name: string, calls: { url?: string; init?: RequestInit } = {}) {
  const data = JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
  return (async (url: string, init: RequestInit) => {
    calls.url = url;
    calls.init = init;
    return { ok: true, status: 200, json: async () => data };
  }) as unknown as typeof fetch;
}

function isIso(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && !Number.isNaN(Date.parse(s));
}

test('workday: parses the wday/cxs search feed (real NVIDIA capture)', async () => {
  const calls: { url?: string; init?: RequestInit } = {};
  const now = Date.parse('2026-07-30T12:00:00Z');
  const jobs = await fetchWorkday('nvidia:wd5:NVIDIAExternalCareerSite', {
    fetchImpl: fixtureFetch('workday.json', calls),
    now,
  });

  // POSTs to the tenant/site-scoped cxs endpoint with a JSON body.
  assert.equal(
    calls.url,
    'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs',
  );
  assert.equal(calls.init?.method, 'POST');
  assert.ok(String(calls.init?.body).includes('appliedFacets'));

  assert.equal(jobs.length, 4);
  const first = jobs[0];
  assert.equal(first.ats, 'workday');
  assert.equal(first.company, 'nvidia');
  assert.equal(first.role, 'Industry Partner Business Manager');
  assert.equal(first.externalId, 'JR2022252');
  assert.equal(first.location, 'US, CA, Remote');
  assert.equal(
    first.applyUrl,
    'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Remote/Industry-Partner-Business-Manager_JR2022252',
  );
  // "Posted Today" resolves to `now`.
  assert.ok(isIso(first.postedAt), `postedAt not ISO: ${first.postedAt}`);
  assert.equal(first.postedAt, new Date(now).toISOString());
});

test('workday: relative "Posted N Days Ago" resolves off now', async () => {
  const now = Date.parse('2026-07-30T00:00:00Z');
  const data = { jobPostings: [{ title: 'X', externalPath: '/job/a/X_JR9', postedOn: 'Posted 5 Days Ago', bulletFields: ['JR9'] }] };
  const stub = (async () => ({ ok: true, status: 200, json: async () => data })) as unknown as typeof fetch;
  const jobs = await fetchWorkday('acme:wd1:Ext', { fetchImpl: stub, now });
  assert.equal(jobs[0].postedAt, new Date(now - 5 * 86400000).toISOString());
});

test('workday: rejects a malformed slug', async () => {
  await assert.rejects(() => fetchWorkday('nvidia', {}), /tenant:dc:site/);
});

test('workday: throws on a non-ok response', async () => {
  const bad = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(() => fetchWorkday('a:b:c', { fetchImpl: bad }), /503/);
});
