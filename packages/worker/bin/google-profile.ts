/**
 * Bring the Google Careers profile to the answer bible, in his Chrome, and stop
 * right before "Submit profile & continue" (that save is his click).
 * Order follows docs/google-careers-sop.md: résumé first (Google re-parses it and
 * rewrites work history), then repair every job block, then the degree.
 *
 * Usage: node packages/worker/bin/google-profile.ts <resume.pdf>
 */
import { chromePage } from '../src/chrome.ts';
import { fillField } from '../src/engine.ts';

const resume = process.argv[2];
const t0 = Date.now();
const p = await chromePage('careers/applications');
const T = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const press = (sel: string, text: string, last = false) =>
  p.evaluate(({ sel, text, last }: any) => {
    const r = new RegExp(text, 'i');
    const els = [...document.querySelectorAll(sel)].filter(
      (e: any) => e.getClientRects().length && r.test(((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).trim()),
    ) as any[];
    const b = last ? els[els.length - 1] : els[0];
    if (!b) return false;
    const q = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, button: 0, clientX: q.x + 4, clientY: q.y + 4 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      b.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
    return true;
  }, { sel, text, last });
const until = async (fn: () => Promise<boolean>, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await p.waitForTimeout(200)) if (await fn()) return true;
  return false;
};
const editorOpen = () => p.evaluate(() => [...document.querySelectorAll('input')].some((i: any) => i.getClientRects().length && /Employer name/.test(i.getAttribute('aria-label') || i.labels?.[0]?.innerText || '')));

// 1. Open the profile editor (from review or the profile summary).
if (!(await editorOpen())) {
  // Review page: "Edit Careers profile" → the read-only summary at /form.
  if (!/\/form$/.test(await p.evaluate(() => location.pathname))) {
    await press('button', 'Edit Careers profile');
    await until(() => p.evaluate(() => /\/form$/.test(location.pathname)));
    await p.waitForTimeout(1200);
  }
  // Summary → editor: the first plain "Edit" button.
  await press('button', 'Edit profile');
  if (!(await until(editorOpen))) throw new Error('profile editor did not open');
}
console.log(`editor open ${T()}`);

// 2. Résumé. Google builds the file input on "My computer" and opens the OS
// dialog from its own JS, so a main-world hook captures the input instead.
if (resume) {
  await p.evaluate(() => {
    if (document.documentElement.hasAttribute('data-af-hook-installed')) return;
    const n = document.querySelector('script[nonce]') as any;
    const s = document.createElement('script');
    s.nonce = n ? n.nonce : '';
    const code = `(function(){var o=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type==="file"){this.setAttribute("data-af-pending","1");if(!this.isConnected){this.style.display="none";document.body.appendChild(this);}return;}return o.apply(this,arguments);};document.documentElement.setAttribute("data-af-hook-installed","1");})();`;
    const tt = (window as any).trustedTypes?.createPolicy('af' + Date.now(), { createScript: (x: string) => x });
    (s as any).textContent = tt ? tt.createScript(code) : code;
    document.documentElement.appendChild(s);
    s.remove();
  });
  const name = resume.split('/').pop()!;
  const has = () => p.evaluate((n: string) => document.body.innerText.includes(n), name);
  if (!(await has())) {
    await press('button', 'Remove resume');
    await p.waitForTimeout(500);
    await press('button', 'Upload résumé, PDF');
    await p.waitForTimeout(400);
    await press('[role=menuitem]', '^My computer$');
    await p.waitForTimeout(500);
    await p.setInputFiles('input[type=file][data-af-pending="1"]', resume);
    if (!(await until(has))) throw new Error('résumé did not attach');
    // The upload re-parses and re-renders work history; let it land.
    await p.waitForTimeout(2500);
  }
  console.log(`résumé ${name} ${T()}`);
}

// 3. Work history. Each block is re-found before every edit, because changing a
// country re-renders the block and drops any handle.
type Job = { match: RegExp; emp: string; title: string; m0: string; y0: string; m1?: string; y1?: string; country: string; city: string; state: string };
const JOBS: Job[] = [
  { match: /6120|teaching|northeastern/i, emp: 'Northeastern University', title: 'Graduate Teaching Assistant', m0: 'September', y0: '2026', country: 'United States', city: 'San Jose', state: 'California' },
  { match: /evenness|saraswat|agentic|co-?op/i, emp: 'Evenness', title: 'Software Engineer, Co-op (Agentic AI)', m0: 'May', y0: '2026', m1: 'September', y1: '2026', country: 'United States', city: 'San Jose', state: 'California' },
  { match: /osi/i, emp: 'OSI Digital Pvt. Ltd.', title: 'Machine Learning Engineer Intern', m0: 'January', y0: '2024', m1: 'June', y1: '2024', country: 'India', city: 'Hyderabad', state: 'Telangana' },
  { match: /tech mahindra/i, emp: 'Tech Mahindra', title: 'Software Engineering Intern', m0: 'June', y0: '2023', m1: 'August', y1: '2023', country: 'India', city: 'Hyderabad', state: 'Telangana' },
];

