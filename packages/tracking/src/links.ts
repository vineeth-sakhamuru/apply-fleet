/**
 * Security-critical: decide which links in an inbound email are safe to auto-open.
 *
 * We only ever auto-click a link whose host is (a subdomain of) a domain we
 * ACTUALLY applied to in this session. A verification link from an ATS we used
 * is fine; anything else — trackers, unknown senders, phishing — is blocked and
 * left for the human. This is an allowlist, never a blocklist.
 */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function allowed(host: string, appliedHosts: Set<string>): boolean {
  for (const a of appliedHosts) {
    const base = a.toLowerCase();
    if (host === base || host.endsWith(`.${base}`)) return true;
  }
  return false;
}

/** Partition links into those safe to auto-open and those that must not be. */
export function scopeLinks(
  links: string[],
  appliedHosts: Iterable<string>,
): { safe: string[]; blocked: string[] } {
  const set = new Set([...appliedHosts].map((h) => h.toLowerCase()));
  const safe: string[] = [];
  const blocked: string[] = [];
  for (const link of links) {
    const host = hostOf(link);
    // Only https links to an applied-to host are ever safe.
    if (host && /^https:$/i.test(new URL(link).protocol) && allowed(host, set)) {
      safe.push(link);
    } else {
      blocked.push(link);
    }
  }
  return { safe, blocked };
}
