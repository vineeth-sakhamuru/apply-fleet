/**
 * Schema-first Greenhouse filler. Reads the job's questions from the public
 * boards API (no DOM discovery), resolves every answer at once through the same
 * resolver fill-chrome uses, sets the whole page in ONE in-page pass, reads it
 * back once. NEVER clicks Submit.
 *
 * Usage: node packages/worker/bin/gh-fill.ts <tabMatch> --resume path.pdf [--intern] [--board token]
 *   --board is only needed when the tab URL doesn't name the board (company careers pages).
 *
 * ponytail: standard job-boards.greenhouse.io pages (react-select, input id = field
 * name) only. Custom-skinned boards (careers.duolingo.com) and the education block
 * are reported as SKIPPED; add them when a run needs them.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { loadProfile, loadAnswers } from '@apply-fleet/data';
import { chromePage } from '../src/chrome.ts';
import { pickOption } from '../src/engine.ts';
import { resolve, DECLINE } from '../src/resolver.ts';
import type { FieldSpec, ResolveCtx } from '../src/types.ts';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const intern = args.includes('--intern') && !!args.splice(args.indexOf('--intern'), 1);
const resumePath = flag('--resume');
let board = flag('--board');
const match = args[0];
if (!match) throw new Error('usage: gh-fill.ts <tabMatch> --resume path.pdf [--intern] [--board token]');
if (resumePath && !existsSync(resumePath)) throw new Error(`résumé not found: ${resumePath}`);

const root = resolvePath(import.meta.dirname, '../../..');
const ctx: ResolveCtx = {
  profile: loadProfile(resolvePath(root, 'config/profile.yml')),
  answers: loadAnswers(resolvePath(root, 'config/answers.yml')),
  resumePath,
};
if (intern) {
  const an = ctx.answers as any;
  an.compensation.desired_total_comp = an.compensation.intern_hourly;
  an.availability.earliest_start_date = an.availability.intern_start;
  an.education[0].graduation = an.education[0].graduation_intern;
}

const t0 = Date.now();
const lap = (s: string) => process.env.GH_TIME && console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const page = await chromePage(match);
const url = new URL(page.url());

/** Board token + job id from any Greenhouse URL shape we've seen. */
function parseJob(u: URL): { board?: string; id?: string } {
  const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (m && /greenhouse\.io$/.test(u.hostname)) return { board: m[1], id: m[2] };
  return { board: u.searchParams.get('for') ?? undefined, id: u.searchParams.get('token') ?? u.searchParams.get('gh_jid') ?? undefined };
}
const job = parseJob(url);
board ??= job.board;
if (!board || !job.id) throw new Error(`can't tell board/job from ${url.href}; pass --board`);

const api = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${job.id}?questions=true`);
if (!api.ok) throw new Error(`boards API ${api.status} for ${board}/${job.id}`);
const schema: any = await api.json();
lap('schema');

// One flat list of fields. Compliance labels are camel-case ("VeteranStatus"): use the field name.
type Q = { name: string; label: string; required: boolean; type: string; options: string[] };
const qs: Q[] = [];
const add = (q: any, label?: string) => {
  for (const f of q.fields) {
    if (/_text$/.test(f.name) || f.name === 'cover_letter') continue; // paste-in alternatives
    qs.push({ name: f.name, label: label ?? q.label, required: !!q.required, type: f.type, options: (f.values ?? []).map((v: any) => v.label) });
  }
};
for (const q of schema.questions ?? []) add(q);
for (const q of schema.location_questions ?? []) add(q);
for (const c of schema.compliance ?? []) for (const q of c.questions ?? []) add(q, q.fields[0].name.replace(/_/g, ' '));

// Page-only fields the API doesn't list: the phone country picker, and the
// Hispanic yes/no that EEOC forms show above race.
const extra = await page.evaluate(`['country','hispanic_ethnicity'].filter(function(id){return !!document.getElementById(id)})`) as string[];
if (extra.includes('hispanic_ethnicity')) qs.push({ name: 'hispanic_ethnicity', label: 'hispanic latino', required: false, type: 'multi_value_single_select', options: ['Yes', 'No', 'Decline To Self Identify'] });

type Plan = { id: string; label: string; kind: 'text' | 'select' | 'file'; value: string; note: string };
const plan: Plan[] = [];
for (const q of qs) {
  if (q.type === 'input_file') { plan.push({ id: q.name, label: q.label, kind: 'file', value: resumePath ?? '', note: resumePath ? '' : 'NO RESUME GIVEN' }); continue; }
  const kind = q.type.startsWith('multi_value') ? 'select' : 'text';
  const spec: FieldSpec = { kind: kind === 'select' ? 'select' : q.type === 'textarea' ? 'textarea' : 'text', label: q.label, selector: `#${q.name}`, required: q.required, options: q.options };
  const r = await resolve(spec, ctx);
  if (r.status !== 'resolved') { plan.push({ id: q.name, label: q.label, kind, value: '', note: r.status === 'skip' ? `skip (${r.reason})` : 'NEEDS YOU' }); continue; }
  let value = r.value;
  if (kind === 'select') {
    const i = value === DECLINE ? q.options.findIndex((o) => /decline|don.t wish|prefer not/i.test(o)) : pickOption(q.options, value);
    if (i == null || i < 0) { plan.push({ id: q.name, label: q.label, kind, value: '', note: `NO OPTION for "${value}"` }); continue; }
    value = q.options[i];
  }
  plan.push({ id: q.name, label: q.label, kind, value, note: '' });
}
// ponytail: US-only phone code; he lives in the US. Make it a profile field if that changes.
if (extra.includes('country')) plan.unshift({ id: 'country', label: 'Phone country', kind: 'select', value: 'United States +1', note: '' });
// Hispanic must be answered before race renders on some boards.
plan.sort((a, b) => Number(b.id === 'hispanic_ethnicity') - Number(a.id === 'hispanic_ethnicity'));

