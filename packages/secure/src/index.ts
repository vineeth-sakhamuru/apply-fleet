/**
 * @apply-fleet/secure — the base security layer. Zero workspace deps so any
 * package (data, worker, orchestrator) can depend on it without a cycle.
 *   - loadSecret: env → Keychain → file, never logged.
 *   - redact / safeLog: strip PII + credentials before logs / model prompts.
 *   - assertConfigPerms / lockFile: keep PII config off group/world-read.
 */
export { loadSecret } from './secret.ts';
export { redact, redactString, safeLog } from './redact.ts';
export { assertConfigPerms, lockFile } from './config-perms.ts';