// Tag control `k` (nth match of `what`) in block i as data-af-id="tgt"; for a
// combobox also return its own options.
const target = (i: number, what: string, kind: 'input' | 'cb', nth = 0) =>
  p.evaluate(({ i, what, kind, nth }: any) => {
    const vis = (e: any) => e.getClientRects().length;
    const lab = (x: any) => x.getAttribute('aria-label') || x.labels?.[0]?.innerText || '';
    document.querySelectorAll('[data-af-id="tgt"]').forEach((e) => e.removeAttribute('data-af-id'));
    const emp = [...document.querySelectorAll('input')].filter((x: any) => vis(x) && /Employer name/.test(lab(x)));
    let b: any = emp[i]?.parentElement;
    while (b && !(b.innerText || '').includes('This is your current job')) b = b.parentElement;
    if (!b) return null;
    const re = new RegExp(what);
    if (kind === 'input') {
      const el = [...b.querySelectorAll('input')].filter((x: any) => vis(x) && re.test(lab(x)))[nth] as any;
      if (!el) return null;
      el.setAttribute('data-af-id', 'tgt');
      return { value: el.type === 'checkbox' ? String(el.checked) : el.value, options: [] as string[] };
    }
    const c = [...b.querySelectorAll('[role=combobox]')].filter((x: any) => vis(x) && re.test((x.innerText || '').replace(/\s+/g, ' ').trim()))[nth] as any;
    if (!c) return null;
    c.setAttribute('data-af-id', 'tgt');
    let lb: any = null;
    for (let q = c.parentElement, k = 0; !lb && q && k < 4; q = q.parentElement, k++)
      lb = [...q.querySelectorAll('[role=listbox]')].find((l: any) => l.querySelector('[role=option]'));
    return {
      value: (c.innerText || '').replace(/\s+/g, ' ').trim(),
      options: lb ? [...lb.querySelectorAll('[role=option]')].map((o: any) => (o.innerText || o.textContent || '').split('\n')[0].trim()).filter(Boolean) : [],
    };
  }, { i, what, kind, nth });

const setText = async (i: number, what: string, v: string, nth = 0) => {
  const t = await target(i, what, 'input', nth);
  if (!t) return 'no field';
  if (t.value === v) return 'ok';
  return (await p.evaluate((v: string) => {
    const el = document.querySelector('[data-af-id="tgt"]') as any;
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    el.blur();
    return el.value === v;
  }, v)) ? 'set' : 'FAILED';
};
const pick = async (i: number, what: string, v: string, nth = 0) => {
  const t = await target(i, what, 'cb', nth);
  if (!t) return 'no combobox';
  if (t.value.endsWith(v)) return 'ok';
  return (await fillField(p as any, { kind: 'listbox', label: what, selector: '[data-af-id="tgt"]', required: true, options: t.options }, v)) ? 'set' : 'FAILED';
};
const setCurrent = async (i: number, on: boolean) => {
  const t = await target(i, 'current job', 'input');
  if (!t) return 'no box';
  if (t.value === String(on)) return 'ok';
  await p.evaluate(() => (document.querySelector('[data-af-id="tgt"]') as any).click());
  await p.waitForTimeout(300);
  return 'set';
};

