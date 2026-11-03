import test from 'node:test';
import assert from 'node:assert/strict';
import { pollDiscovery, DEFAULT_POLL_INTERVAL_MS } from '../src/aggregate.ts';

/** A rippling-shaped feed, enough for discoverAll to yield one job. */
function stubFetch(): typeof fetch {
  const data = [
    { uuid: 'u1', name: 'SWE', url: 'https://ats.rippling.com/acme/jobs/u1', workLocation: { label: 'Remote' } },
  ];
  return (async () => ({ ok: true, status: 200, json: async () => data })) as unknown as typeof fetch;
}

test('pollDiscovery: runs an immediate cycle, then stop() halts it', async () => {
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 2 * 60 * 60 * 1000);

  const jobs = await new Promise<unknown[]>((res) => {
    const handle = pollDiscovery(
      [{ ats: 'rippling', slug: 'acme' }],
      (found) => {
        handle.stop();
        res(found);
      },
      { fetchImpl: stubFetch(), pollIntervalMs: 60_000 },
    );
  });

  assert.equal(jobs.length, 1);
});
