import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Page } from 'patchright';
import { getSecret } from '@apply-fleet/data';
import type { FieldKind, FieldSpec, HitlItem } from './types.ts';

/**
 * Vision fallback tier — field DISCOVERY + LABELING for custom, non-ATS forms
 * the DOM scanner can't read (Palantir-style: non-semantic divs, contenteditable
 * "inputs", JS dropdowns, div button-groups).
 *
 * See vision.DESIGN.md for the full rationale + sources. In short: enumerate
 * interactive controls in-page (DOM-only, isolated-world safe), draw numbered
 * Set-of-Marks badges, screenshot the EMPTY pre-fill page, and ask Claude to map
 * each field's label -> mark. The model only labels which element is which; it
 * never sees profile data and never produces answer values (those still flow
 * through the existing resolver + React-safe fillField). Results are validated
 * against the live DOM and cached by form signature, so repeat encounters replay
 * deterministically with ZERO model calls.
 */

const OVERLAY_ID = '__af_som_layer__';
const KINDS: ReadonlySet<string> = new Set([
  'text', 'email', 'tel', 'url', 'textarea', 'select', 'radio', 'choice', 'checkbox', 'file',
]);

/** One interactive control found on the page, with its Set-of-Marks index. */
export interface MarkedElement {
  mark: number;
  selector: string;
  tag: string;
  type: string;
  role: string;
  name?: string;
  /** Accessible-name-ish context (aria-label / label / placeholder / title). */
  nearbyText: string;
  options?: string[];
  box: { x: number; y: number; w: number; h: number };
}

/** What the multimodal model sees. NO profile data — screenshot + metadata only. */
export interface VisionModelInput {
  /** base64 PNG of the marked, empty pre-fill page (no data: prefix). */
  screenshot: string;
  elements: MarkedElement[];
}

/** One field the model mapped from a mark. It never emits a value. */
export interface VisionFieldMapping {
  mark: number;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
  confidence: number;
}

/**
 * The model call, injectable for tests. Returns null when it can't run (no key,
 * HTTP error, unparseable output) so the tier degrades gracefully to HITL.
 */
export type VisionModel = (input: VisionModelInput) => Promise<VisionFieldMapping[] | null>;

export interface VisionScanOptions {
  /** Directory for the persisted label->selector cache (JSON file). */
  cacheDir?: string;
  /** Override the model call (tests stub this for a deterministic, offline run). */
  model?: VisionModel;
  /** Minimum model confidence to emit a mapping; below this -> HITL. Default 0.6. */
  minConfidence?: number;
  /** Override the URL used in the cache signature (default: page.url()). */
  signatureUrl?: string;
}

export interface VisionScanResult {
  /** Confident, validated label->selector mappings. */
  fields: FieldSpec[];
  /** Fields seen but not confidently/uniquely mappable — for a human, not guessed. */
  hitl: HitlItem[];
  source: 'vision' | 'vision-cache' | 'none';
  /** True only when a live model response was mapped (false for cache/keyless). */
  modelCalled: boolean;
}

type CacheFile = Record<string, FieldSpec[]>;

function cacheFilePath(dir: string): string {
  return join(dir, 'vision-cache.json');
}

function loadCache(dir: string): CacheFile {
  try {
    return JSON.parse(readFileSync(cacheFilePath(dir), 'utf8')) as CacheFile;
  } catch {
    return {}; // missing or corrupt -> empty
  }
}

function saveCache(dir: string, cache: CacheFile): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cacheFilePath(dir), JSON.stringify(cache, null, 2));
  } catch {
    /* best-effort; a write failure just means the next encounter re-calls the model */
  }
}

function signature(url: string, marked: MarkedElement[]): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* file:// or odd URL — use as-is */
  }
  const structure = marked.map((m) => `${m.tag}:${m.type}:${m.role}`).join('|');
  const hash = createHash('sha1').update(structure).digest('hex').slice(0, 16);
  return `${pathname}::${hash}`;
}

/**
 * Enumerate interactive controls, capture per-element metadata + a robust
 * selector, and draw a numbered Set-of-Marks badge over each. DOM-only so it
 * runs in Patchright's isolated world. Returns the marks; the badges are left in
 * the page (removed by the caller after the screenshot).
 */
