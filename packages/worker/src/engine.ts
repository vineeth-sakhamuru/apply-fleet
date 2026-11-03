import type { Page } from 'patchright';
import type { FieldSpec, HitlItem } from './types.ts';
import { DECLINE, ALL } from './resolver.ts';
import { axScanForm } from './ax.ts';
import { visionScanForm, type VisionScanOptions } from './vision.ts';

/**
 * Discover every fillable control on the page, with a human label, a stable
 * selector, and (for select/radio) its options. Radios are collapsed to one
 * spec per group. Runs in-page and returns serializable data.
 */
export async function scanForm(page: Page): Promise<FieldSpec[]> {
  return (await page.evaluate(() => {
    const labelFor = (el: any): string => {
      if (el.labels && el.labels.length) return (el.labels[0].textContent || '').trim();
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const n = document.getElementById(by);
        if (n) return (n.textContent || '').trim();
      }
      if (el.placeholder) return el.placeholder.trim();
      return (el.name || '').trim();
    };
    const sel = (el: any): string => {
      if (el.id) return '#' + (window as any).CSS.escape(el.id);
      if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      return '';
    };
    const clean0 = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
    // Lever renders each custom question as a `.application-question` card whose
    // human question lives in `.application-label .text` (with a trailing required
    // ✱). The per-input label is only the option ("Yes"), so for the field/group
    // label we read the card question and strip the ✱ + any dynamic status noise.
    const cardLabel = (el: any): string => {
      // Lever: question text lives in the card's .application-label .text.
      const card = el.closest('.application-question');
      if (card) {
        const t = card.querySelector('.application-label .text') || card.querySelector('.application-label');
        if (t) return clean0(t.textContent || '').replace(/[✱*]+\s*$/, '').trim();
      }
      // Ashby: the real question label lives in the field-entry container, not on
      // the input — otherwise labelFor falls to the placeholder ("Pick date…",
      // "Start typing…") and the resolver can't recognize the field.
      const entry = el.closest('.ashby-application-form-field-entry, [class*="_fieldEntry"]');
      if (entry) {
        const q = entry.querySelector('label, [class*="label"], .ashby-application-form-question-title');
        if (q) return clean0(q.textContent || '').replace(/[✱*]+\s*$/, '').trim();
      }
      return '';
    };
    const cardRequired = (el: any): boolean => {
      const card = el.closest('.application-question');
      return !!card && !!card.querySelector('.required');
    };
    /**
     * Required-ness as the HUMAN sees it: the asterisk in the label.
     *
     * Ashby marks required fields ONLY in the label markup ("Resume*"), never
     * with `required` or `aria-required` on the input. Trusting the attributes
     * alone made a form with an empty required combobox look complete, the
     * pre-submit gate passed it, and the click bounced off Ashby's own
     * validation — a real application that reported 'ready' and could never be
     * filed. If it's starred, it's required.
     */
    const labelRequired = (el: any): boolean => {
      const entry = el.closest(
        '.ashby-application-form-field-entry, [class*="_fieldEntry"], .application-question',
      );
      if (!entry) return false;
      if (entry.querySelector('.required, [class*="required" i], [aria-label*="required" i]')) return true;
      const q = entry.querySelector('label, [class*="label"], .ashby-application-form-question-title');
      // Only the label's own asterisk counts — a `*` anywhere in the card would
      // match footnotes and legends ("* indicates a required field").
      return !!q && /[✱*]/.test(clean0(q.textContent || ''));
    };

    /**
     * The question text for a widget with no <label>/<legend>/card: the nearest
     * ancestor text that isn't one of its own options, preferring a line that
     * ends in "?" or the required "*". Google Careers (Material) renders every
     * question this way, so without it radios scanned as their `name`
     * ("WorkAuthSponsorQuestion") and the resolver could not answer them.
     */
    // Only text BEFORE the widget counts: two questions often share an
    // ancestor, and the whole-ancestor text gave the eligibility radios the
    // sponsorship question's label.
    const ctxLabel = (start: any, opts: string[]): string => {
      const skip = new Set(opts.map(clean0).filter(Boolean));
      let n = start;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        // previousSibling, not previousElementSibling: Google puts the question
        // in a bare text node ("Please indicate your race...*") beside the list.
        for (let sib: any = n.previousSibling; sib; sib = sib.previousSibling) {
          const raw = sib.nodeType === 3 ? sib.textContent : sib.nodeType === 1 ? sib.innerText : '';
          const lines = (raw || '').split('\n').map(clean0).filter((s: string) => s && !skip.has(s));
          if (lines.length) {
            const q = [...lines].reverse().find((s: string) => /[?*]$/.test(s));
            return (q || lines[lines.length - 1]).slice(0, 300);
          }
        }
      }
      return '';
    };
    // Stable handle for selector-less widgets, reused across scans.
    let afN = Math.max(0, ...[...document.querySelectorAll('[data-af-id]')].map((e: any) => +e.dataset.afId || 0));
    const afSel = (e: any): string => {
      if (!e.dataset.afId) e.dataset.afId = String(++afN);
      return `[data-af-id="${e.dataset.afId}"]`;
    };

    const out: any[] = [];
    const seenRadio = new Set<string>();
    const seenCbGroup = new Set<string>();
    const nodes = [...document.querySelectorAll('input,select,textarea')];

    for (const el of nodes as any[]) {
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      if (tag === 'input' && ['hidden', 'submit', 'button', 'reset'].includes(type))
        continue;
      if (/captcha/i.test(el.name || el.id || '')) continue; // bot-check, not a real field
      // SPA wizards keep earlier steps mounted but hidden (Google Careers), so
      // their fields were scanned and re-filled on every later step. File
      // inputs are exempt: ATSes routinely hide the real one behind a button.
      const shown = (e: any) => !!e && e.getClientRects().length > 0;
      if (type !== 'file' && !shown(el) && !shown(el.parentElement) && !shown(el.labels?.[0])) continue;
      // react-select mounts an aria-hidden proxy input inside each field so the
      // browser's native required-validation fires. It has no label, can't be
      // typed into, and sits in the same starred entry as the real control — so
      // it was scanned as a second REQUIRED field that could never be filled,
      // and it held five Greenhouse applications at needs_you on its own.
      if (el.getAttribute('aria-hidden') === 'true') continue;
      const required =
        el.required || el.getAttribute('aria-required') === 'true' || labelRequired(el);

      if (tag === 'select') {
        out.push({
          kind: 'select',
          label: cardLabel(el) || labelFor(el),
          name: el.name,
          selector: sel(el),
          required,
          options: [...el.options].map((o: any) => (o.textContent || '').trim()),
        });
      } else if (tag === 'textarea') {
        out.push({ kind: 'textarea', label: cardLabel(el) || labelFor(el), name: el.name, selector: sel(el), required });
      } else if (type === 'radio') {
        if (seenRadio.has(el.name)) continue;
        seenRadio.add(el.name);
        const group = [
          ...document.querySelectorAll(`input[type="radio"][name="${el.name}"]`),
        ];
        let groupLabel = el.name;
        const fs = el.closest('fieldset');
        const lg = fs && fs.querySelector('legend');
        // Eightfold wraps a whole SECTION of radio questions in one fieldset, so
        // its legend ("Position Specific Questions") names no single question.
        // A legend shared by several radio groups is a heading: use the prose
        // just above this group instead.
        const sharedLegend =
          lg && [...fs.querySelectorAll('input[type="radio"]')].some((r: any) => r.name !== el.name);
        if (sharedLegend) {
          const c = ctxLabel(el.closest('[role="radiogroup"]') || el.parentElement?.parentElement || el, group.map((r: any) => labelFor(r) || r.value));
          if (c) groupLabel = c;
        } else if (lg) groupLabel = (lg.textContent || '').trim();
        else {
          const cl = cardLabel(el);
          if (cl) groupLabel = cl;
          // Ashby nests a consent radio group INSIDE another field's entry (the
          // SMS opt-in sits under Phone), so cardLabel hands back "Phone" — the
          // resolver then sees a phone question with Yes/No options and can't
          // answer it. The group's real question is the prose above the options;
          // prefer the longest such line over the borrowed field label.
          const entry = el.closest('.ashby-application-form-field-entry, [class*="_fieldEntry"]');
          const optionText = new Set(group.map((r: any) => clean0(labelFor(r) || r.value)));
          if (entry) {
            const lines = (entry.innerText || '')
              .split(/(?<=[.?])\s+|\n+/)
              .map((s: string) => clean0(s))
              .filter(
                (s: string) =>
                  s.length > 24 &&
                  s !== cl &&
                  !/^https?:/.test(s) &&
                  // Drop anything that swallowed the option text or the boilerplate
                  // legal footer — neither is the question being asked.
                  ![...optionText].some((o) => o.length > 2 && s.includes(o)) &&
                  !/^(view our|privacy policy|terms and conditions|message and data rates|frequency may vary)/i.test(s),
              );
            // The prose ABOVE the options is the question; take the first such
            // line rather than the longest, or the legal footer wins.
            if (lines[0]) groupLabel = lines[0].slice(0, 300);
          }
        }
        // Google regenerates radio `name`s on every re-render, so a name
        // selector goes stale after the first click on the page. The group's
        // aria-label survives, so key on that when there is one.
        const rg = el.closest('[role="radiogroup"]');
        const rgLabel = rg ? clean0(rg.getAttribute('aria-label') || '') : '';
        let starred = /\*$/.test(groupLabel);
        if (groupLabel === el.name) {
          const c = ctxLabel(rg || el, group.map((r: any) => labelFor(r) || r.value));
          // Keep the group's aria-label beside the visible text: Google's
          // veteran question reads only "Select one of the options below*",
          // and "Veteran status radio input" is what says what it asks.
          groupLabel = [c, rgLabel && rgLabel !== c ? `(${rgLabel})` : ''].filter(Boolean).join(' ') || el.name;
          starred = /\*$/.test(c);
        }
        out.push({
          kind: 'radio',
          label: groupLabel,
          name: el.name,
          selector: rgLabel
            ? `[role="radiogroup"][aria-label="${rgLabel.replace(/"/g, '\\"')}"] input[type="radio"]`
            : `input[type="radio"][name="${el.name}"]`,
          required: required || starred,
          options: group.map((r: any) => labelFor(r) || r.value),
        });
      } else if (type === 'checkbox') {
        // Ashby renders Yes/No as styled <button>s backed by a checkbox. If this
        // checkbox sits in a field-entry with ≥2 option buttons, skip it here —
        // the choice pass below owns that button group.
        const box = el.closest('.ashby-application-form-field-entry, [class*="_fieldEntry"]');
        const btns = box ? [...box.querySelectorAll('button')].filter((b: any) => (b.textContent || '').trim()) : [];
        if (btns.length >= 2) continue;
        // Lever "check all that apply": many checkboxes share ONE name inside a
        // card. Collapse the whole group into a single choice field, else e.g. 30
        // languages would surface as 30 separate "needs you" items.
        const card = el.closest('.application-question');
        if (card && el.name) {
          if (seenCbGroup.has(el.name)) continue;
          const grp = [...document.querySelectorAll(`input[type="checkbox"][name="${el.name}"]`)];
          if (grp.length >= 2) {
            seenCbGroup.add(el.name);
            out.push({
              kind: 'choice',
              label: cardLabel(el) || labelFor(el),
              name: el.name,
              selector: '',
              required: required || cardRequired(el),
              options: grp.map((c: any) => labelFor(c)).filter(Boolean),
            });
            continue;
          }
        }
        // Ashby "check all that apply": each box is named after its OPTION
        // ("Other", "Canada", "U.S."), never after the question, so the
        // group-by-name collapse above cannot see them as one group. Their shared
        // identity is the field-entry container.
        //
        // This mattered: a required "What is your country of residence?" scanned
        // as three independent boolean checkboxes, each got handed the value
        // "United States", and setCheckbox — which tests for yes/true/1/on —
        // treated that as falsy and ensured every box stayed UNCHECKED while
        // reporting success. A required field read as filled and submitted empty.
        if (box) {
          const grp = [...box.querySelectorAll('input[type="checkbox"]')];
          if (grp.length >= 2) {
            const key = cardLabel(el) || labelFor(el);
            if (seenCbGroup.has(key)) continue;
            seenCbGroup.add(key);
            out.push({
              kind: 'choice',
              label: key,
              name: '', // no shared name — clickChoice locates by question label
              selector: '',
              required,
              options: grp.map((c: any) => labelFor(c) || c.name).filter(Boolean),
            });
            continue;
          }
        }
        out.push({ kind: 'checkbox', label: cardLabel(el) || labelFor(el), name: el.name, selector: sel(el), required });
      } else if (type === 'file') {
        // NEVER upload into an ATS's own "autofill from resume" dropzone.
        //
        // Ashby puts one at the top of the form, above the real Resume field, and
        // it is the FIRST file input on the page — which is exactly what the
        // upload fallback selector picks. Feeding it the résumé makes Ashby parse
        // the file and re-render the form with ITS values, wiping the ones we
        // filled. On a live Ramp submit that blanked Phone, LinkedIn and the
        // required country checkbox, and the submit bounced off validation on
        // fields we had answered correctly.
        //
        // We do the filling. This dropzone is not a field we want.
        const zone = el.closest('div, section, fieldset');
        if (/autofill|auto-fill|fill (in )?(key )?(application )?fields|parse (your )?resume/i.test(
          clean0(zone?.textContent || ''),
        )) {
          continue;
        }
        out.push({ kind: 'file', label: cardLabel(el) || labelFor(el), name: el.name, selector: sel(el), required });
      } else {
        const kind = ['email', 'tel', 'url'].includes(type) ? type : 'text';
        out.push({ kind, label: cardLabel(el) || labelFor(el), name: el.name, selector: sel(el), required });
      }
    }

    // Custom (non-native) choice groups. Ashby (and similar) render Yes/No and
    // multi-choice questions as <button>/[role=radio] inside a field-entry
    // container with NO native input — the loop above misses them entirely.
    const clean = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
    const containers = [
      ...document.querySelectorAll(
        '.ashby-application-form-field-entry, [class*="_fieldEntry"], [role="radiogroup"]',
      ),
    ];
    const seenChoice = new Set<string>();
    for (const c of containers as any[]) {
      // Skip only containers with a real text-like native field. A backing
      // checkbox/radio (Ashby's button groups) must NOT disqualify the group.
      if (c.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea')) continue;
      const opts = [...c.querySelectorAll('button, [role="radio"]')] as any[];
      const optTexts = opts.map((o) => clean(o.textContent || '')).filter(Boolean);
      if (optTexts.length < 2) continue; // an "Upload" button etc. is not a choice group
      const labEl = c.querySelector('label, legend');
      const rawLabel = labEl ? labEl.textContent || '' : c.getAttribute('aria-label') || '';
      const label = clean(rawLabel);
      if (!label || seenChoice.has(label)) continue;
      seenChoice.add(label);
      out.push({
        kind: 'choice',
        label,
        selector: '',
        required: /\*/.test(rawLabel) || c.getAttribute('aria-required') === 'true',
        options: optTexts,
      });
    }

    // ARIA dropdowns and multi-select lists with no native control behind them
    // (Google Careers' Material select, its "additional locations" list). The
    // native checkboxes inside their options are aria-hidden, so the loop above
    // never saw these questions at all.
    const optsOf = (lb: any): string[] =>
      [...lb.querySelectorAll('[role="option"]')].map((o: any) => clean((o.innerText || o.textContent || '').split('\n')[0])).filter(Boolean);
    const listboxFor = (cb: any): any => {
      const id = cb.getAttribute('aria-controls') || cb.getAttribute('aria-owns');
      const byId = id ? document.getElementById(id) : null;
      if (byId && byId.querySelector('[role="option"]')) return byId;
      let p = cb.parentElement;
      for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
        const lb = [...p.querySelectorAll('[role="listbox"]')].find((l: any) => l !== cb && l.querySelector('[role="option"]'));
        if (lb) return lb;
      }
      return null;
    };
    const owned = new Set<any>();
    for (const cb of document.querySelectorAll('[role="combobox"]') as any) {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(cb.tagName) || !cb.getClientRects().length) continue;
      const lb = listboxFor(cb);
      if (!lb) continue;
      owned.add(lb);
      const options = optsOf(lb);
      // Material puts the field name inside the control as a floating label
      // ("Degree", "Country"); the text before it is often a validation
      // message for the PREVIOUS field ("Enter a valid last name.").
      const by = cb.getAttribute('aria-labelledby');
      const floating = clean(cb.querySelector('[class*="label"], label')?.textContent || '');
      const label = (by && clean(document.getElementById(by)?.textContent || '')) || floating || ctxLabel(cb, options);
      out.push({
        kind: 'listbox', label, selector: afSel(cb), options,
        required: cb.getAttribute('aria-required') === 'true' || /\*$/.test(label),
      });
    }
    for (const lb of document.querySelectorAll('[role="listbox"][aria-multiselectable="true"]') as any) {
      if (owned.has(lb) || !lb.getClientRects().length) continue;
      const options = optsOf(lb);
      if (!options.length) continue;
      const label = ctxLabel(lb, options);
      out.push({ kind: 'multilistbox', label, selector: afSel(lb), options, required: /\*$/.test(label) });
    }
    return out;
  })) as FieldSpec[];
}

