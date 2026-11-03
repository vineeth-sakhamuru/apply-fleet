import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve a named secret without ever logging or persisting its value.
 * Lookup order (first hit wins):
 *   1. process env — `name` verbatim, then its UPPER_SNAKE form
 *      (`groq-api-key` → `GROQ_API_KEY`). How CI / cloud inject secrets.
 *   2. macOS Keychain — `security find-generic-password -w -s apply-fleet -a <name>`,
 *      spawned; a missing entry, missing binary, or non-mac host is tolerated.
 *   3. Optional file `~/.config/apply-fleet/<name>` (should be chmod 600).
 * Returns undefined when the secret is absent everywhere. Never throws on a
 * missing secret; never writes the value anywhere.
 */
const SERVICE = 'apply-fleet';

export function loadSecret(name: string): string | undefined {
  const env = process.env[name] || process.env[envName(name)];
  if (env) return env;

  const kc = fromKeychain(name);
  if (kc) return kc;

  return fromFile(name);
}

function envName(name: string): string {
  return name.replace(/[-.]/g, '_').toUpperCase();
}

function fromKeychain(name: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-w', '-s', SERVICE, '-a', name],
      // stderr → 'ignore' so a "not found" message never reaches a log.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out || undefined;
  } catch {
    return undefined; // absent entry, or `security` binary unavailable
  }
}

function fromFile(name: string): string | undefined {
  // ponytail: name is an internal constant, not user input — no path-traversal
  // guard. Sanitize (basename) if names ever become caller-supplied.
  try {
    const v = readFileSync(join(homedir(), '.config', 'apply-fleet', name), 'utf8').trim();
    return v || undefined;
  } catch {
    return undefined; // no file → fine, this tier is optional
  }
}