/* eslint-disable */
function enumerateAndMark(): MarkedElement[] {
  const CSS = (window as any).CSS;
  const esc = (s: string) => (CSS && CSS.escape ? CSS.escape(s) : s);

  const cssPath = (el: any): string => {
    if (el.id) return '#' + esc(el.id);
    const parts: string[] = [];
    let node: any = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) {
        parts.unshift('#' + esc(node.id));
        break;
      }
      let sel = node.tagName.toLowerCase();
      const df = node.getAttribute && node.getAttribute('data-field');
      if (df) {
        parts.unshift(`${sel}[data-field="${df}"]`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c: any) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const labelText = (el: any): string => {
    const clip = (s: string) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const n = document.getElementById(by);
      if (n) return clip(n.textContent || '');
    }
    if (el.labels && el.labels.length) return clip(el.labels[0].textContent || '');
    if (el.placeholder) return clip(el.placeholder);
    // preceding sibling(s) carrying text (e.g. a title div before the field)
    let p = el.previousElementSibling;
    while (p) {
      const t = clip(p.textContent || '');
      if (t) return t;
      p = p.previousElementSibling;
    }
    // a title-ish node in the same wrapper, or the wrapper's preceding sibling
    const par = el.parentElement;
    if (par) {
      const title = par.querySelector('label, legend, .q-title, .title, .label, .field-label');
      if (title && !title.contains(el)) return clip(title.textContent || '');
      let q = par.previousElementSibling;
      while (q) {
        const t = clip(q.textContent || '');
        if (t) return t;
        q = q.previousElementSibling;
      }
    }
    return '';
  };

  const optionsFor = (el: any): string[] | undefined => {
    if (el.tagName === 'SELECT') {
      return [...el.options].map((o: any) => (o.textContent || '').trim()).filter(Boolean);
    }
    const opts = [...el.querySelectorAll('[data-val], [role="radio"], [role="option"], button')];
    const texts = opts
      .map((o: any) => (o.getAttribute('data-val') || o.textContent || '').trim())
      .filter(Boolean);
    return texts.length >= 2 ? texts : undefined;
  };

  const visible = (el: any): boolean => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const seen = new Set<any>();
  const candidates: Array<{ el: any; hint: string | null }> = [];
  const add = (el: any, hint: string | null) => {
    if (seen.has(el) || !visible(el)) return;
    seen.add(el);
    candidates.push({ el, hint });
  };

  // 1. native fields
  for (const el of [...document.querySelectorAll('input, select, textarea')] as any[]) {
    const t = (el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(t)) continue;
    if (/captcha/i.test(el.name || el.id || '')) continue;
    add(el, null);
  }

  // 2. div/button GROUPS (segmented controls, radiogroups) — one field per group.
  //    Mark option children as seen so they aren't enumerated individually.
  const isOption = (c: any) =>
    c.matches && c.matches('[data-val], button, [role="radio"], [role="option"]');
  const takeGroup = (el: any) => {
    if (seen.has(el) || !visible(el)) return;
    const kids = [...el.children];
    const opts = kids.filter(isOption);
    if (opts.length < 2) return;
    for (const o of opts) seen.add(o);
    add(el, 'choice');
  };
  for (const el of [...document.querySelectorAll('[role="radiogroup"]')] as any[]) takeGroup(el);
  for (const el of [...document.querySelectorAll('*')] as any[]) takeGroup(el);

  // 3. contenteditable + ARIA-role single controls
  for (const el of [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')] as any[]) {
    add(el, 'text');
  }
  for (const el of [...document.querySelectorAll(
    '[role="textbox"], [role="combobox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="spinbutton"]',
  )] as any[]) {
    add(el, null);
  }

  // draw the Set-of-Marks overlay + build metadata. NOTE: this function is
  // serialized into the page, so the overlay id is inlined (no outer refs).
  let layer = document.getElementById('__af_som_layer__');
  if (layer) layer.remove();
  layer = document.createElement('div');
  layer.id = '__af_som_layer__';
  document.body.appendChild(layer);

  const out: MarkedElement[] = [];
  candidates.forEach(({ el, hint }, mark) => {
    const r = el.getBoundingClientRect();
    const badge = document.createElement('div');
    badge.textContent = String(mark);
    badge.style.cssText =
      `position:absolute;z-index:2147483647;left:${r.left + window.scrollX}px;top:${r.top + window.scrollY}px;` +
      'background:#e11;color:#fff;font:bold 12px/14px monospace;padding:0 3px;border:1px solid #fff;pointer-events:none;';
    layer!.appendChild(badge);

    out.push({
      mark,
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      type: (el.type || (hint === 'choice' ? 'group' : '')).toString().toLowerCase(),
      role: el.getAttribute('role') || '',
      name: el.getAttribute('name') || undefined,
      nearbyText: labelText(el),
      options: optionsFor(el),
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    });
  });
  return out;
}
/* eslint-enable */

function promptFor(elements: MarkedElement[]): string {
  const list = elements
    .map(
      (e) =>
        `[${e.mark}] tag=${e.tag} type=${e.type}${e.role ? ` role=${e.role}` : ''}` +
        ` nearbyText=${JSON.stringify(e.nearbyText)}` +
        (e.options ? ` options=${JSON.stringify(e.options)}` : ''),
    )
    .join('\n');
  return (
    'This is a screenshot of an EMPTY job-application form. Each interactive control ' +
    'is overlaid with a red numbered mark. Here is the metadata for each mark:\n\n' +
    list +
    '\n\nFor every form field, output the mark number, a human-readable label (the ' +
    'question being asked), the field kind, whether it is required, and its options ' +
    '(for select/radio/choice). Kinds: text, email, tel, url, textarea, select, radio, ' +
    'choice, checkbox, file. Do NOT invent values or fill anything in — only identify ' +
    'which element is which. If you are unsure about a mark, give it a low confidence.\n\n' +
    'Respond with ONLY a JSON array, no prose:\n' +
    '[{"mark":0,"label":"Full Name","kind":"text","required":true,"confidence":0.95}]'
  );
}

/** Default model call: Claude multimodal via the repo's Keychain key. Keyless-safe. */
async function claudeVisionModel(input: VisionModelInput): Promise<VisionFieldMapping[] | null> {
  let apiKey: string | undefined;
  try {
    apiKey = getSecret('anthropic-api-key');
  } catch {
    apiKey = undefined;
  }
  if (!apiKey) return null; // keyless -> caller routes to HITL, exactly like llm.ts

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: input.screenshot } },
              { type: 'text', text: promptFor(input.elements) },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content || []).find((b) => b.type === 'text')?.text ?? '';
    return parseMappings(text);
  } catch {
    return null; // network/parse failure -> graceful HITL
  }
}

