/**
 * Extract the confirm/verify/activation link from an inbound email — but only
 * if it points at a domain we actually applied to this session.
 *
 * Security gate first: we NEVER return a link whose host is outside
 * `appliedDomains`, even if it reads exactly like a verification link.
 * Auto-opening a link is an action taken on the user's behalf, so it is scoped
 * to the ATS domains we submitted to — a spoofed "verify your account" mail
 * from an unknown host, or a look-alike like `greenhouse.io.evil.com`, can
 * never be auto-followed. Links must also be https. Only after that gate do we
 * pick, among in-scope links, the one that reads as a verification link.
 */
const VERIFY_HINT = /verif|confirm|activat/i;

/** Host of an https URL, lowercased; null for non-https or unparseable URLs. */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Exact domain or a subdomain of it — never a suffix-spoof (`d.evil.com`). */
function withinApplied(host: string, appliedDomains: string[]): boolean {
  return appliedDomains.some((d) => {
    const base = d.trim().toLowerCase();
    return base.length > 0 && (host === base || host.endsWith(`.${base}`));
  });
}

interface Candidate {
  url: string;
  /** anchor text / surrounding words — a second place to spot a verify link. */
  context: string;
}

function candidatesFromHtml(html: string): Candidate[] {
  const out: Candidate[] = [];
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    out.push({ url: m[1], context: m[2].replace(/<[^>]+>/g, ' ') });
  }
  return out;
}

function candidatesFromText(text: string): Candidate[] {
  const out: Candidate[] = [];
  const link = /https?:\/\/[^\s<>"')\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = link.exec(text)) !== null) {
    const start = Math.max(0, m.index - 48);
    out.push({ url: m[0], context: text.slice(start, m.index) });
  }
  return out;
}

export function extractVerifyLink(
  message: { subject?: string; html?: string | null; text?: string | null },
  appliedDomains: string[],
): string | null {
  const seen = new Set<string>();
  const candidates = [
    ...candidatesFromHtml(message.html ?? ''),
    ...candidatesFromText(message.text ?? ''),
  ].filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  // Security gate: keep only https links to a domain we applied to.
  const inScope = candidates.filter((c) => {
    const host = hostOf(c.url);
    return host !== null && withinApplied(host, appliedDomains);
  });
  if (inScope.length === 0) return null;

  // Prefer a link that itself reads as a verification link.
  const hinted = inScope.find(
    (c) => VERIFY_HINT.test(c.url) || VERIFY_HINT.test(c.context),
  );
  if (hinted) return hinted.url;

  // Otherwise commit only if the message is unambiguously a verify mail and
  // there is exactly one in-scope link to follow — never guess among many.
  if (VERIFY_HINT.test(message.subject ?? '') && inScope.length === 1) {
    return inScope[0].url;
  }
  return null;
}
