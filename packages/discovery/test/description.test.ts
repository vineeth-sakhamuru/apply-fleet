import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, MAX_DESCRIPTION_CHARS } from '../src/types.ts';

// The JD text feeds résumé keyword matching. It was never captured at all, so
// tailoring ran against "Role — Company" and matched nothing.

test('decodes before stripping — entity-encoded tags must not survive', () => {
  // Greenhouse's `content` is entity-encoded HTML. Stripping first leaves
  // &lt;p&gt; alone, and a later decode turns it back into a live tag.
  const out = htmlToText('&lt;p&gt;Build &lt;b&gt;backend&lt;/b&gt; systems&lt;/p&gt;');
  assert.ok(!/[<>]/.test(out), `tags leaked: ${out}`);
  assert.match(out, /Build/);
  assert.match(out, /backend/);
});

test('strips real tags and script bodies', () => {
  const out = htmlToText('<script>alert(1)</script><p>Python and AWS</p>');
  assert.ok(!out.includes('alert'), 'script body must not reach the keyword bag');
  assert.match(out, /Python and AWS/);
});

test('decodes named and numeric entities', () => {
  assert.match(htmlToText('R&amp;D'), /R&D/);
  assert.match(htmlToText('It&#39;s'), /It's/);
  assert.match(htmlToText('It&#x27;s'), /It's/);
});

test('block tags become newlines so words do not fuse', () => {
  const out = htmlToText('<li>Python</li><li>Go</li>');
  assert.ok(!/PythonGo/.test(out), 'list items must not concatenate');
});

test('truncates — the whole thing lands in an event row', () => {
  assert.equal(htmlToText('<p>' + 'x'.repeat(50_000) + '</p>').length, MAX_DESCRIPTION_CHARS);
});

test('handles double-encoded payloads — Greenhouse sends some', () => {
  // One decode pass turns `&amp;nbsp;` into a literal `&nbsp;` in the text.
  const out = htmlToText('&amp;lt;p&amp;gt;Kotlin&amp;nbsp;and Swift&amp;lt;/p&amp;gt;');
  assert.ok(!/&[a-z]+;/i.test(out), `entities leaked: ${out}`);
  assert.ok(!/[<>]/.test(out), `tags leaked: ${out}`);
  assert.match(out, /Kotlin/);
  assert.match(out, /Swift/);
});
