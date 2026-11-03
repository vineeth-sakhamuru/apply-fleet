/**
 * Scrub PII and credentials out of strings/objects before they hit a log line
 * or a model prompt. Each match becomes `‹redacted:kind›`. Structure is
 * preserved: objects/arrays are walked, only string leaves are rewritten.
 *
 * ponytail: regex heuristics, not parsers. Good enough for log hygiene; swap in
 * a real address/PII parser (e.g. libpostal) if false-positive rate matters.
 * Numbers are left as-is — keep PII as strings so it can be scrubbed.
 */

// Order matters: specific/credentialed patterns run before greedy ones so a
// token regex can't swallow an email, and phone can't eat an SSN.
// For the `key` rule, group 1 is the label+separator we keep (redact the value
// only); every other rule has no capturing group.
const RULES: Array<[RegExp, string]> = [
  // Bearer tokens: everything after the scheme is the credential.
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'bearer'],
  // label = value / api_key: ... / password: "hunter2"  → redact the value.
  [
    /\b((?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*)("?)[^\s"']+\2/gi,
    'key',
  ],
  // Prefixed provider keys: sk-..., gsk_..., ghp_..., xoxb-...
  [/\b(?:sk|pk|gsk|rk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{6,}/g, 'key'],
  // AWS-style access key ids.
  [/\bA(?:KIA|SIA|IDA|ROA|GPA|IPA|NPA)[A-Z0-9]{12,}\b/g, 'key'],
  // Emails (before generic tokens; contains '@' which token regex won't match).
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, 'email'],
  // SSN: 3-2-4 with optional '-'/' ' separators (also bare 9 digits).
  [/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, 'ssn'],
  // North-American phone: optional +1, area code, 7 digits, common separators.
  [/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, 'phone'],
  // Long hex or base64 blobs → likely tokens/hashes.
  [/\b[0-9a-fA-F]{32,}\b/g, 'token'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, 'token'],
  // Street-address-ish: number + words + a street suffix (+ optional unit).
  [
    /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy)\b\.?(?:\s+(?:Apt|Suite|Ste|Unit|#)\s*\.?\s*\w+)?/gi,
    'address',
  ],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, kind] of RULES) {
    out = out.replace(re, (_m, g1?: string) =>
      // `key` keeps its captured label+separator; others replace whole match.
      kind === 'key' && typeof g1 === 'string' ? `${g1}‹redacted:key›` : `‹redacted:${kind}›`,
    );
  }
  return out;
}

export function redact<T extends string | object>(input: T): T {
  if (typeof input === 'string') return redactString(input) as T;
  return redactDeep(input) as T;
}

function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactDeep(val);
    return out;
  }
  return v;
}

/** console.log that redacts every argument first. Use anywhere PII might flow. */
export function safeLog(...args: unknown[]): void {
  console.log(
    ...args.map((a) =>
      typeof a === 'string' ? redactString(a) : a !== null && typeof a === 'object' ? redactDeep(a) : a,
    ),
  );
}
