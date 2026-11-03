import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizeUntrusted } from './sanitize.ts';

/**
 * Ground drafts in Vineeth's Obsidian vault (his own project/skills writing),
 * not just resume.yml. Shells out to the vault's own search tool and returns a
 * few snippet strings so "what have you built recently?" drafts from his real
 * projects.
 *
 * Fail-safe: a missing vault/script or any error returns [] — never throws — so
 * grounding is best-effort and the drafting path degrades to résumé-only.
 *
 * The snippets are the candidate's OWN writing (trusted context), but they are
 * still run through sanitizeUntrusted (defense in depth) and length-capped here;
 * the caller additionally drops any that carry PII (factsAreClean) before they
 * reach a model.
 */

const TOP_N = 3;
const MAX_SNIPPET_LEN = 400;
const MAX_TOTAL_LEN = 1200;

/** Injectable so tests never spawn python. Returns the raw `--json` stdout. */
export type VaultRunner = (scriptPath: string, terms: string) => string;

function vaultDir(): string {
  return process.env.APPLY_FLEET_VAULT || join(homedir(), 'Vaults', 'Vineeth');
}

const defaultRunner: VaultRunner = (scriptPath, terms) =>
  execFileSync('python3', [scriptPath, 'search', terms, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 1 << 20,
  });

// ponytail: per-run in-memory cache, unbounded, process-lifetime. Fine for one
// fleet run; add a TTL / size cap if a long-lived worker searches many terms.
const cache = new Map<string, string[]>();

function parseSnippets(raw: string): string[] {
  let hits: unknown;
  try {
    hits = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(hits)) return [];

  const out: string[] = [];
  let total = 0;
  for (const h of hits) {
    const snip = (h as { snippet?: unknown }).snippet;
    if (typeof snip !== 'string') continue;
    const clean = sanitizeUntrusted(snip).slice(0, MAX_SNIPPET_LEN).trim();
    if (!clean) continue;
    if (total + clean.length > MAX_TOTAL_LEN) break;
    out.push(clean);
    total += clean.length;
    if (out.length >= TOP_N) break;
  }
  return out;
}

/**
 * Return up to a few sanitized vault snippets for `queryTerms`, cached by query
 * within the run. Empty query, absent vault/script, or any error → [].
 */
export async function vaultContext(
  queryTerms: string,
  run: VaultRunner = defaultRunner,
): Promise<string[]> {
  const terms = (queryTerms || '').trim();
  if (!terms) return [];
  if (cache.has(terms)) return cache.get(terms)!;

  const script = join(vaultDir(), '_meta', 'scripts', 'vault_search.py');
  let snippets: string[] = [];
  if (existsSync(script)) {
    try {
      snippets = parseSnippets(run(script, terms));
    } catch {
      snippets = [];
    }
  }
  cache.set(terms, snippets);
  return snippets;
}

/** Test hook: clear the per-run cache. */
export function _clearVaultCache(): void {
  cache.clear();
}
