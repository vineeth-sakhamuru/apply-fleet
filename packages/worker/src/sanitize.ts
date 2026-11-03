/**
 * Prompt-injection hardening for UNTRUSTED page text.
 *
 * Scraped job-description copy and ATS field labels/questions are attacker-
 * controlled input to our LLM calls. Two layers of defense, both applied before
 * such text ever reaches a model:
 *   1. `sanitizeUntrusted` neutralizes instruction-like content (redacts the
 *      classic "ignore previous instructions" / role-play / system-prompt-
 *      lookalike phrasings), strips invisible + control chars used to smuggle
 *      payloads, and caps length.
 *   2. `wrapUntrusted` fences the cleaned text between explicit markers so the
 *      model is told to treat everything inside strictly as data, never as
 *      instructions. The sanitizer also removes any forged marker literals from
 *      the input so untrusted text cannot "break out" of the fence.
 *
 * This does NOT change what data is sent — no PII is added here. It only makes
 * the page text that was already going to the model safe to include.
 */

/** Fence markers. Untrusted text goes between these; the model treats the
 *  contents as data only. Exported so callers/tests share the exact literals. */
export const UNTRUSTED_OPEN = '<<<UNTRUSTED_DATA>>>';
export const UNTRUSTED_CLOSE = '<<<END_UNTRUSTED_DATA>>>';

/** Hard cap on untrusted text length. A field question is short and a JD
 *  snippet is bounded; an over-long blob is itself a red flag and nothing
 *  downstream needs the tail. */
export const MAX_UNTRUSTED_LEN = 2000;

const REDACTION = ' [filtered] ';

// High-signal prompt-injection phrasings. Kept deliberately tight so real
// application questions (which never say "ignore previous instructions",
// "act as an AI", etc.) pass through byte-for-byte unchanged.
const INJECTION_PATTERNS: RegExp[] = [
  // "ignore / disregard / forget / override ... (previous|your|all|the) ...
  //  instructions | prompt | rules | context"
  /\b(?:ignore|disregard|forget|discard|override|bypass)\b[^.\n]{0,40}?\b(?:previous|prior|above|preceding|earlier|foregoing|all|any|your|these|the)\b[^.\n]{0,40}?\b(?:instructions?|prompts?|messages?|context|rules?)\b/gi,
  // "new / updated / revised instructions | prompt | rules"
  /\b(?:new|updated|revised|these\s+are\s+your)\s+(?:instructions?|prompts?|system\s+prompt|rules?)\b/gi,
  // identity override: "you are now an unrestricted AI", "you are the system"
  /\byou\s+are\s+(?:now\s+|no\s+longer\s+)?(?:an?\s+|the\s+)?(?:A\.?I\.?|assistant|chat\s*bot|bot|language\s+model|DAN|system|jailbroken|unrestricted|uncensored)\b[^.\n]{0,40}/gi,
  // role-play INTO an AI/system persona (leaves "act as a mentor" etc. alone)
  /\b(?:pretend|role[-\s]?play|act|behave)\s+(?:to\s+be\s+|as\s+|that\s+you(?:'re|\s+are)\s+)?(?:an?\s+|the\s+)?(?:A\.?I\.?|assistant|chat\s*bot|bot|language\s+model|DAN|system|jailbroken|unrestricted|uncensored)\b[^.\n]{0,40}/gi,
  // exfiltration: reveal / print / output the system prompt / your instructions
  /\b(?:reveal|print|output|repeat|show|expose|leak|display)\b[^.\n]{0,30}?\b(?:system\s+prompt|your\s+prompt|your\s+instructions?|the\s+(?:system\s+)?prompt|above\s+text)\b/gi,
  /\bsystem\s+prompt\b/gi,
  /\bdeveloper\s+(?:message|mode|prompt)\b/gi,
  // fake chat-turn / control-token boundaries
  /^[ \t>]*(?:system|assistant|developer)\s*:/gim,
  /<\/?(?:system|assistant|developer|user|im_start|im_end)\b[^>]*>/gi,
  /<\|[^|]*\|>/g,
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip any forged fence marker (either case) so untrusted text can't close the
// data block early and escape into instruction position.
const MARKER_RE = new RegExp(
  [UNTRUSTED_OPEN, UNTRUSTED_CLOSE].map(escapeRegex).join('|'),
  'gi',
);

/**
 * Drop invisible/bidi chars and neutralize C0/C1 control chars in one pass.
 * Pure ASCII code-point checks — no fragile regex escapes.
 *   - zero-width / bidi-override / BOM (U+200B..200F, 202A..202E, 2060..206F,
 *     FEFF) are removed; they smuggle text past humans and models alike.
 *   - control chars (except tab, LF, CR) collapse to a space.
 */
function stripUnsafeChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x206f) ||
      c === 0xfeff
    ) {
      continue;
    }
    const isControl =
      c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || (c >= 0x7f && c <= 0x9f);
    out += isControl ? ' ' : ch;
  }
  return out;
}

/**
 * Neutralize instruction-like content in untrusted page text before it enters
 * an LLM prompt. Pure. Legitimate field labels are returned unchanged.
 */
export function sanitizeUntrusted(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) return '';

  let out = stripUnsafeChars(text);
  out = out.replace(MARKER_RE, ' ');
  for (const re of INJECTION_PATTERNS) out = out.replace(re, REDACTION);
  // Collapse the whitespace that stripping/redaction introduced.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  if (out.length > MAX_UNTRUSTED_LEN) out = out.slice(0, MAX_UNTRUSTED_LEN);
  return out.trim();
}

/**
 * Sanitize `text` and fence it between the untrusted-data markers, ready to
 * drop into a prompt as clearly-delimited DATA.
 */
export function wrapUntrusted(text: unknown): string {
  return `${UNTRUSTED_OPEN}\n${sanitizeUntrusted(text)}\n${UNTRUSTED_CLOSE}`;
}