const employers: string[] = await p.evaluate(() =>
  [...document.querySelectorAll('input')]
    .filter((x: any) => x.getClientRects().length && /Employer name/.test(x.getAttribute('aria-label') || x.labels?.[0]?.innerText || ''))
    .map((x: any) => {
      let b = x.parentElement;
      while (b && !(b.innerText || '').includes('This is your current job')) b = b.parentElement;
      return x.value + ' ' + [...(b?.querySelectorAll('input') ?? [])].map((y: any) => y.value).join(' ');
    }),
);
const problems: string[] = [];
const used = new Set<number>();
// Match blocks by employer first. The re-parse sometimes renames a job outright
// (Evenness came back as "The University of Tokyo" on 2026-10-16), so any job
// still unmatched takes the next leftover block and gets fully rewritten.
const slot = JOBS.map((job) => { const i = employers.findIndex((e, k) => !used.has(k) && job.match.test(e)); if (i >= 0) used.add(i); return i; });
slot.forEach((i, j) => { if (i < 0) { const k = employers.findIndex((_, k) => !used.has(k)); if (k >= 0) { used.add(k); slot[j] = k; } } });
for (const [j, job] of JOBS.entries()) {
  const i = slot[j];
  if (i < 0) { problems.push(`no block for ${job.emp}`); continue; }
  const r: Record<string, string> = {};
  r.emp = await setText(i, 'Employer name', job.emp);
  r.title = await setText(i, 'Job title', job.title);
  r.cur = await setCurrent(i, !job.m1);
  r.m0 = await pick(i, '^Month', job.m0, 0);
  r.y0 = await setText(i, '^Year', job.y0, 0);
  if (job.m1) { r.m1 = await pick(i, '^Month', job.m1, 1); r.y1 = await setText(i, '^Year', job.y1!, 1); }
  r.country = await pick(i, '^Country', job.country);
  await p.waitForTimeout(300);
  r.city = await setText(i, '^City', job.city);
  r.state = job.country === 'United States' ? await pick(i, '^State', job.state) : await setText(i, '^State', job.state);
  const bad = Object.entries(r).filter(([, v]) => !/^(ok|set)$/.test(v));
  if (bad.length) problems.push(`${job.emp}: ${bad.map(([k, v]) => `${k}=${v}`).join(', ')}`);
}
for (let k = 0; k < employers.length; k++) if (!used.has(k)) problems.push(`extra job block: "${employers[k].slice(0, 40)}" (left alone)`);
console.log(`work history ${T()}`);

// 4. Bachelor's degree type (the re-parse clears it).
const deg = await p.evaluate(() => {
  document.querySelectorAll('[data-af-id="tgt"]').forEach((e) => e.removeAttribute('data-af-id'));
  const school = [...document.querySelectorAll('input')].find((x: any) => x.getClientRects().length && /ICFAI/.test(x.value)) as any;
  let b = school?.parentElement;
  while (b && ![...b.querySelectorAll('[role=combobox]')].some((c: any) => /^Degree(?! Status)/.test((c.innerText || '').trim()))) b = b.parentElement;
  const c = b && ([...b.querySelectorAll('[role=combobox]')].find((c: any) => /^Degree(?! Status)/.test((c.innerText || '').trim())) as any);
  if (!c) return null;
  c.setAttribute('data-af-id', 'tgt');
  let lb: any = null;
  for (let q = c.parentElement, k = 0; !lb && q && k < 4; q = q.parentElement, k++) lb = [...q.querySelectorAll('[role=listbox]')].find((l: any) => l.querySelector('[role=option]'));
  return { now: (c.innerText || '').replace(/\s+/g, ' ').trim(), options: [...(lb?.querySelectorAll('[role=option]') ?? [])].map((o: any) => (o.innerText || '').split('\n')[0].trim()).filter(Boolean) };
});
if (!deg) problems.push('bachelor degree field not found');
else if (!deg.now.endsWith('Bachelor of Science') &&
  !(await fillField(p as any, { kind: 'listbox', label: 'Degree', selector: '[data-af-id="tgt"]', required: true, options: deg.options }, 'Bachelor of Science')))
  problems.push('bachelor degree FAILED');

// 5. Read back the claims that matter.
const check = await p.evaluate(() => {
  const chips = [...document.querySelectorAll('button[aria-label^="Remove "]')].map((b: any) => b.getAttribute('aria-label').slice(7));
  const jobs = [...document.querySelectorAll('input')]
    .filter((x: any) => x.getClientRects().length && /Employer name|Job title/.test(x.getAttribute('aria-label') || x.labels?.[0]?.innerText || ''))
    .map((x: any) => x.value);
  return {
    banned: chips.filter((c) => /^(Java|JavaScript|TypeScript|React|C\+\+|C)$/.test(c)),
    jobs,
    transcript: /Transcript[\s\S]{0,80}\.pdf/i.test(document.body.innerText),
    save: [...document.querySelectorAll('button')].some((b: any) => b.getClientRects().length && /Submit profile/.test(b.innerText)),
  };
});
if (check.banned.length) problems.push(`skills still claim: ${check.banned.join(', ')}`);
if (!check.transcript) problems.push('no transcript attached (Google requires one for intern roles)');
console.log(`\njobs: ${check.jobs.join(' | ')}`);
console.log(problems.length ? `\nNEEDS YOU:\n- ${problems.join('\n- ')}` : '\nprofile matches the bible');
console.log(`\n${T()} total. Stopped before "Submit profile & continue" (his click).`);
