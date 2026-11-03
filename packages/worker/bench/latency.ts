/**
 * Fallback-ladder latency benchmark — settles the ordering question with real
 * numbers on THIS machine instead of estimates. Measures, per form:
 *
 *   1. DOM scan        — scanForm() (the per-ATS / heuristic path we ship)
 *   2. AX snapshot     — page.accessibility.snapshot() + role/name harvest
 *   3. AX CDP fullTree — Accessibility.getFullAXTree over CDP + filter
 *   4. Vision (local)  — full-page screenshot (the dominant on-device cost;
 *                        the model round-trip is a separate fixed ~1–3s)
 *   5. MiniLM embed    — all-MiniLM-L6-v2 label→vector (cold load + warm/label)
 *
 * For each strategy we report FIRST-call latency (cold, includes any tree
 * priming) separately from steady-state p50/p95, plus how many fields it found
 * (a fast reader that sees nothing is useless). Run:
 *
 *   node packages/worker/bench/latency.ts
 */
import { chromium, type Page } from 'patchright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { scanForm } from '../src/index.ts';

const N = 30; // timed iterations per strategy per page (after 1 warm-up captured separately)
const FIXDIR = resolve(import.meta.dirname, '../test/fixtures');

interface Sample {
  first: number; // cold / first-call ms (priming shows up here)
  p50: number;
  p95: number;
  mean: number;
  found: number; // fields the strategy located
}

function summarize(times: number[], found: number): Sample {
  const first = times[0];
  const rest = times.slice(1).sort((a, b) => a - b);
  const q = (p: number) => rest[Math.min(rest.length - 1, Math.floor(p * rest.length))] ?? first;
  const mean = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : first;
  return { first, p50: q(0.5), p95: q(0.95), mean, found };
}

const CONTROL_ROLES = new Set([
  'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'radiogroup',
  'searchbox', 'spinbutton', 'switch', 'menuitemcheckbox', 'menuitemradio', 'slider',
]);

/** Harvest (role, name) form controls from a Playwright AX snapshot tree. The
 *  accessible name IS the label — Chrome computes it, so "heuristic label
 *  association" is a free tree walk here, no DOM label-hunting. */
function harvestAx(node: any, out: Array<{ role: string; name: string }>): void {
  if (!node) return;
  if (CONTROL_ROLES.has(node.role) && (node.name || node.role === 'radiogroup')) {
    out.push({ role: node.role, name: node.name || '' });
  }
  for (const c of node.children || []) harvestAx(c, out);
}

async function timeDomScan(page: Page): Promise<Sample> {
  const times: number[] = [];
  let found = 0;
  for (let i = 0; i <= N; i++) {
    const t = performance.now();
    const fields = await scanForm(page);
    times.push(performance.now() - t);
    found = fields.length;
  }
  return summarize(times, found);
}

async function timeAxSnapshot(page: Page): Promise<Sample | null> {
  if (!(page as any).accessibility?.snapshot) return null;
  const times: number[] = [];
  let found = 0;
  for (let i = 0; i <= N; i++) {
    const t = performance.now();
    const tree = await (page as any).accessibility.snapshot({ interestingOnly: false });
    const controls: Array<{ role: string; name: string }> = [];
    harvestAx(tree, controls);
    times.push(performance.now() - t);
    found = controls.length;
  }
  return summarize(times, found);
}

async function timeAxCdp(page: Page): Promise<Sample | null> {
  const ctx = page.context();
  let session: any;
  try {
    session = await ctx.newCDPSession(page);
    await session.send('Accessibility.enable');
  } catch {
    return null;
  }
  const times: number[] = [];
  let found = 0;
  for (let i = 0; i <= N; i++) {
    const t = performance.now();
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    const controls = nodes.filter((n: any) => CONTROL_ROLES.has(n.role?.value));
    times.push(performance.now() - t);
    found = controls.length;
  }
  await session.detach().catch(() => {});
  return summarize(times, found);
}

