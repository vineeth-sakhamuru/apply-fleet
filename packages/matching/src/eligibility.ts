import type { DiscoveredJob } from '@apply-fleet/discovery';

/**
 * Hard eligibility gate: decides whether a discovered job is one the applicant
 * can and should apply to at all, before any relevance scoring. All checks are
 * pure and run off the fields a {@link DiscoveredJob} actually carries
 * (`role` + `location`); there is no job description to inspect.
 *
 * Applicant context baked into {@link DEFAULT_RULES}: a U.S. Permanent Resident
 * (not a citizen) targeting early-career software-engineering roles in the U.S.
 * - Roles demanding U.S. **citizenship** or a security **clearance** are out.
 * - "No sponsorship" postings are fine (he needs none) and are NOT gated here.
 * - Senior/staff/principal/etc. titles are out; new-grad/intern/etc. need not
 *   be stated explicitly — anything that isn't blocked is allowed.
 */

export interface EligibilityRules {
  /** A title must contain at least one of these to count as a SWE role. */
  titleKeywords: string[];
  /** Level markers we welcome (informational; absence is not disqualifying). */
  levelAllow: string[];
  /** Level markers that disqualify a title outright. */
  levelBlock: string[];
  /** When true, only U.S. locations pass the location check. */
  usOnly: boolean;
}

export const DEFAULT_RULES: EligibilityRules = {
  titleKeywords: [
    'software engineer',
    'swe',
    'sde',
    'backend',
    'back end',
    'full stack',
    'full-stack',
    'platform',
    'infrastructure',
    'distributed systems',
    'python',
    'api',
  ],
  levelAllow: [
    'new grad',
    'new graduate',
    'university grad',
    'university graduate',
    'entry level',
    'early career',
    'intern',
    'internship',
    'associate',
    'junior',
  ],
  levelBlock: [
    'senior',
    'staff',
    'principal',
    'lead',
    'manager',
    'director',
    'architect',
  ],
  usOnly: true,
};

/**
 * Collapse text to a space-padded, alphanumeric-only lowercase form so that
 * `text.includes(' term ')` is a whole-word match. Hyphens and slashes become
 * spaces, so "full-stack" and "TS/SCI" normalize to "full stack" / "ts sci".
 */
function normalize(text: string): string {
  const inner = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${inner} `;
}

/** Whether `text` contains `phrase` as a run of whole words. */
function hasPhrase(text: string, phrase: string): boolean {
  const p = normalize(phrase).trim();
  return p.length > 0 && text.includes(` ${p} `);
}

/** Two-letter USPS state (and DC) codes, matched case-sensitively on raw text. */
const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
];

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia',
];

/** Positive U.S. markers other than state names/codes (whole-word). */
const US_MARKERS = ['united states', 'usa', 'us', 'remote'];

/**
 * Unambiguous non-U.S. countries, regions, and cities. Deliberately excludes
 * names that collide with U.S. places (e.g. Paris TX, Rome GA) to avoid false
 * rejections; matched before the positive U.S. markers so "Remote (EU)" loses.
 */
const NON_US_MARKERS = [
  'uk', 'united kingdom', 'england', 'scotland', 'wales', 'ireland', 'dublin',
  'london', 'india', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai',
  'delhi', 'canada', 'toronto', 'vancouver', 'ontario', 'germany', 'munich',
  'france', 'spain', 'netherlands', 'amsterdam', 'poland', 'warsaw', 'krakow',
  'singapore', 'australia', 'sydney', 'melbourne', 'japan', 'tokyo', 'china',
  'shanghai', 'beijing', 'brazil', 'mexico', 'israel', 'tel aviv', 'sweden',
  'stockholm', 'switzerland', 'zurich', 'italy', 'portugal', 'lisbon',
  'eu', 'emea', 'apac', 'europe', 'latam',
];

type LocationClass = 'us' | 'non-us' | 'unknown';

/**
 * Classify a free-text location. Non-U.S. markers win over U.S. ones, so a
 * "Remote (EU)" never reads as U.S. off its "us"-less text. State *codes* are
 * matched case-sensitively on the raw string ("WA"), so they don't fire inside
 * lowercase words. Anything with no recognizable marker is `'unknown'`.
 */
export function classifyLocation(location: string): LocationClass {
  const raw = location ?? '';
  const text = normalize(raw);

  for (const marker of NON_US_MARKERS) {
    if (text.includes(` ${marker} `)) return 'non-us';
  }
  for (const code of US_STATE_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(raw)) return 'us';
  }
  for (const marker of [...US_STATE_NAMES, ...US_MARKERS]) {
    if (text.includes(` ${marker} `)) return 'us';
  }
  return 'unknown';
}

/** Does the title carry a disqualifying level word? Returns the word if so. */
function blockedLevel(role: string, block: string[]): string | null {
  const text = normalize(role);
  for (const word of block) {
    if (hasPhrase(text, word)) return word;
  }
  return null;
}

/** Does the title read as a software-engineering role we target? */
function matchesTitle(role: string, keywords: string[]): boolean {
  const text = normalize(role);
  return keywords.some((k) => hasPhrase(text, k));
}

/**
 * A demand for U.S. citizenship or a security clearance. NOT triggered by
 * "no sponsorship" / "sponsorship not available" — those are fine for a PR.
 */
function requiresCitizenshipOrClearance(role: string): boolean {
  const text = normalize(role);
  // "citizen", "citizens", "citizenship" — stem match is fine here.
  if (text.includes('citizen')) return true;
  const clearanceMarkers = [
    'clearance',
    'ts sci',
    'tssci',
    'top secret',
    'security clearance',
    'polygraph',
  ];
  return clearanceMarkers.some((m) => hasPhrase(text, m));
}

/**
 * Run every gate and collect the reasons a job fails. `eligible` is true only
 * when no gate trips. Reasons are stable strings suitable for logging/UI, e.g.
 * `'level: senior'`, `'location: non-US'`, `'title: not a SWE role'`,
 * `'requires citizenship/clearance'`.
 */
export function isEligible(
  job: DiscoveredJob,
  rules: EligibilityRules = DEFAULT_RULES,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!matchesTitle(job.role, rules.titleKeywords)) {
    reasons.push('title: not a SWE role');
  }

  const level = blockedLevel(job.role, rules.levelBlock);
  if (level) reasons.push(`level: ${level}`);

  if (rules.usOnly && classifyLocation(job.location) !== 'us') {
    reasons.push('location: non-US');
  }

  if (requiresCitizenshipOrClearance(job.role)) {
    reasons.push('requires citizenship/clearance');
  }

  return { eligible: reasons.length === 0, reasons };
}