/** Minimum fillable fields for the DOM scan to be trusted. Below this the form
 *  is effectively unreadable by the per-ATS scanner (custom/non-semantic markup)
 *  and we fall back to the vision tier. */
const MIN_DOM_FIELDS = 2;

export interface ScanResult {
  fields: FieldSpec[];
  hitl: HitlItem[];
  source: 'dom' | 'ax' | 'vision' | 'vision-cache' | 'none';
}

/**
 * Scan a form through the reliability ladder: DOM scan → accessibility-tree
 * (ARIA) reader → vision. Each tier only runs when the cheaper one comes up
 * near-empty, and every tier keeps any file input the DOM scan found (résumé
 * upload). This does NOT change scanForm's contract — it's an additive wrapper.
 * On a readable form it returns the DOM scan unchanged (source 'dom') and never
 * reads the AX tree or touches the model. The AX and vision tiers both run on
 * the EMPTY pre-fill page (PII-safe); AX sends nothing to any model.
 */
export async function scanFormWithFallback(
  page: Page,
  opts: VisionScanOptions = {},
): Promise<ScanResult> {
  const fields = await scanForm(page);
  const fillable = fields.filter((f) => f.kind !== 'file');
  if (fillable.length >= MIN_DOM_FIELDS) {
    return { fields, hitl: [], source: 'dom' };
  }
  const domFiles = fields.filter((f) => f.kind === 'file');

  // Middle tier: read the ARIA accessibility tree before the expensive vision
  // tier. Catches custom widgets (role="textbox"/"combobox"/…) with no native
  // control. Empty (or CDP-unavailable) → falls through to vision.
  const ax = await axScanForm(page);
  if (ax.filter((f) => f.kind !== 'file').length >= MIN_DOM_FIELDS) {
    return { fields: [...domFiles, ...ax], hitl: [], source: 'ax' };
  }

  const vision = await visionScanForm(page, opts);
  return { fields: [...domFiles, ...vision.fields], hitl: vision.hitl, source: vision.source };
}