/** Extract a JSON array of mappings from model text (tolerates code fences/prose). */
export function parseMappings(text: string): VisionFieldMapping[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr as VisionFieldMapping[];
  } catch {
    return null;
  }
}

/** Count how many elements each selector resolves to on the current DOM. */
async function selectorCounts(page: Page, selectors: string[]): Promise<number[]> {
  return (await page.evaluate((sels: string[]) => {
    return sels.map((s) => {
      try {
        return document.querySelectorAll(s).length;
      } catch {
        return -1; // invalid selector
      }
    });
  }, selectors)) as number[];
}

function hitl(label: string): HitlItem {
  return { label, question: `Vision-discovered field needs review: "${label}"`, severity: 'quick' };
}

/**
 * Run the vision fallback tier on the EMPTY, pre-fill page. Returns validated
 * FieldSpecs (confident + unique selectors), HITL items for the rest, and the
 * source (fresh model, cache replay, or none/keyless).
 */
export async function visionScanForm(page: Page, opts: VisionScanOptions = {}): Promise<VisionScanResult> {
  const cacheDir = opts.cacheDir ?? join(tmpdir(), 'apply-fleet-vision');
  const minConfidence = opts.minConfidence ?? 0.6;
  const model = opts.model ?? claudeVisionModel;

  const marked = (await page.evaluate(enumerateAndMark)) as MarkedElement[];
  try {
    if (marked.length === 0) {
      return { fields: [], hitl: [], source: 'none', modelCalled: false };
    }

    const sig = signature(opts.signatureUrl ?? page.url(), marked);
    const cache = loadCache(cacheDir);

    // Cache hit: replay deterministically, no model call. Validate selectors
    // still resolve uniquely (form may have changed) -> else route to HITL.
    const cached = cache[sig];
    if (cached && cached.length) {
      const counts = await selectorCounts(page, cached.map((f) => f.selector));
      const fields: FieldSpec[] = [];
      const flagged: HitlItem[] = [];
      cached.forEach((f, i) => (counts[i] === 1 ? fields.push(f) : flagged.push(hitl(f.label))));
      return { fields, hitl: flagged, source: 'vision-cache', modelCalled: false };
    }

    // Cache miss: screenshot the marked page, ask the model to label the marks.
    const shot = await page.screenshot({ fullPage: true });
    const mappings = await model({ screenshot: shot.toString('base64'), elements: marked });
    if (!mappings) {
      // keyless / model unavailable -> graceful empty, caller routes to HITL
      return {
        fields: [],
        hitl: [
          {
            label: 'form',
            question: 'Custom form could not be read automatically — open it manually.',
            severity: 'attention',
          },
        ],
        source: 'none',
        modelCalled: false,
      };
    }

    // Validate every mapping against the live DOM before trusting it.
    const byMark = new Map(marked.map((m) => [m.mark, m]));
    const candidates = mappings
      .map((m) => ({ m, el: byMark.get(m.mark) }))
      .filter((x): x is { m: VisionFieldMapping; el: MarkedElement } => !!x.el);
    const counts = await selectorCounts(page, candidates.map((c) => c.el.selector));

    const fields: FieldSpec[] = [];
    const flagged: HitlItem[] = [];
    candidates.forEach(({ m, el }, i) => {
      const label = (m.label || el.nearbyText || '').trim();
      const okKind = KINDS.has(m.kind);
      const okSelector = counts[i] === 1; // exactly one element -> no ambiguity
      const okConf = typeof m.confidence === 'number' && m.confidence >= minConfidence;
      if (label && okKind && okSelector && okConf) {
        fields.push({
          kind: m.kind,
          label,
          name: el.name,
          selector: el.selector,
          required: !!m.required,
          options: m.options ?? el.options,
        });
      } else {
        flagged.push(hitl(label || el.nearbyText || `mark ${el.mark}`));
      }
    });

    if (fields.length) {
      cache[sig] = fields;
      saveCache(cacheDir, cache);
    }
    return { fields, hitl: flagged, source: 'vision', modelCalled: true };
  } finally {
    // always remove the Set-of-Marks overlay
    await page
      .evaluate((id: string) => {
        const l = document.getElementById(id);
        if (l) l.remove();
      }, OVERLAY_ID)
      .catch(() => {});
  }
}
