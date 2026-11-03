/**
 * Drive one Workday application in his Chrome from "My Information" to the last
 * page before Submit. Lessons from KLA/Hitachi/GM/Salesforce (2026-10-12..15):
 * - Steps share one URL; the step is the "current step N of M" text.
 * - Sessions die after ~30 min idle: run right after sign-in, never leave it.
 * - "How did you hear" is a nested multiselect (category -> leaf).
 * - Date sections only commit through React: call each input's onChange, then
 *   the dateInputWrapper's onBlur (main world), or Save stays blocked.
 * - Field of study lists are virtualized (1000+): click "All" and scroll.
 * Never presses Submit. Stops on any page it can't fully answer and prints why.
 *
 * Usage: node workday-run.ts <tabMatch> <resume.pdf> [--intern]
 */
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { loadAnswers } from '@apply-fleet/data';
import { chromePage } from '../src/chrome.ts';

const [match, resume, ...rest] = process.argv.slice(2);
const intern = rest.includes('--intern');
const p = await chromePage(match);
const fill = resolvePath(import.meta.dirname, 'fill-chrome.ts');
const contact = loadAnswers(resolvePath(import.meta.dirname, '../../../config/answers.yml')).contact as Record<string, string>;
const t0 = Date.now();
const log = (...a: any[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const FIRE = `function(el){el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();var k={bubbles:true,cancelable:true,view:window,button:0,clientX:r.x+4,clientY:r.y+4};['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(e){el.dispatchEvent(e.indexOf('pointer')===0?new PointerEvent(e,k):new MouseEvent(e,k))})}`;
const ev = (fn: string, arg?: unknown) => p.evaluate(`(function(arg){var fire=${FIRE};${fn}})(${JSON.stringify(arg ?? null)})`);
const sleep = (ms: number) => p.waitForTimeout(ms);
const step = async () => String(await p.evaluate(() => { const m = document.body.innerText.match(/current step \d+ of \d+\n([^\n]*)/i); return m ? m[1].trim() : (/Sign In/.test(document.body.innerText) ? 'Sign In' : ''); }));
const crashed = async () => !!(await p.evaluate(() => /Something went wrong/.test(document.body.innerText)));
const errors = async () => (await p.evaluate(() => [...document.querySelectorAll('[data-automation-id=errorMessage]')].map((e: any) => e.innerText.trim()))) as string[];

// ---------- primitives ----------
const listbox = async (idSuffix: string, want: RegExp | RegExp[]) => {
  const wants = (Array.isArray(want) ? want : [want]).map((r) => r.source);
  const ok = await ev(`var b=document.querySelector('button[id$="'+arg.id+'"]'); if(!b) return false; fire(b); return true;`, { id: idSuffix });
  if (!ok) return `${idSuffix}: missing`;
  await sleep(700);
  const r = await ev(`var os=[].slice.call(document.querySelectorAll('[role=listbox] [role=option]')).filter(function(o){return o.getClientRects().length}); var o=null; for(var w=0;w<arg.srcs.length&&!o;w++){var re=new RegExp(arg.srcs[w],'i'); o=os.filter(function(o){return re.test(o.innerText.trim())})[0];} if(!o) return 'NO MATCH in '+os.map(function(o){return o.innerText.trim()}).slice(0,15).join(' / '); fire(o); return 'ok';`, { srcs: wants });
  await sleep(500);
  return `${idSuffix}: ${r} -> ${await ev(`var b=document.querySelector('button[id$="'+arg.id+'"]'); return b?b.innerText.trim():''`, { id: idSuffix })}`;
};
const setText = (id: string, v: string) => ev(`var el=document.getElementById(arg.id)||document.querySelector('[id$="'+arg.id+'"]'); if(!el) return arg.id+' missing'; el.focus(); Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,arg.v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); return arg.id+'='+String(el.value).slice(0,30);`, { id, v });
const radio = (labelSrc: string, ans: string) => ev(`var fs=[].slice.call(document.querySelectorAll('[data-automation-id^="formField"],fieldset')).filter(function(f){return new RegExp(arg.src,'i').test(f.innerText)&&f.querySelector('input[type=radio]')}); if(!fs.length) return 'none'; var out=[]; fs.forEach(function(f){var r=[].slice.call(f.querySelectorAll('input[type=radio]')).filter(function(r){return ((r.labels&&r.labels[0]&&r.labels[0].innerText)||'').trim()===arg.ans})[0]; if(r&&!r.checked) fire(r); out.push(r?r.checked:'no-'+arg.ans)}); return out.join(',');`, { src: labelSrc, ans });
const lbScroll = (i: number) => ev(`var lb=[].slice.call(document.querySelectorAll('[role=listbox]')).filter(function(x){return x.getClientRects().length&&x.querySelector('[aria-setsize]')}).pop(); if(lb){lb.scrollTop=arg*150; lb.dispatchEvent(new Event('scroll'))} return 1;`, i);
const lbOpts = async () => (await ev(`var lb=[].slice.call(document.querySelectorAll('[role=listbox]')).filter(function(x){return x.getClientRects().length&&x.querySelector('[aria-setsize]')}).pop(); return lb?[].slice.call(lb.querySelectorAll('[role=option]')).map(function(o){return o.innerText.trim()}):[];`)) as string[];
const lbAll = async () => { const s = new Set<string>(); for (let i = 0; i < 12; i++) { (await lbOpts()).forEach((x) => s.add(x)); await lbScroll(i); await sleep(100); } await lbScroll(0); await sleep(150); return [...s]; };
const lbPick = async (text: string, maxScroll = 20) => {
  for (let i = 0; i < maxScroll; i++) {
    const ok = await ev(`var o=[].slice.call(document.querySelectorAll('[role=listbox] [role=option]')).filter(function(x){return x.getClientRects().length&&x.innerText.trim()===arg})[0]; if(!o) return false; fire(o.querySelector('input[type=radio],input[type=checkbox],[data-automation-id="promptOption"]')||o); return true;`, text);
    if (ok) { await sleep(1000); return true; }
    await lbScroll(i + 1); await sleep(130);
  }
  return false;
};
const openPrompt = async (inputSel: string) => { await ev(`var i=document.querySelector(arg); if(!i) return 0; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})); fire(i); return 1;`, inputSel); await sleep(1200); };

// Main world (React props live there).
const main = async (code: string) => {
  await ev(`document.documentElement.removeAttribute('data-af-out'); var s=document.createElement('script'); var n=document.querySelector('script[nonce]'); if(n&&n.nonce) s.nonce=n.nonce; var src="try{document.documentElement.setAttribute('data-af-out',JSON.stringify((function(){"+arg+"})()))}catch(e){document.documentElement.setAttribute('data-af-out',JSON.stringify('ERR '+e))}"; var tt=window.trustedTypes; s.textContent=tt?tt.createPolicy('af'+Math.random(),{createScript:function(x){return x}}).createScript(src):src; document.documentElement.appendChild(s); s.remove(); return 1;`, code);
  await sleep(150);
  return p.evaluate(() => document.documentElement.getAttribute('data-af-out'));
};
const commitDates = () => main(`var P=function(el){return el[Object.keys(el).find(function(k){return k.indexOf('__reactProps')===0})]}; var n=0; document.querySelectorAll('[data-automation-id=dateInputWrapper]').forEach(function(w){var ins=[].slice.call(w.querySelectorAll('input[data-automation-id$=-input]')); if(!ins.length) return; ins.forEach(function(i){var pr=P(i); var e={target:i,currentTarget:i,nativeEvent:{},preventDefault:function(){},stopPropagation:function(){}}; pr.onFocus&&pr.onFocus(e); pr.onChange&&pr.onChange(e)}); var wp=P(w); wp.onBlur&&wp.onBlur({target:ins[ins.length-1],currentTarget:w,relatedTarget:document.body,nativeEvent:{relatedTarget:document.body},preventDefault:function(){},stopPropagation:function(){}}); n++}); return n;`);

// Workday keeps Save disabled while the tab is hidden (visibilityState), so front it first.
const front = () => execFileSync('osascript', ['-l', 'JavaScript', '-e', `var c=Application("Google Chrome"); c.windows().some(function(w){return w.tabs().some(function(t,i){if(t.url().indexOf(${JSON.stringify(match)})>=0){w.activeTabIndex=i+1; w.index=1; c.activate(); return true}})})`]);
const saveContinue = async () => {
  front(); await sleep(500);
  const before = await step();
  await ev(`var b=document.querySelector('[data-automation-id=pageFooterNextButton]'); if(b) fire(b); return !!b;`);
  for (let i = 0; i < 80 && (await step()) === before; i++) await sleep(250);
  await sleep(1200);
  return (await step()) !== before;
};

// The section's own Add button: walk up from each add-button until the
// container's text starts with the section name (tenants differ on heading tags).
const addIn = (section: string) => ev(`var re=new RegExp('^'+arg); var bs=[].slice.call(document.querySelectorAll('button[data-automation-id=add-button]')); for(var i=0;i<bs.length;i++){var e=bs[i]; for(var k=0;k<6&&e;k++){ if(re.test((e.innerText||'').trim())){ fire(bs[i]); return true;} e=e.parentElement; }} return false;`, section);

// ---------- data ----------
const JOBS = [
  { t: 'Graduate Teaching Assistant', c: 'Northeastern University', l: 'San Jose, CA', cur: true, sm: '09', sy: '2026', d: 'Wrote the GCP and HPC setup guide the class uses to run course code, and support about 50 graduate students in weekly recitations and office hours. Built a sandboxed autograder for NLP assignments, tested against a 17-case answer key; fixed 3 harness bugs that failed correct submissions.' },
  { t: 'Software Engineer, Co-op (Agentic AI)', c: 'Evenness', l: 'San Jose, CA', cur: false, sm: '05', sy: '2026', em: '09', ey: '2026', d: 'Evaluated Gemini and Claude as the production LLM for an AI assistant on cost, structured output, latency, and rate limits; showed the failures came from integration code, not the model, and the team merged my fixes. Designed the API contract and an async request/queue/poll pipeline across 5 microservices with shared PostgreSQL and Redis state; adopted by 2 teams as the standard integration path. Replaced brittle regex parsing of LLM output with schema-validated structured responses behind a full test suite, with 0 regressions.' },
  { t: 'Machine Learning Engineer Intern', c: 'OSI Digital Pvt. Ltd.', l: 'Hyderabad, India', cur: false, sm: '01', sy: '2024', em: '06', ey: '2024', d: 'Deployed RAG systems with vector databases (Pinecone, ChromaDB) and LangChain, reducing process hours by 75% and improving retrieval accuracy by 60%. Engineered FastAPI services integrating GPT-3.5/4, handling 1,000+ concurrent requests at 95% test coverage. Built production text-classification services with transformer models (BERT, DistilBERT), improving accuracy by 25% and automating parsing of 5,000+ documents monthly.' },
  { t: 'Software Engineering Intern', c: 'Tech Mahindra', l: 'Hyderabad, India', cur: false, sm: '06', sy: '2023', em: '08', ey: '2023', d: 'Developed backend microservices in Python over external APIs and resolved integration defects, accelerating text extraction by 50%.' },
];
const EDU = [
  { school: 'Northeastern University', degree: [/^Master of Science$/i, /^Master'?s Degree$/i, /^Masters? Degree$/i, /^MS$/i, /^Master of Science in Computer/i, /^Masters?$/i, /^M\.?S\.?$/i, /^Master’s or Equivalent/i], field: /^(Computer Science|Computer and Information Science|Computer Science and Engineering)$/i, fieldQuery: 'Computer Science', gpa: '3.6', ey: intern ? '2027' : '2027', em: intern ? '12' : '05' },
  { school: 'ICFAI Foundation for Higher Education', degree: [/^Bachelor of Technology$/i, /^Bachelor of Science$/i, /^Bachelor'?s Degree$/i, /^Bachelors? Degree$/i, /^BS$/i, /^B\.?Tech/i, /^Bachelors?$/i, /^Bachelor’s or Equivalent/i], fieldQuery: 'Data Science', field: /^(Artificial Intelligence and Data Science|Data Science and Artificial Intelligence|Data Science|Computer Science)$/i, gpa: '', ey: '2024', em: '08' },
];
// Bible answer is the company's own site; never fall into a job-board leaf (it
// picks an arbitrary board like CareerBuilder, which is false).
const HEARD = [/^(Company|Corporate) (Career )?(Web)?site$/i, /Careers? (Web)?site|Company (Web)?site|Career Site/i, /^[\w&. ]+ Website$/i, /LinkedIn/i, /^Other$/i];
// Question-page dropdowns: [label, answer]. First label match wins, so order matters.
// The runner used to stop on every one of these and leave them for hand clicks (Visa 2026-10-27).
const QA: [RegExp, RegExp][] = [
  [/sponsorship/i, /^No$/],
  // Export-control screen (FICO 2026-11-01): the field's label is a preamble, the question is in the field text.
  [/lawful permanent resident|green card/i, /^Yes$/],
  [/legally (eligible|authorized)|authorized to work/i, /^Yes$/],
  [/verification of (your )?identity|proof of (identity|age)/i, /^Yes$/],
  [/18 years|age of 18/i, /^Yes$/],
  [/military spouse|National Guard|Reserves/i, /^No$/],
  [/SMS|text messag/i, /^Opt-?Out$|^No$/i],
  [/automated tools/i, /^Opt-?In$|^Yes$/i],
  [/anticipated graduation|expected graduation|graduation date/i, intern ? /^December 2027$|^Dec(ember)? 2027/i : /^May 2027$|^May 2027/i],
  [/highest level of education/i, /^Bachelor'?s?$/i],
  [/previously (worked|been employed)|ever (worked|been employed)|former employee|currently employed by/i, /^No\b/i],
  [/relative|family member/i, /^No\b/i],
  [/non-?compete|restrictive (covenant|agreement)|non-?solicit/i, /^No\b/i],
  [/gender/i, /^Male$/],
  [/Hispanic or Latino/i, /^No$/],
  [/Race|Ethnicity/i, /^South Asian|^Asian( \(|$)/i],
  [/veteran|military connected/i, /^I AM NOT A VETERAN$|^I am not a (protected )?veteran|^Not a Veteran/i],
];
// Free-text screeners: [field text, answer]. Pre-written and cleaned so no drafting happens mid-form (FICO 2026-11-01 stalled on both).
const TEXT: [RegExp, string][] = [
  [/countr(y|ies) of (citizenship|nationality)|citizenship.*nationality/i, 'India'],
  [/salary|compensation expectations|desired (pay|compensation)/i, intern ? '$55 per hour, flexible.' : '$130,000 base. Flexible on total compensation.'],
];
async function answerText() {
  const out = await ev(`var T=arg; var n=[]; [].slice.call(document.querySelectorAll('[data-automation-id^="formField"]')).forEach(function(f){var t=f.querySelector('textarea,input[type=text]'); if(!t||t.value||!f.getClientRects().length) return; var lab=f.innerText; for(var k=0;k<T.length;k++){ if(new RegExp(T[k][0],'i').test(lab)){ t.focus(); Object.getOwnPropertyDescriptor(t.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(t,T[k][1]); t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true})); t.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); n.push(T[k][1]); break; } } }); return n;`, TEXT.map(([r, v]) => [r.source, v]));
  if ((out as string[]).length) log('text:', JSON.stringify(out));
}
async function answerQuestions() {
  await answerText();
  const btns = (await ev(`return [].slice.call(document.querySelectorAll('button[aria-haspopup=listbox]')).filter(function(b){return b.getClientRects().length&&b.id&&/^Select One$/.test(b.innerText.trim())}).map(function(b){var f=b.closest('[data-automation-id^="formField"]'); return [b.id, (((f&&f.querySelector('label,legend'))||{}).innerText||b.getAttribute('aria-label')||'') + ' ' + (f?f.innerText.slice(0,500):'')]})`)) as [string, string][];
  for (const [id, lab] of btns) {
    const rule = QA.find(([q]) => q.test(lab));
    log(rule ? await listbox(id, rule[1]) : `no rule: ${lab.slice(0, 90)}`);
  }
  // Disability self-ID: "No" box + today's date. The Name box is his signature, so the blanks check stops there.
  await ev(`[].slice.call(document.querySelectorAll('input[type=checkbox]')).forEach(function(c){var l=((c.labels&&c.labels[0])||c.parentElement).innerText||''; if(/^No, I do(n't| not) (have|wish)|acknowledge|read and consent to the terms/i.test(l.trim())&&!c.checked) fire(c)}); return 1;`);
  if (await ev(`return !!document.querySelector('[id*=dateSignedOn][id$=dateSectionMonth-input]')`)) {
    const d = new Date();
    for (const [k, v] of [['Month', d.getMonth() + 1], ['Day', d.getDate()], ['Year', d.getFullYear()]] as const)
      await ev(`var i=document.querySelector('[id*=dateSignedOn][id$=dateSection'+arg.k+'-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,String(arg.v)); i.dispatchEvent(new Event('input',{bubbles:true})); return 1;`, { k, v });
    log('signed-on date committed', await commitDates());
  }
}

// ---------- pages ----------
async function myInformation() {
  execFileSync('node', [fill, match, ...(intern ? ['--intern'] : [])], { stdio: 'ignore' });
  log('prior-employee', await radio('prior employee|previously (worked|been employed)|currently working or have you previously|ever worked for', 'No'));
  log(await listbox('address--countryRegion', /^California$/));
  const hasLine2 = await ev(`return !!document.querySelector('[id$="address--addressLine2"]')`);
  log(await setText(hasLine2 ? 'address--addressLine1' : 'address--addressLine1', hasLine2 ? contact.address_line1 : `${contact.address_line1}, ${contact.address_line2}`));
  if (hasLine2) log(await setText('address--addressLine2', contact.address_line2));
  const dev = await ev(`var b=document.querySelector('button[id$="phoneNumber--phoneType"]'); return b?b.innerText.trim():''`);
  if (dev && !/Mobile|Cell/i.test(String(dev))) log(await listbox('phoneNumber--phoneType', [/^Mobile/, /^Cell/]));
  // phone code: keep the +1 chip, clear any stray search text
  await ev(`var f=[].slice.call(document.querySelectorAll('[data-automation-id^="formField"]')).filter(function(f){var l=f.querySelector(':scope > label'); return l&&/Phone Code/.test(l.innerText)})[0]; if(!f) return 0; var i=f.querySelector('input'); if(i&&i.value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true}))} return 1;`);
  const code = await ev(`var f=[].slice.call(document.querySelectorAll('[data-automation-id^="formField"]')).filter(function(f){var l=f.querySelector(':scope > label'); return l&&/Phone Code/.test(l.innerText)})[0]; return f?[].slice.call(f.querySelectorAll('[data-automation-id=selectedItem]')).map(function(x){return x.innerText}).join(','):'n/a'`);
  if (!/\+1/.test(String(code)) && code !== 'n/a') {
    await ev(`var f=[].slice.call(document.querySelectorAll('[data-automation-id^="formField"]')).filter(function(f){var l=f.querySelector(':scope > label'); return l&&/Phone Code/.test(l.innerText)})[0]; f.querySelector('input').setAttribute('data-af-pc','1'); return 1;`);
    await openPrompt('[data-af-pc="1"]'); log('phone code', await lbPick('United States of America (+1)', 60));
  }
  // how did you hear: some tenants use a single-select button (source--source), not a prompt
  const heardBtn = await ev(`var b=document.querySelector('button[id$="source--source"]'); return b?b.innerText.trim():''`);
  if (heardBtn) { if (/^Select One$/i.test(String(heardBtn))) log(await listbox('source--source', HEARD)); return; }
  const heardChip = await ev(`var f=[].slice.call(document.querySelectorAll('[data-automation-id^="formField"]')).filter(function(f){var l=f.querySelector(':scope > label'); return l&&/How Did You Hear/i.test(l.innerText)})[0]; if(!f) return 'n/a'; var i=f.querySelector('input'); if(!i) return 'n/a'; i.setAttribute('data-af-hh','1'); return [].slice.call(f.querySelectorAll('[data-automation-id=selectedItem]')).map(function(x){return x.innerText}).join(',');`);
  if (heardChip === '') {
    for (let depth = 0; depth < 3; depth++) {
      if (depth === 0) await openPrompt('[data-af-hh="1"]');
      const opts = await lbAll();
      const pick = HEARD.map((re) => opts.find((o) => re.test(o))).find(Boolean) || opts[0];
      log('how-heard level', depth, JSON.stringify(opts.slice(0, 12)), '->', pick);
      if (!pick || !(await lbPick(pick))) break;
      const chip = await ev(`var f=document.querySelector('[data-af-hh="1"]').closest('[data-automation-id^="formField"]'); return [].slice.call(f.querySelectorAll('[data-automation-id=selectedItem]')).map(function(x){return x.innerText}).join(',');`);
      if (chip) { log('how-heard =', chip); break; }
    }
  }
}

async function myExperience() {
  // résumé
  const hasFile = await ev(`return /Successfully Uploaded|\\.pdf/i.test((document.querySelector('[data-automation-id*=attachments],[data-automation-id*=resume]')||document.body).innerText)`);
  const already = await ev(`return [].slice.call(document.querySelectorAll('[data-automation-id=delete-file]')).length`);
  if (!already) {
    await ev(`var f=document.querySelector('input[type=file]'); if(f) f.setAttribute('data-af-file','1'); return !!f;`);
    await p.setInputFiles('[data-af-file="1"]', resume).catch(() => {});
    await sleep(4000);
  }
  log('résumé files', await ev(`return [].slice.call(document.querySelectorAll('[data-automation-id=delete-file]')).map(function(b){return b.getAttribute('aria-label')}).join(' | ')`), hasFile ? '' : '');
  // work experience: Workday may have parsed the résumé into blocks; overwrite block i with job i
  for (let i = 0; i < JOBS.length; i++) {
    const n = Number(await ev(`return document.querySelectorAll('input[id$="--jobTitle"]').length`));
    if (n <= i) {
      const added = await addIn('Work (Experience|History)');
      await sleep(900);
      if (!added) { log('cannot add work block'); break; }
    }
    const j = JOBS[i];
    const pre = String(await ev(`return document.querySelectorAll('input[id$="--jobTitle"]')[arg].id.replace('--jobTitle','')`, i));
    await setText(pre + '--jobTitle', j.t); await setText(pre + '--companyName', j.c); await setText(pre + '--location', j.l);
    await ev(`var cb=document.getElementById(arg.pre+'--currentlyWorkHere'); if(cb&&cb.checked!==arg.cur) fire(cb); return 1;`, { pre, cur: j.cur });
    await sleep(300);
    await setText(pre + '--startDate-dateSectionMonth-input', j.sm); await setText(pre + '--startDate-dateSectionYear-input', j.sy);
    if (!j.cur) { await setText(pre + '--endDate-dateSectionMonth-input', j.em!); await setText(pre + '--endDate-dateSectionYear-input', j.ey!); }
    await setText(pre + '--roleDescription', j.d);
    if (await crashed()) throw new Error('Workday crashed on work block ' + (i + 1));
  }
  // drop extra parsed blocks beyond 4
  // ponytail: extra parsed blocks are reported, not deleted; delete is irreversible-ish and rare.
  const extra = Number(await ev(`return document.querySelectorAll('input[id$="--jobTitle"]').length`)) - JOBS.length;
  if (extra > 0) log('WARNING extra work blocks:', extra);
  log('dates committed', await commitDates());
  // education
  for (let i = 0; i < EDU.length; i++) {
    const n = Number(await ev(`return document.querySelectorAll('[id$="--schoolName"],[id$="--school"]').length`));
    if (n <= i) {
      await addIn('Education');
      await sleep(1000);
    }
    const e = EDU[i];
    const pre = String(await ev(`var x=document.querySelectorAll('[id$="--schoolName"],[id$="--school"]')[arg]; return x?x.id.replace(/--school(Name)?$/,''):''`, i));
    if (!pre) { log('no education block', i); continue; }
    const schoolIsText = await ev(`var x=document.getElementById(arg+'--schoolName'); return !!x && x.tagName==='INPUT' && !x.closest('[data-automation-id=multiSelectContainer]')`, pre);
    if (schoolIsText) await setText(pre + '--schoolName', e.school);
    else {
      // Searchable school prompt: type, press Enter, pick the closest option.
      const sel = `[id="${pre}--school"], [id="${pre}--schoolName"]`;
      await ev(`var i=document.querySelector(arg.sel); fire(i); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,arg.q); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true})); return 1;`, { sel, q: i === 0 ? 'Northeastern University' : 'ICFAI' });
      await sleep(2000);
      let opts = await lbAll();
      // Some tenants ignore the synthetic Enter and show "No Items." (Visa 2026-10-27): retype with real keys.
      if (!opts.some((o) => /Northeastern|ICFAI/i.test(o))) {
        front(); await ev(`var i=document.querySelector(arg); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})); i.focus(); return 1;`, sel);
        execFileSync('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(i === 0 ? 'Northeastern University' : 'ICFAI')}`, '-e', 'delay 0.2', '-e', 'tell application "System Events" to key code 36']);
        await sleep(2500);
        opts = await lbAll();
      }
      const want = i === 0 ? opts.find((o) => /^Northeastern University( - Boston|, Boston|$)/i.test(o)) || opts.find((o) => /^Northeastern University/i.test(o) && !/东北|China|Shenyang/i.test(o)) : opts.find((o) => /ICFAI.*(Higher Education|Hyderabad)/i.test(o)) || opts.find((o) => /^Other/i.test(o));
      log('school opts', JSON.stringify(opts.slice(0, 10)), '->', want);
      if (want) await lbPick(want);
    }
    log(await listbox(pre + '--degree', e.degree));
    const fos = await ev(`return !!document.getElementById(arg+'--fieldOfStudy')`, pre);
    const fosSet = fos && await ev(`return /[1-9] items? selected/.test(document.getElementById(arg+'--fieldOfStudy').closest('[data-automation-id^=formField]').innerText)`, pre);
    if (fos && !fosSet) {
      // Type-to-search first: scrolling the 1000+ virtualized list took minutes
      // (Danaher 2026-10-26). Scroll only if the search finds nothing.
      const fsel = `[id="${pre}--fieldOfStudy"]`;
      await ev(`var i=document.querySelector(arg.sel); fire(i); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,arg.q); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true})); return 1;`, { sel: fsel, q: e.fieldQuery });
      await sleep(1500);
      let picked = (await lbOpts()).find((o) => e.field.test(o)) || '';
      if (picked) await lbPick(picked, 1);
      else {
        await openPrompt(fsel);
        const top = await lbOpts();
        if (top.includes('All')) { await lbPick('All'); await sleep(1200); }
      }
      let last = '', same = 0;
      for (let s = 0; s < 400 && !picked; s++) {
        const opts = await lbOpts();
        picked = opts.find((o) => e.field.test(o)) || '';
        if (picked) { await lbPick(picked, 1); break; }
        // End of list: the window stopped moving, so the field isn't offered. Leave it for him.
        const key = opts.join('|');
        if (key === last && ++same >= 3) break;
        if (key !== last) { last = key; same = 0; }
        await ev(`var lb=[].slice.call(document.querySelectorAll('[role=listbox]')).filter(function(x){return x.getClientRects().length&&x.querySelector('[aria-setsize]')}).pop(); if(lb){lb.scrollTop+=300; lb.dispatchEvent(new Event('scroll'))} return 1;`);
        await sleep(110);
      }
      log('field of study', picked || 'NOT FOUND');
    }
    if (e.gpa) await setText(pre + '--gradeAverage', e.gpa);
    // optional dates on some tenants
    if (await ev(`return !!document.getElementById(arg+'--lastYearAttended-dateSectionYear-input')`, pre)) await setText(pre + '--lastYearAttended-dateSectionYear-input', e.ey);
    if (await ev(`return !!document.getElementById(arg+'--firstYearAttended-dateSectionYear-input')`, pre)) await setText(pre + '--firstYearAttended-dateSectionYear-input', i === 0 ? '2025' : '2020');
  }
  log('dates committed', await commitDates());
  await ev(`var i=document.querySelector('[id$="linkedInAccount"]'); if(i&&!i.value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'https://www.linkedin.com/in/vineeth-sakhamuru/'); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true}))} return 1;`);
}

// ---------- loop ----------
for (let guard = 0; guard < 12; guard++) {
  const s = await step();
  log('step:', s);
  if (await crashed()) { log('STOP: Workday "Something went wrong" (session?)'); break; }
  if (s === 'Sign In' || /Create Account/i.test(s)) { log('STOP: not signed in'); break; }
  if (/^Review$/i.test(s)) { log('STOP at Review. Submit is his click.'); break; }
  if (/My Information/i.test(s)) await myInformation();
  else if (/My Experience/i.test(s)) await myExperience();
  else {
    execFileSync('node', [fill, match, ...(intern ? ['--intern'] : [])], { stdio: 'ignore' });
    await answerQuestions();
    // required unanswered on question/disclosure pages => stop for a human/LLM pass
    const blanks = await ev(`return [].slice.call(document.querySelectorAll('[data-automation-id^="formField"],fieldset')).filter(function(f){if(!f.getClientRects().length) return false; var req=/\\*/.test((f.querySelector('label,legend')||{}).innerText||''); if(!req) return false; var b=f.querySelector('button[aria-haspopup]'); if(b&&/^Select One$/.test(b.innerText.trim())) return true; var rs=f.querySelectorAll('input[type=radio]'); if(rs.length&&![].some.call(rs,function(r){return r.checked})) return true; var cb=f.querySelectorAll('input[type=checkbox]'); if(cb.length===1&&!cb[0].checked) return true; var t=f.querySelector('input[type=text],textarea'); if(t&&!t.value&&!f.querySelector('[data-automation-id=selectedItem]')) return true; return false}).map(function(f){return ((f.querySelector('label,legend')||{}).innerText||'').replace(/\\s+/g,' ').slice(0,140)});`);
    if ((blanks as string[]).length) { log('STOP: unanswered on', s, JSON.stringify(blanks, null, 1)); break; }
  }
  const errs = await errors();
  if (errs.length) log('errors before save:', JSON.stringify(errs));
  if (!(await saveContinue())) { log('STOP: Save did not advance on', s, JSON.stringify(await errors())); break; }
}
log('done', ((Date.now() - t0) / 1000).toFixed(0) + 's');