/** Native value setter + input/change/blur — the React-safe fill. */
async function reactFill(page: Page, selector: string, value: string): Promise<void> {
  if (!selector) return; // unlocatable field — never querySelector('') (throws)
  await page.evaluate(
    ({ selector, value }) => {
      const el = document.querySelector(selector) as any;
      if (!el) return;
      const proto =
        el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    },
    { selector, value },
  );
}

async function selectOption(page: Page, field: FieldSpec, value: string): Promise<boolean> {
  if (!field.selector) return false;
  return await page.evaluate(
    ({ selector, value, DECLINE }) => {
      const el = document.querySelector(selector) as any;
      if (!el) return false;
      const opts = [...el.options] as any[];
      const declineRe = /decline|prefer not|don'?t wish|do not wish|do not want|not.*(disclose|identify)/i;
      // Normalize for reliable matching: expand contractions ("don't"→"do not")
      // and strip punctuation, so a stored "No, I don't have a disability"
      // matches an option worded "No, I do not have a disability".
      const norm = (s: string) => (s || '').toLowerCase().replace(/n't/g, ' not').replace(/[^a-z0-9]+/g, ' ').trim();
      let opt: any;
      if (value === DECLINE) {
        opt = opts.find((o) => declineRe.test(o.textContent || ''));
      } else {
        const nv = norm(value);
        // Gender synonyms so "Male" selects a "Man" option, and vice versa.
        const syn: Record<string, string[]> = { male: ['man'], man: ['male'], female: ['woman'], woman: ['female'] };
        const cands = new Set([nv, ...(syn[nv] || [])]);
        opt =
          opts.find((o) => norm(o.textContent || '') === nv) || // exact
          opts.find((o) => cands.has(norm(o.textContent || ''))) || // synonym exact (male↔man)
          // value is a substring of the option ("asian" ⊂ "asian indian";
          // "not a protected veteran" ⊂ "I am not a protected veteran"). Uses the
          // raw value only (never synonyms) and a length guard, so "asian" can
          // never hit "american indian" and "male" can never hit "woman".
          opts.find((o) => nv.length >= 3 && norm(o.textContent || '').includes(nv));
      }
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    { selector: field.selector, value, DECLINE },
  );
}

async function pickRadio(page: Page, field: FieldSpec, value: string): Promise<boolean> {
  return await page.evaluate(
    ({ selector, value, DECLINE }) => {
      const radios = [...document.querySelectorAll(selector)] as any[];
      const lbl = (r: any) =>
        ((r.labels && r.labels[0] ? r.labels[0].textContent : '') || '').trim() || r.value;
      // Same normalization as selectOption: "No, I don't have a disability"
      // has to match "No, I do not have a disability and have not had one".
      const norm = (s: string) => (s || '').toLowerCase().replace(/n't/g, ' not').replace(/[^a-z0-9]+/g, ' ').trim();
      const declineRe = /decline|prefer not|don'?t wish|do not want to answer|choose not to disclose/i;
      const nv = norm(value);
      let r: any;
      if (value === DECLINE) r = radios.find((x) => declineRe.test(lbl(x)));
      else
        r =
          radios.find((x) => norm(lbl(x)) === nv) ||
          radios.find((x) => nv.length >= 2 && norm(lbl(x)).includes(nv)) ||
          radios.find((x) => norm(x.value) === nv);
      if (!r) return false;
      // Click, don't assign. Setting `.checked` on a React-controlled radio is
      // reverted on the next render — the scan then reads it back as filled
      // while the ATS still sees nothing chosen. Observed live: Ramp's SMS
      // consent group reported filled and submitted empty. A real click goes
      // through React's handler and sticks.
      r.click();
      if (!r.checked) {
        // Uncontrolled/native fallback.
        r.checked = true;
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return r.checked === true;
    },
    { selector: field.selector, value, DECLINE },
  );
}

/** Click the matching option in a custom (non-native) choice group, located by
 *  its question label. DOM-based so it works in Patchright's isolated world. */
async function clickChoice(page: Page, field: FieldSpec, value: string): Promise<boolean> {
  return await page.evaluate(
    ({ label, value, DECLINE }) => {
      const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const key = norm(label).slice(0, 40);
      const containers = [
        ...document.querySelectorAll(
          '.ashby-application-form-field-entry, [class*="_fieldEntry"], [role="radiogroup"]',
        ),
      ] as any[];
      const target = containers.find((c) => {
        const l = c.querySelector('label, legend');
        return l && key && norm(l.textContent).includes(key);
      });
      if (!target) return false;
      // Native checkboxes/radios count as options too. Ashby renders "check all
      // that apply" as real <input type=checkbox> named after each OPTION, so a
      // button-only search finds nothing and the field silently stays empty.
      const opts = [
        ...target.querySelectorAll('button, [role="radio"], input[type="checkbox"], input[type="radio"]'),
      ] as any[];
      const textOf = (o: any): string => {
        if (o.tagName !== 'INPUT') return o.textContent || '';
        const lab = o.labels && o.labels[0] ? o.labels[0].textContent : '';
        return lab || o.getAttribute('aria-label') || o.name || '';
      };
      // "United States" must select an option labelled "U.S.". Same country,
      // different spelling, and a substring match never bridges it.
      const alias = (s: string): string =>
        /^(u s|us|usa|u s a|united states|united states of america|america)$/.test(s) ? 'us' : s;
      const declineRe = /decline|prefer not|do not wish|don'?t wish|not.*(disclose|identify)|not represented/i;
      let el: any;
      if (value === DECLINE) el = opts.find((o) => declineRe.test(textOf(o)));
      else {
        const want = norm(value);
        const wantA = alias(want);
        el =
          opts.find((o) => norm(textOf(o)) === want) ||
          opts.find((o) => alias(norm(textOf(o))) === wantA) ||
          opts.find((o) => want && norm(textOf(o)).includes(want));
      }
      if (!el) return false;
      el.click();
      // A controlled checkbox may need the label click to register.
      if (el.tagName === 'INPUT' && el.type === 'checkbox' && !el.checked && el.labels?.[0]) {
        el.labels[0].click();
      }
      return el.tagName === 'INPUT' ? !!el.checked : true;
    },
    { label: field.label, value, DECLINE },
  );
}

/** Check every checkbox in a same-name group (Lever "check all that apply")
 *  whose option label matches one of the comma-separated values — e.g. spoken
 *  languages "Telugu, English, Hindi" against options "English (ENG)" etc. */
async function checkMulti(page: Page, field: FieldSpec, value: string): Promise<boolean> {
  return await page.evaluate(
    ({ name, value }) => {
      const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const wants = value.split(',').map((v) => norm(v)).filter(Boolean);
      const boxes = [...document.querySelectorAll(`input[type="checkbox"][name="${name}"]`)] as any[];
      let n = 0;
      for (const b of boxes) {
        const lbl = norm((b.labels && b.labels[0] ? b.labels[0].textContent : '') || b.value);
        const words = lbl.split(' ');
        if (wants.some((w) => w && (lbl === w || words.includes(w)))) {
          if (!b.checked) {
            b.checked = true;
            b.dispatchEvent(new Event('input', { bubbles: true }));
            b.dispatchEvent(new Event('change', { bubbles: true }));
          }
          n++;
        }
      }
      return n > 0;
    },
    { name: field.name, value },
  );
}

async function setCheckbox(page: Page, selector: string, value: string): Promise<boolean> {
  if (!selector) return false;
  const on = /^(yes|true|1|on)$/i.test(value);
  return await page.evaluate(
    ({ selector, on }) => {
      const el = document.querySelector(selector) as any;
      if (!el) return false;
      // Same React-controlled problem as radios: click to toggle, assign only
      // as the uncontrolled fallback, and report what actually stuck.
      if (el.checked !== on) el.click();
      if (el.checked !== on) {
        el.checked = on;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return el.checked === on;
    },
    { selector, on },
  );
}

/** Fill any non-file field by kind. Returns whether it actually filled the
 *  field — false means we recognized it but couldn't locate/match it. */
/** US state abbreviations, for matching "San Jose, CA" to "San Jose, California". */
const STATES: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
  mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
  nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina',
  nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee',
  tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington',
  wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
};

const nrm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Score a typeahead option against the value we typed. Higher is better, `null`
 * = never pick it. Pure so the ambiguous cases are tested offline.
 *
 * This exists because typing into an Ashby location combobox does NOT fill it.
 * A live Ramp application sat at "San Jose, CA" with the dropdown still open and
 * nothing committed — the form looked filled in a screenshot and was empty to
 * the ATS. The list is also a trap: "San Jose, CA" prefix-matches San Jose in
 * the Philippines, Colombia, Argentina and El Salvador before California.
 */
export function scoreOption(option: string, value: string): number | null {
  const o = nrm(option);
  const v = nrm(value);
  if (!o || !v) return null;
  if (o === v) return 200;
  // The head (before the first comma) is the thing being named — the city, the
  // school. Everything after is qualifiers we score as bonuses.
  const head = nrm(value.split(',')[0]);
  let score: number;
  if (o.startsWith(v)) score = 120;
  else if (head && o.startsWith(head)) score = 80;
  else if (head && o.includes(head)) score = 60;
  else return null;
  for (const part of value.split(',').slice(1).map((p) => nrm(p))) {
    if (!part) continue;
    const expanded = STATES[part] ?? part;
    if (o.includes(expanded) || o.includes(part)) score += 20;
  }
  // Disambiguates same-named cities abroad; harmless when the list has no country.
  if (/united states|\busa\b/.test(o)) score += 5;
  return score;
}

/** Pick the best option index, or null when nothing is a trustworthy match. */
export function pickOption(options: string[], value: string): number | null {
  let best = -1;
  let bestIdx: number | null = null;
  options.forEach((o, i) => {
    const s = scoreOption(o, value);
    if (s != null && s > best) { best = s; bestIdx = i; }
  });
  return bestIdx;
}

/**
 * Locate a text input either by its CSS selector or by its label, tag it, and
 * report whether it's a typeahead.
 *
 * The tag matters: Ashby's location combobox has NO id and NO name, so the scan
 * records an empty selector and every later step has to re-find it by label.
 * Marking it once gives the combobox flow a stable handle to type into, read
 * options from, and verify — without that, the typeahead path was unreachable
 * on exactly the field that needed it.
 */
const TARGET = '[data-af-target="1"]';

async function locateInput(
  page: Page,
  selector: string,
  label: string,
): Promise<{ sel: string; combobox: boolean } | null> {
  const found = await page
    .evaluate(
      ({ selector, label }) => {
        const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        for (const prev of document.querySelectorAll('[data-af-target]')) prev.removeAttribute('data-af-target');
        let el: any = selector ? document.querySelector(selector) : null;
        if (!el) {
          const key = norm(label);
          if (!key) return null;
          const entries = [
            ...document.querySelectorAll('.ashby-application-form-field-entry, [class*="_fieldEntry"], .application-question'),
          ] as any[];
          for (const e of entries) {
            const labEl = e.querySelector('.application-label .text, .ashby-application-form-question-title, [class*="_label"], label');
            const lt = norm(labEl ? labEl.textContent || '' : '');
            if (!lt || !(lt === key || lt.includes(key) || key.includes(lt))) continue;
            el = e.querySelector(
              'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=submit]), textarea',
            );
            if (el) break;
          }
        }
        if (!el) return null;
        el.setAttribute('data-af-target', '1');
        return {
          combobox:
            el.getAttribute('role') === 'combobox' ||
            !!el.getAttribute('aria-autocomplete') ||
            el.getAttribute('aria-haspopup') === 'listbox' ||
            !!el.closest('[role="combobox"]'),
        };
      },
      { selector, label },
    )
    .catch(() => null);
  return found ? { sel: TARGET, combobox: found.combobox } : null;
}

/**
 * Fill a typeahead: type, wait for the list, click the best option, and verify
 * something actually committed. Returns false when nothing matched — the field
 * then reports unfilled instead of leaving a half-typed value that reads as
 * filled to us and empty to the ATS.
 */
/**
 * The options belonging to THIS combobox, in DOM order.
 *
 * Scoping matters more than it looks. A Greenhouse page keeps a hidden 244-entry
 * phone-country list mounted at all times, so a document-wide `[role="option"]`
 * query returns "Afghanistan +93" as option 0 whether or not anything is open.
 * `aria-controls` names the right listbox; the visible-listbox and visible-option
 * fallbacks cover Ashby, which names nothing.
 */
async function comboOptions(page: Page, selector: string): Promise<string[]> {
  return await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as any;
      if (!el) return [];
      const vis = (e: any) => !!e && (e.offsetParent !== null || e.getClientRects().length > 0);
      const ctrl = el.getAttribute('aria-controls');
      let scope: any = ctrl ? document.getElementById(ctrl) : null;
      if (!scope || !vis(scope)) {
        scope = [...document.querySelectorAll('[role="listbox"]')].find(vis) ?? null;
      }
      const nodes = scope
        ? [...scope.querySelectorAll('[role="option"], [class*="_option"], li')]
        : [...document.querySelectorAll('[role="option"], [class*="_option"], li[id*="option"]')];
      return (nodes as any[])
        .filter(vis)
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }, selector)
    .catch(() => []);
}

async function fillCombobox(page: Page, selector: string, value: string): Promise<boolean> {
  // A real click, then real keystrokes. The native-setter trick that works on
  // plain React inputs does NOT open a react-select menu — `aria-expanded` stays
  // false and no options ever render, so the pick silently found nothing. And no
  // blur anywhere: blurring a typeahead closes the list without committing,
  // which is how "San Jose, CA" ended up typed-but-empty on a live form.
  await page.click(selector, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);

  // Poll for the menu instead of sleeping a fixed amount. Under the fleet's
  // 8-way concurrent prepare these menus render a lot slower than they do in a
  // single-page bench, and a fixed wait turned a working field into an
  // intermittent "couldn't fill" — the worst kind of coverage bug, because it
  // looks like a form quirk rather than a race.
  const typeAndWait = async (text: string): Promise<string[]> => {
    await page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await page.keyboard.type(text, { delay: 25 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      const opts = await comboOptions(page, selector);
      if (opts.length) return opts;
      await page.waitForTimeout(250);
    }
    return [];
  };

  let options = await typeAndWait(value);
  // Some menus only populate on a shorter prefix — an exact string can filter to
  // nothing when the option text carries a suffix ("United States +1").
  if (!options.length) options = await typeAndWait(value.split(',')[0].slice(0, 12));
  const idx = pickOption(options, value);
  if (idx == null) return false;

  const clicked = await page
    .evaluate(
      ({ sel, i }: { sel: string; i: number }) => {
        const el = document.querySelector(sel) as any;
        const vis = (e: any) => !!e && (e.offsetParent !== null || e.getClientRects().length > 0);
        const ctrl = el?.getAttribute('aria-controls');
        let scope: any = ctrl ? document.getElementById(ctrl) : null;
        if (!scope || !vis(scope)) scope = [...document.querySelectorAll('[role="listbox"]')].find(vis) ?? null;
        const nodes = scope
          ? [...scope.querySelectorAll('[role="option"], [class*="_option"], li')]
          : [...document.querySelectorAll('[role="option"], [class*="_option"], li[id*="option"]')];
        const target = (nodes as any[]).filter(vis)[i];
        if (!target) return false;
        target.click();
        return true;
      },
      { sel: selector, i: idx },
    )
    .catch(() => false);
  if (!clicked) return false;
  await page.waitForTimeout(400);

  // Committed means the menu CLOSED and the control holds a value. Checking the
  // value alone passes trivially — we typed it — which is exactly the false
  // "filled" that let an empty required field through the pre-submit gate.
  return await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as any;
      if (!el) return false;
      if (el.getAttribute('aria-expanded') === 'true') return false;
      const own = el.value || el.getAttribute('value') || '';
      // react-select moves the chosen label out of the input into a value node,
      // leaving the input empty — so accept either.
      const shown = el.closest('[class*="control"], [class*="_fieldEntry"]')?.innerText || '';
      return !!String(own).trim() || !!String(shown).trim();
    }, selector)
    .catch(() => false);
}

/**
 * Pick one option in an ARIA dropdown: open it, press the matching option,
 * confirm the control now shows it and closed. Material/Wiz ignore a bare
 * .click(); they act on the pointer sequence, so both helpers send one.
 */
async function pickListbox(page: Page, field: FieldSpec, value: string): Promise<boolean> {
  await page.click(field.selector).catch(() => {});
  await page.waitForTimeout(300);
  const idx = value === DECLINE
    ? (field.options ?? []).findIndex((o) => /decline|prefer not|do not wish|don'?t wish/i.test(o))
    : pickOption(field.options ?? [], value) ?? -1;
  if (idx < 0) return false;
  const want = (field.options ?? [])[idx];
  return await page.evaluate(
    async ({ sel, want }: { sel: string; want: string }) => {
      const clean = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const press = (el: any) => {
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.x + 4, clientY: r.y + 4 };
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
          el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
      };
      const cb = document.querySelector(sel) as any;
      if (!cb) return false;
      // This control's OWN list. A document-wide search hit the first
      // "September" on the page, which belonged to another job's dropdown.
      const id = cb.getAttribute('aria-controls') || cb.getAttribute('aria-owns');
      let lb: any = id ? document.getElementById(id) : null;
      for (let p = cb.parentElement, i = 0; !lb?.querySelector?.('[role="option"]') && p && i < 4; p = p.parentElement, i++) {
        lb = [...p.querySelectorAll('[role="listbox"]')].find((l: any) => l !== cb && l.querySelector('[role="option"]'));
      }
      if (!lb) return false;
      const head = (o: any) => clean((o.innerText || o.textContent || '').split('\n')[0]);
      const opt = [...lb.querySelectorAll('[role="option"]')].find((o: any) => head(o) === want) as any;
      if (!opt) return false;
      press(opt);
      await new Promise((r) => setTimeout(r, 400));
      return cb.getAttribute('aria-expanded') !== 'true' && clean(cb.textContent).includes(want);
    },
    { sel: field.selector, want },
  );
}

/** Select options in an ARIA multi-select list. ALL picks every option present
 *  at fill time (earlier answers can remove some, e.g. the primary location). */
async function pickMultiListbox(page: Page, field: FieldSpec, value: string): Promise<boolean> {
  return await page.evaluate(
    async ({ sel, value, ALL }: { sel: string; value: string; ALL: string }) => {
      const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const press = (el: any) => {
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.x + 4, clientY: r.y + 4 };
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
          el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
      };
      const lb = document.querySelector(sel) as any;
      if (!lb) return false;
      const opts = [...lb.querySelectorAll('[role="option"]')] as any[];
      const wants = value === ALL ? null : value.split(';').map(norm).filter(Boolean);
      const head = (o: any) => norm((o.innerText || o.textContent || '').split('\n')[0]);
      const targets = opts.filter((o) => !wants || wants.some((w) => (' ' + head(o) + ' ').includes(' ' + w + ' ')));
      if (!targets.length) return false;
      for (const o of targets) if (o.getAttribute('aria-selected') !== 'true') press(o);
      await new Promise((r) => setTimeout(r, 300));
      return targets.every((o) => o.getAttribute('aria-selected') === 'true');
    },
    { sel: field.selector, value, ALL },
  );
}

