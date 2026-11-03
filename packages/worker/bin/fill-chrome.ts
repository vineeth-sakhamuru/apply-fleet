/**
 * Fill the application form open in the user's own Chrome: scan → resolve
 * (grounded only) → fill → read every field back off the page → print the
 * table + wall-clock time. NEVER clicks Submit/Next/Apply; that click is his.
 *
 * Usage: node packages/worker/bin/fill-chrome.ts [urlSubstring] [--resume path.pdf] [--company X] [--intern] [--scan]
 *   no urlSubstring → the active tab of Chrome's front window.
 */
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { loadProfile, loadAnswers } from '@apply-fleet/data';
import { chromePage } from '../src/chrome.ts';
import { scanForm, fillField, uploadResume } from '../src/engine.ts';
import { resolve, DECLINE, ALL } from '../src/resolver.ts';
import type { FieldSpec, ResolveCtx } from '../src/types.ts';

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const bool = (n: string) => args.includes(n) && !!args.splice(args.indexOf(n), 1);
const scanOnly = bool('--scan');
const intern = bool('--intern');
const resumePath = flag('--resume');
const company = flag('--company');
const match = args[0] ?? '';

const root = resolvePath(import.meta.dirname, '../../..');
const ctx: ResolveCtx = {
  profile: loadProfile(resolvePath(root, 'config/profile.yml')),
  answers: loadAnswers(resolvePath(root, 'config/answers.yml')),
  company,
  resumePath,
};
// Internship forms get the bible's intern answers: pay, start, graduation.
if (intern) {
  const an = ctx.answers as any;
  an.compensation.desired_total_comp = an.compensation.intern_hourly;
  an.availability.earliest_start_date = an.availability.intern_start;
  an.education[0].graduation = an.education[0].graduation_intern;
}
if (resumePath && !existsSync(resumePath)) throw new Error(`résumé not found: ${resumePath}`);

const t0 = Date.now();
const page = await chromePage(match);
const fields = await scanForm(page as any);

if (scanOnly) {
  for (const f of fields) console.log(JSON.stringify(f));
  process.exit(0);
}

// What the page holds before we touch it, read the same way as the readback.
const readAll = (specs: FieldSpec[]) => page.evaluate((specs: FieldSpec[]) => {
  const clean = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
  const lab = (el: any) => clean((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || el.value);
  return specs.map((f) => {
    if (f.kind === 'radio') {
      const on = [...document.querySelectorAll(f.selector)].find((r: any) => r.checked) as any;
      return on ? lab(on) : '';
    }
    if (f.kind === 'choice' && f.name) {
      return [...document.querySelectorAll(`input[name="${f.name}"]:checked`)].map(lab).join('; ');
    }
    const el = f.selector ? (document.querySelector(f.selector) as any) : null;
    if (!el) return '?';
    if (f.kind === 'listbox') {
      const t = clean(el.textContent || '');
      return (f.options || []).find((o) => o && t.includes(o)) || '';
    }
    if (f.kind === 'multilistbox') {
      return [...el.querySelectorAll('[role="option"][aria-selected="true"]')].map((o: any) => clean((o.innerText || '').split('\n')[0])).join('; ');
    }
    if (f.kind === 'file') return [...(el.files || [])].map((x: any) => x.name).join(', ');
    if (f.kind === 'checkbox') return el.checked ? 'checked' : '';
    if (f.kind === 'select') return el.selectedIndex > 0 ? clean(el.options[el.selectedIndex]?.textContent || '') : '';
    if (el.value) return el.value;
    // react-select / custom combobox: the chosen label lives beside the input.
    // react-select shows "Select..." until something is chosen: that is empty.
    const shown = clean(el.closest('[class*="control"]')?.innerText || '');
    return /^select\.{0,3}$/i.test(shown) ? '' : shown;
  });
}, specs) as Promise<string[]>;

const before = await readAll(fields);
// A label that repeats is a repeated section (3 jobs, 2 schools). One answer
// for "Employer name" would land in every block, so those stay untouched.
const seen = new Map<string, number>();
for (const f of fields) seen.set(f.label, (seen.get(f.label) ?? 0) + 1);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type Row = { f: FieldSpec; want: string; status: string };
const rows: Row[] = [];
// Résumé first: some ATSes re-render the form from a parsed upload.
const ordered = [...fields.filter((f) => f.kind === 'file'), ...fields.filter((f) => f.kind !== 'file')];
for (const f of ordered) {
  if (f.kind === 'file') {
    if (!resumePath) { rows.push({ f, want: '', status: 'NO RESUME GIVEN' }); continue; }
    try {
      await uploadResume(page as any, f.selector, resumePath);
      rows.push({ f, want: resumePath.split('/').pop()!, status: 'filled' });
    } catch (e) {
      rows.push({ f, want: '', status: `UPLOAD FAILED: ${(e as Error).message}` });
    }
    continue;
  }
  const r = await resolve(f, ctx);
  const had = before[fields.indexOf(f)] ?? '';
  if (f.kind !== 'file' && (seen.get(f.label) ?? 0) > 1 && f.kind !== 'radio') {
    rows.push({ f, want: '', status: had ? 'kept (repeated section)' : 'NEEDS YOU (repeated section)' });
    continue;
  }
  // Never overwrite what the page already holds (his saved profile, the ATS's
  // own autofill). Report a disagreement instead so he decides.
  if (had && had !== '?' && r.status === 'resolved') {
    const want = r.value;
    const same = want === DECLINE || want === ALL || norm(had).includes(norm(want)) || norm(want).includes(norm(had));
    rows.push({ f, want, status: same ? 'kept' : `DIFFERS: bible says "${want.slice(0, 40)}"` });
    continue;
  }
  if (r.status === 'resolved') {
    const ok = await fillField(page as any, f, r.value);
    rows.push({ f, want: r.value === DECLINE ? '(decline)' : r.value === ALL ? '(all)' : r.value, status: ok ? 'filled' : 'FILL FAILED' });
  } else if (r.status === 'hitl') rows.push({ f, want: '', status: 'NEEDS YOU' });
  else rows.push({ f, want: '', status: r.status === 'skip' ? `skip (${r.reason})` : 'NEEDS YOU' });
}

// Read back what the PAGE now holds — the only evidence that counts.
const shown = await readAll(rows.map((r) => r.f));

const ms = Date.now() - t0;
let bad = 0;
console.log(`\n${page.url()}\n`);
rows.forEach((r, i) => {
  const got = shown[i] ?? '';
  const ok = r.status === 'filled' ? !!got : r.status === 'kept' || r.status.startsWith('skip') || r.status.startsWith('kept');
  const flagged = ok ? '  ' : '!!';
  if (flagged === '!!') bad++;
  console.log(`${flagged} ${(r.f.label || r.f.name || r.f.kind).slice(0, 48).padEnd(48)} ${r.f.required ? '*' : ' '} page="${got.slice(0, 40)}"  ${r.status === 'filled' ? '' : r.status}`);
});
console.log(`\n${rows.length} fields, ${bad} need you, ${(ms / 1000).toFixed(1)}s. Submit/Next not clicked.`);
