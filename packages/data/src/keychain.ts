import { execFileSync } from 'node:child_process';

/**
 * macOS Keychain-backed secrets. No plaintext credentials in code or git.
 * Secrets (Groq/Anthropic keys, system-Gmail token, etc.) are stored under
 * one service and fetched by account name at runtime. On non-macOS this
 * throws — the cloud path will read from a secret manager / env instead.
 */
const SERVICE = 'apply-fleet';

function assertMac() {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Keychain secrets are macOS-only; use env/secret-manager off-Mac.',
    );
  }
}

export function setSecret(account: string, value: string): void {
  assertMac();
  execFileSync('security', [
    'add-generic-password',
    '-U', // update if it already exists
    '-s',
    SERVICE,
    '-a',
    account,
    '-w',
    value,
  ]);
}

export function getSecret(account: string): string | undefined {
  assertMac();
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return undefined;
  }
}

export function deleteSecret(account: string): void {
  assertMac();
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s',
      SERVICE,
      '-a',
      account,
    ]);
  } catch {
    /* already absent */
  }
}