export async function fillField(page: Page, field: FieldSpec, value: string): Promise<boolean> {
  switch (field.kind) {
    case 'listbox':
      return await pickListbox(page, field, value);
    case 'multilistbox':
      return await pickMultiListbox(page, field, value);
    case 'text':
    case 'email':
    case 'tel':
    case 'url':
    case 'textarea':
      // A selector-less text input (Ashby React field) is located by its label.
      {
        const loc = await locateInput(page, field.selector, field.label);
        if (!loc) return false;
        if (loc.combobox) return await fillCombobox(page, loc.sel, value);
        await reactFill(page, loc.sel, value);
        return true;
      }
    case 'select':
      return await selectOption(page, field, value);
    case 'radio':
      return await pickRadio(page, field, value);
    case 'choice':
      // Lever "check all that apply" collapses to a named checkbox group → check
      // each matching box. Ashby button/radio groups (no shared name) → clickChoice.
      return field.name ? await checkMulti(page, field, value) : await clickChoice(page, field, value);
    case 'checkbox':
      if (!field.selector) return false;
      return await setCheckbox(page, field.selector, value);
    default:
      return false;
  }
}

/** Marker put on the chosen file input so setInputFiles can target it exactly. */
const FILE_TARGET = '[data-af-file="1"]';

/**
 * Attach the résumé to the RÉSUMÉ field — never to an "autofill from resume"
 * dropzone.
 *
 * The fallback selector used to be a bare `input[type="file"]`, i.e. the first
 * file input on the page. On Ashby that is the autofill widget sitting above the
 * real Resume field, so the résumé went to Ashby's parser, which re-rendered the
 * form with its own values and wiped Phone, LinkedIn and a required checkbox we
 * had already filled. Fixed here rather than at each call site, because both
 * prepare and replay route through this function.
 */
