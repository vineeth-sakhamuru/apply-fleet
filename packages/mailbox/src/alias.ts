import { createHash } from 'node:crypto';

/**
 * Per-application Gmail plus-alias. Every application gets a distinct reply-to
 * address of the form `local+<hash>@domain`, where <hash> is a short, stable
 * digest of the applicationId. Same id ⇒ same alias (deterministic), so an
 * inbound reply maps back to exactly one application with no fuzzy subject/
 * timestamp matching. Gmail routes everything after `+` to the base inbox, so
 * no per-alias mailbox setup is needed.
 *
 * This hashes the id (opaque, fixed-width) rather than embedding it raw, so an
 * alias never leaks the internal id format and is always a valid local-part.
 * Recovering the id from an alias is therefore a table lookup, not a regex.
 * (@apply-fleet/tracking ships a raw-id variant of aliasFor; the two schemes
 * are intentionally different — see the mailbox report for consolidation notes.)
 */
export function aliasFor(baseAddress: string, applicationId: string): string {
  const at = baseAddress.lastIndexOf('@');
  const local = baseAddress.slice(0, at);
  const domain = baseAddress.slice(at + 1);
  if (at < 1 || !local || !domain) {
    throw new Error(`invalid base address: ${baseAddress}`);
  }
  // ponytail: 10 hex chars of sha256. Collision-safe at personal apply volume;
  // widen the slice if this ever fronts a multi-tenant address space.
  const hash = createHash('sha256').update(applicationId).digest('hex').slice(0, 10);
  return `${local}+${hash}@${domain}`;
}
