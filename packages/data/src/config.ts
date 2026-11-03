import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * Load and lightly validate the two YAML sources of truth.
 * `profile.yml` = identity / narrative / targets; `answers.yml` = the
 * application answer cache (work auth, education, EEO stance, etc.).
 * Real files hold PII and are gitignored; `*.example.yml` are the templates.
 */

export interface Profile {
  candidate: {
    full_name: string;
    email: string;
    phone: string;
    location: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface Answers {
  identity: Record<string, unknown>;
  authorization: Record<string, unknown>;
  education: Record<string, unknown>;
  eeo: Record<string, unknown>;
  [k: string]: unknown;
}

function load<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`Config not found: ${path}`);
  }
  return parse(readFileSync(path, 'utf8')) as T;
}

function require(obj: Record<string, unknown>, keys: string[], where: string) {
  for (const k of keys) {
    if (obj[k] == null || obj[k] === '') {
      throw new Error(`Missing required key "${k}" in ${where}`);
    }
  }
}

export function loadProfile(path: string): Profile {
  const p = load<Profile>(path);
  if (!p.candidate) throw new Error(`Missing "candidate" block in ${path}`);
  require(p.candidate, ['full_name', 'email', 'phone', 'location'], `${path} candidate`);
  return p;
}

export function loadAnswers(path: string): Answers {
  const a = load<Answers>(path);
  require(a as Record<string, unknown>, ['identity', 'authorization', 'education', 'eeo'], path);
  return a;
}

/** One board to poll: `{ ats, slug, company }` for feed-based ATSes. */
export interface TargetBoard {
  ats: string;
  slug: string;
  company: string;
}

/** A self-hosted, browser-read board (Eightfold and friends). */
export interface TargetEightfold {
  host: string;
  company: string;
  query: string;
  location?: string;
}

export interface DiscoverySettings {
  maxAgeHours: number;
  concurrency: number;
  pollMinutes: number;
}

export interface Targets {
  settings: DiscoverySettings;
  boards: TargetBoard[];
  eightfold: TargetEightfold[];
}

interface RawTargets {
  settings?: { max_age_hours?: number; concurrency?: number; poll_minutes?: number };
  boards?: Record<string, string[]>;
  eightfold?: Array<{ host?: string; company?: string; query?: string; location?: string }>;
}

/**
 * Load the board registry — which companies the fleet polls.
 *
 * This exists so target coverage is DATA, not source. It used to be five slugs
 * hardcoded in `bin/serve.ts`, which meant the product only ever looked where
 * someone had typed a company name; adding coverage required a code change and
 * a redeploy. Now it's a config file a user (or a future per-tenant record)
 * owns.
 *
 * A company slug is derived, never guessed at runtime: an entry that doesn't
 * resolve just yields no jobs, and `probe-targets.ts` is how you tell the
 * difference between "dead slug" and "quiet board" before committing one.
 */
export function loadTargets(path: string): Targets {
  const raw = load<RawTargets>(path);
  const boards: TargetBoard[] = [];
  for (const [ats, slugs] of Object.entries(raw.boards ?? {})) {
    if (!Array.isArray(slugs)) continue;
    for (const slug of slugs) {
      if (typeof slug !== 'string' || !slug.trim()) continue;
      // Company label defaults to the slug; for Workday's "tenant:dc:site"
      // that's the tenant, which is the human-meaningful part.
      const company = slug.includes(':') ? slug.split(':')[0] : slug;
      boards.push({ ats, slug: slug.trim(), company });
    }
  }
  const eightfold: TargetEightfold[] = (raw.eightfold ?? [])
    .filter((e) => e && e.host && e.company && e.query)
    .map((e) => ({
      host: String(e.host),
      company: String(e.company),
      query: String(e.query),
      location: e.location ? String(e.location) : undefined,
    }));

  if (!boards.length && !eightfold.length) {
    throw new Error(`No boards configured in ${path} — the fleet would discover nothing.`);
  }

  return {
    settings: {
      maxAgeHours: raw.settings?.max_age_hours ?? 720,
      concurrency: raw.settings?.concurrency ?? 8,
      pollMinutes: raw.settings?.poll_minutes ?? 15,
    },
    boards,
    eightfold,
  };
}
