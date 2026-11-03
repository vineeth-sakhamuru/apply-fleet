import test from 'node:test';
import assert from 'node:assert/strict';
import { readInbox, type MailTransport, type RawMessage } from '../src/index.ts';

function fakeTransport(msgs: RawMessage[]): MailTransport {
  return {
    async fetchSince(): Promise<RawMessage[]> {
      return msgs;
    },
  };
}

const base: RawMessage = {
  from: 'noreply@greenhouse.io',
  to: 'fleet+abc123@gmail.com',
  subject: 'Application received',
  html: null,
  text: null,
  receivedAt: 0,
};

test('readInbox coalesces null html/text to empty strings', async () => {
  const [m] = await readInbox(fakeTransport([{ ...base, receivedAt: 10 }]), 0);
  assert.equal(m.html, '');
  assert.equal(m.text, '');
});

test('readInbox drops messages older than sinceTs (day-granular over-fetch)', async () => {
  const msgs = [
    { ...base, receivedAt: 50 },
    { ...base, receivedAt: 150 },
  ];
  const out = await readInbox(fakeTransport(msgs), 100);
  assert.equal(out.length, 1);
  assert.equal(out[0].receivedAt, 150);
});

test('readInbox returns messages oldest-first', async () => {
  const msgs = [
    { ...base, receivedAt: 300 },
    { ...base, receivedAt: 100 },
    { ...base, receivedAt: 200 },
  ];
  const out = await readInbox(fakeTransport(msgs), 0);
  assert.deepEqual(
    out.map((m) => m.receivedAt),
    [100, 200, 300],
  );
});

test('readInbox passes through non-null html/text unchanged', async () => {
  const [m] = await readInbox(
    fakeTransport([{ ...base, receivedAt: 5, html: '<p>hi</p>', text: 'hi' }]),
    0,
  );
  assert.equal(m.html, '<p>hi</p>');
  assert.equal(m.text, 'hi');
});
