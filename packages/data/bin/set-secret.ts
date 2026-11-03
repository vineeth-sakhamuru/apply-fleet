import { setSecret } from '../src/index.ts';

/**
 * Store a secret in the macOS Keychain without it touching shell history:
 *   echo -n "gsk_..." | node bin/set-secret.ts groq-api-key
 */
const account = process.argv[2];
if (!account) {
  console.error('usage: node bin/set-secret.ts <account>   (value read from stdin)');
  process.exit(1);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const value = Buffer.concat(chunks).toString('utf8').trim();

if (!value) {
  console.error('no value on stdin');
  process.exit(1);
}

setSecret(account, value);
console.log(`stored "${account}" in Keychain (${value.length} chars)`);
