/** Probe every board in the target registry and report which ones actually
 *  return jobs. This is the check `config/targets.yml` tells you to run before
 *  keeping a slug: in production a dead board and a broken adapter look
 *  identical, so coverage has to be proven against the live feeds. Read-only.
 *  Exits non-zero if any configured board comes back empty.
 *
 *  Usage: node packages/discovery/bench/probe-targets.ts [path/to/targets.yml]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
// Imported by path rather than from '@apply-fleet/data': this runs the exact
// loader the fleet uses (a registry that fails here fails there) without
// pulling the data index's sqlite/keychain modules into a bench script, and
// without adding a dependency the discovery package itself doesn't need.
import { loadTargets } from '../../data/src/config.ts';
import { discoverAll, type DiscoveryTarget } from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const path =
  process.argv[2] ??
  [resolve(root, 'config/targets.yml'), resolve(root, 'config/targets.example.yml')].find(
    existsSync,
  )!;

const targets = loadTargets(path);
const probes: DiscoveryTarget[] = targets.boards.map((b) => ({
  ats: b.ats as DiscoveryTarget['ats'],
  slug: b.slug,
  company: b.company,
}));

console.log(`registry: ${path}`);
console.log(
  `${probes.length} boards across ${new Set(probes.map((p) => p.ats)).size} ATS` +
    ` (+${targets.eightfold.length} browser-read eightfold board(s), not probed here)\n`,
);

const errors = new Map<string, string>();
const t0 = Date.now();
// A wide window on purpose: this asks "is the feed alive", not "is it fresh",
// so a quiet-but-working board doesn't read as dead.
const jobs = await discoverAll(probes, {
  maxAgeHours: 24 * 365,
  concurrency: targets.settings.concurrency,
  onError: (t, err) => errors.set(`${t.ats}|${t.slug}`, String((err as Error)?.message ?? err)),
});

const counts = new Map<string, number>();
for (const j of jobs) {
  const k = `${j.ats}|${j.source}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

const byAts = new Map<string, { live: string[]; dead: string[] }>();
for (const p of probes) {
  const k = `${p.ats}|${p.slug}`;
  const n = counts.get(k) ?? 0;
  if (!byAts.has(p.ats)) byAts.set(p.ats, { live: [], dead: [] });
  const bucket = byAts.get(p.ats)!;
  if (n > 0) bucket.live.push(`${p.slug}(${n})`);
  else bucket.dead.push(`${p.slug}${errors.has(k) ? ` [${errors.get(k)}]` : ''}`);
}

const liveBoards = counts.size;
console.log(
  `probed ${probes.length} boards in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    ` → ${jobs.length} jobs, ${liveBoards} live boards\n`,
);
for (const [ats, { live, dead }] of [...byAts.entries()].sort()) {
  console.log(`${ats} — ${live.length}/${live.length + dead.length} live`);
  if (live.length) console.log(`  live: ${live.join(' ')}`);
  if (dead.length) console.log(`  DEAD: ${dead.join(' ')}`);
}

const deadTotal = probes.length - liveBoards;
if (deadTotal) {
  console.log(`\n${deadTotal} configured board(s) returned nothing — drop or fix them.`);
  process.exitCode = 1;
}