lap('resolved');
// Chrome throttles timers in hidden/occluded windows, which stalls the in-page pass. Front the tab.
execFileSync('osascript', ['-l', 'JavaScript', '-e', `var c=Application("Google Chrome"); c.windows().some(function(w){return w.tabs().some(function(t,i){if(t.url().indexOf(${JSON.stringify(match)})>=0){w.activeTabIndex=i+1; w.index=1; c.activate(); return true}})})`]);

for (const f of plan.filter((p) => p.kind === 'file' && p.value)) await page.setInputFiles(`[id="${f.id}"]`, f.value);

lap('résumé');
// ONE in-page pass for every text and select field.
const todo = plan.filter((p) => p.kind !== 'file' && p.value).map((p) => [p.id, p.kind, p.value]);
await page.evaluate(`(function(T){
var wait=function(f,ms){return new Promise(function(res){var t=0;(function poll(){var v=f();if(v||t>=ms)return res(v);t+=40;setTimeout(poll,40)})()})};
var mouse=function(el){var r=el.getBoundingClientRect();var k={bubbles:true,cancelable:true,view:window,button:0,clientX:r.x+r.width/2,clientY:r.y+r.height/2};['pointerdown','mousedown','pointerup','mouseup'].forEach(function(t){el.dispatchEvent(t.indexOf('pointer')===0?new PointerEvent(t,k):new MouseEvent(t,k))})};
document.documentElement.removeAttribute('data-gh-done');
(async function(){var out=[];
for(var n=0;n<T.length;n++){var id=T[n][0],kind=T[n][1],v=T[n][2];
 try{var el=await wait(function(){return document.getElementById(id)},2000); if(!el){out.push(id+': MISSING');continue}
 if(kind==='text'){var pr=Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value'); el.focus(); pr.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); el.blur(); out.push(id+': ok'); continue}
 el.scrollIntoView({block:'center'}); el.focus(); mouse(el);
 var lb=await wait(function(){var c=el.getAttribute('aria-controls'); var x=c&&document.getElementById(c); return x&&x.querySelector('[role=option]')?x:null},2500);
 var o=lb&&[].slice.call(lb.querySelectorAll('[role=option]')).filter(function(o){return o.textContent.trim()===v})[0];
 if(!o){out.push(id+': option not shown');el.blur();continue}
 o.click(); await wait(function(){return !document.getElementById(lb.id)},800); out.push(id+': ok');
 }catch(e){out.push(id+': ERR '+e)}}
document.documentElement.setAttribute('data-gh-done',JSON.stringify(out))})(); return 1})(${JSON.stringify(todo)})`);
let done: string | null = null;
for (let i = 0; i < 240 && !(done = await page.evaluate(`document.documentElement.getAttribute('data-gh-done')`) as string | null); i++) await page.waitForTimeout(250);
if (!done) throw new Error('in-page pass did not finish in 60s (tab hidden?)');

lap('filled');
// Read back once: what the PAGE holds is the only evidence.
const shown = await page.evaluate(`(function(P){return P.map(function(p){if(p[1]==='file') return document.body.innerText.indexOf(p[2])>=0?p[2]:''; // the input re-renders after upload; the file name shows on the page
 var el=document.getElementById(p[0]); if(!el) return '?';
 if(p[1]==='select'){var t=((el.closest('[class*=control]')||{}).innerText||'').trim(); return /^select\\.{0,3}$/i.test(t)?'':t}
 return el.value})})(${JSON.stringify(plan.map((p) => [p.id, p.kind, p.value.split('/').pop()]))})`) as string[];

let bad = 0;
console.log(`\n${url.href}  (${schema.title} @ ${schema.company_name ?? board})\n`);
plan.forEach((p, i) => {
  const got = shown[i] ?? '';
  const req = qs.find((q) => q.name === p.id)?.required ?? false;
  // Pages reformat what we set: "+1" for "United States +1", "(555) 010-0100" for "555-010-0100".
  const digits = (s: string) => s.replace(/\D/g, '');
  const ok = p.value
    ? p.kind === 'file' ? got === p.value.split('/').pop()
      : !!got && (got.includes(p.value) || p.value.includes(got) || (/\d{7}/.test(digits(got)) && digits(got) === digits(p.value)))
    : !req;
  if (!ok) bad++;
  console.log(`${ok ? '  ' : '!!'} ${p.label.slice(0, 50).padEnd(50)} ${req ? '*' : ' '} page="${got.slice(0, 40)}" ${p.note}`);
});
if (schema.education) console.log(`!! education block (${schema.education}) SKIPPED: not handled yet`);
console.log(`\n${plan.length} fields, ${bad} need you, ${((Date.now() - t0) / 1000).toFixed(1)}s. Submit not clicked.`);
