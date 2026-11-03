import { readdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Config YAML (profile/answers/resume) carries PII. On a shared box a
 * group/world-readable copy leaks it. Warn (never throw — a warning must not
 * take the app down) for each real `*.yml`/`*.yaml` in `dir` whose mode grants
 * any group/other access. `*.example.*` templates are skipped (no PII, and git
 * checks them out 0644 anyway). Returns the offending paths so a caller can act.
 */
export function assertConfigPerms(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no config dir → nothing to guard
  }

  const loose: string[] = [];
  for (const n of names) {
    if (!/\.ya?ml$/i.test(n) || n.includes('.example.')) continue;
    const path = join(dir, n);
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      loose.push(path);
      console.warn(
        `config perms: ${path} is group/world-accessible (mode ${mode.toString(8)}); run chmod 600`,
      );
    }
  }
  return loose;
}

/** Lock a file to 0600 (owner read/write only). */
export function lockFile(path: string): void {
  chmodSync(path, 0o600);
}