export async function uploadResume(page: Page, selector: string, path: string): Promise<void> {
  const target = await page.evaluate((sel: string) => {
    const clean = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
    const isAutofillZone = (el: Element): boolean => {
      const zone = el.closest('div, section, fieldset');
      return /autofill|auto-fill|fill (in )?(key )?(application )?fields|parse (your )?resume/i.test(
        clean(zone?.textContent || ''),
      );
    };
    for (const prev of document.querySelectorAll('[data-af-file]')) prev.removeAttribute('data-af-file');

    // An explicit selector is trusted only if it is not the autofill dropzone.
    let el = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
    if (el && isAutofillZone(el)) el = null;
    if (!el) {
      const inputs = [...document.querySelectorAll('input[type="file"]')] as HTMLElement[];
      const usable = inputs.filter((i) => !isAutofillZone(i));
      // Prefer one whose surroundings say résumé; else the first non-autofill one.
      el =
        usable.find((i) => /resume|cv\b|curriculum/i.test(clean(i.closest('div, section, fieldset')?.textContent || ''))) ??
        usable[0] ??
        null;
    }
    if (!el) return false;
    el.setAttribute('data-af-file', '1');
    return true;
  }, selector);
  if (!target) throw new Error('no résumé file input found (only an autofill dropzone)');
  await page.setInputFiles(FILE_TARGET, path);
}
