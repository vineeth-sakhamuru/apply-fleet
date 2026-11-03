/**
 * Per-application Gmail plus-alias — the deterministic 1:1 match key.
 * We apply as `app+<appId>@<system-gmail>`; any reply lands on that alias, so
 * the application is identified exactly, with no fuzzy subject/timestamp matching.
 */
export function aliasFor(baseEmail: string, appId: string): string {
  const [user, domain] = baseEmail.split('@');
  if (!user || !domain) throw new Error(`invalid base email: ${baseEmail}`);
  return `${user}+${appId}@${domain}`;
}

/** Recover the application id from a plus-aliased address, if present. */
export function appIdFromAddress(address: string): string | undefined {
  const m = address.trim().toLowerCase().match(/\+([^@\s]+)@/);
  return m ? m[1] : undefined;
}