async function timeVisionLocal(page: Page): Promise<Sample> {
  const times: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = performance.now();
    await page.screenshot({ fullPage: true });
    times.push(performance.now() - t);
  }
  // "found" here = candidate boxes vision would mark, computed once.
  const found = await page.evaluate(
    () => document.querySelectorAll('input,select,textarea,button,[role="radio"],[contenteditable]').length,
  );
  return summarize(times, found);
}

async function loadFixture(page: Page, name: string): Promise<void> {
  await page.goto(pathToFileURL(resolve(FIXDIR, `${name}.html`)).href);
}

/** Inflate the current page to a realistic single-page-app node count so the
 *  AX-tree "walks the whole tree" concern actually shows up. Real ATS forms
 *  render thousands of nodes around a handful of fields. */
async function inflate(page: Page, targetNodes: number): Promise<number> {
  return await page.evaluate((target) => {
    const filler = document.createElement('div');
    filler.id = '__bench_filler';
    document.body.appendChild(filler);
    let n = document.querySelectorAll('*').length;
    while (n < target) {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      wrap.innerHTML = '<span>label</span><span>value</span><a href="#">link</a><p>text node here</p>';
      filler.appendChild(wrap);
      n += 5;
    }
    return document.querySelectorAll('*').length;
  }, targetNodes);
}

function row(label: string, s: Sample | null): string {
  if (!s) return `  ${label.padEnd(20)} — unavailable`;
  const f = (x: number) => x.toFixed(1).padStart(7);
  return `  ${label.padEnd(20)} first ${f(s.first)}ms  p50 ${f(s.p50)}ms  p95 ${f(s.p95)}ms  (found ${s.found})`;
}

async function benchMiniLM(labels: string[]): Promise<void> {
  console.log('\n=== MiniLM (all-MiniLM-L6-v2) label→vector ===');
  let pipeline: any;
  try {
    ({ pipeline } = await import('@huggingface/transformers'));
  } catch (e) {
    console.log('  transformers.js not installed — skipping');
    return;
  }
  const tLoad = performance.now();
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const loadMs = performance.now() - tLoad;
  console.log(`  cold load (download+init, one-time): ${loadMs.toFixed(0)}ms`);

  // warm: embed the whole form's labels in one batched call, several times
  const runs: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    await extractor(labels, { pooling: 'mean', normalize: true });
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  const p50 = runs[Math.floor(runs.length / 2)];
  console.log(
    `  warm embed of ${labels.length} labels (batched): p50 ${p50.toFixed(1)}ms  → ${(p50 / labels.length).toFixed(2)}ms/label`,
  );
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1600 });

  const targets: Array<{ name: string; heavy?: number }> = [
    { name: 'greenhouse' },
    { name: 'ashby' },
    { name: 'custom' },
    { name: 'greenhouse', heavy: 3000 },
    { name: 'greenhouse', heavy: 6000 },
  ];

  let sampleLabels: string[] = [];

  for (const t of targets) {
    await loadFixture(page, t.name);
    let nodeCount = await page.evaluate(() => document.querySelectorAll('*').length);
    if (t.heavy) nodeCount = await inflate(page, t.heavy);
    const title = t.heavy ? `${t.name}  (inflated → ${nodeCount} DOM nodes)` : `${t.name}  (${nodeCount} DOM nodes)`;
    console.log(`\n=== ${title} ===`);

    const dom = await timeDomScan(page);
    const axSnap = await timeAxSnapshot(page);
    const axCdp = await timeAxCdp(page);
    const vis = await timeVisionLocal(page);

    console.log(row('1. DOM scan', dom));
    console.log(row('2. AX snapshot', axSnap));
    console.log(row('3. AX CDP fullTree', axCdp));
    console.log(row('4. Vision screenshot', vis));

    if (t.name === 'greenhouse' && !t.heavy) {
      const fields = await scanForm(page);
      sampleLabels = fields.map((f) => f.label).filter(Boolean);
    }
  }

  await browser.close();

  if (sampleLabels.length) await benchMiniLM(sampleLabels);
  console.log('\n(vision model round-trip, excluded above, is a fixed ~1000–3000ms network call on top of the screenshot)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
