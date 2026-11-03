/**
 * Mailbox reader. The inbox is read behind an injected {@link MailTransport} so
 * tests supply a fake and never touch the network; the live path uses
 * {@link imapTransport} (Gmail over IMAP + app password).
 */

/** What a transport yields per message. The transport owns `receivedAt`. */
export interface RawMessage {
  from: string;
  to: string;
  subject: string;
  html: string | null;
  text: string | null;
  /** epoch ms — from IMAP INTERNALDATE / the parsed Date header. */
  receivedAt: number;
}

/** A normalized message handed to the rest of the system. */
export interface ParsedMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  receivedAt: number;
}

/** The test seam: inject a fake in tests, imapTransport() in production. */
export interface MailTransport {
  fetchSince(sinceTs: number): Promise<RawMessage[]>;
}

/** Read messages received at or after `sinceTs` (epoch ms), oldest-first. */
export async function readInbox(
  transport: MailTransport,
  sinceTs: number,
): Promise<ParsedMessage[]> {
  const raw = await transport.fetchSince(sinceTs);
  return raw
    // IMAP SINCE is day-granular, so the transport over-fetches — re-filter to
    // the exact millisecond here.
    .filter((m) => m.receivedAt >= sinceTs)
    .map((m) => ({
      from: m.from,
      to: m.to,
      subject: m.subject,
      html: m.html ?? '',
      text: m.text ?? '',
      receivedAt: m.receivedAt,
    }))
    .sort((a, b) => a.receivedAt - b.receivedAt);
}

const GMAIL_IMAP_HOST = 'imap.gmail.com';

/**
 * Read the Gmail app password from the environment.
 *
 * ponytail: env var for now. Route this through @apply-fleet/secure (macOS
 * Keychain) once that package lands — swap this one function, callers unchanged.
 * The secret is never logged and never included in a thrown error message.
 */
export function appPasswordFromEnv(): string {
  const pass = process.env.APPLY_FLEET_GMAIL_APP_PASSWORD;
  if (!pass) {
    throw new Error(
      'APPLY_FLEET_GMAIL_APP_PASSWORD is not set — generate a Gmail App Password (see config/mailbox.example.yml).',
    );
  }
  return pass;
}

/**
 * Live Gmail IMAP transport (imap.gmail.com:993, TLS, app password). Not
 * exercised in tests — the injected fake covers reader logic. The IMAP/MIME
 * libraries load lazily (dynamic import), only when fetchSince is actually
 * called, so importing this module pulls in no heavy deps and does no I/O.
 */
export function imapTransport(opts: {
  host?: string;
  user: string;
  appPassword: string;
}): MailTransport {
  const host = opts.host ?? GMAIL_IMAP_HOST;
  return {
    async fetchSince(sinceTs: number): Promise<RawMessage[]> {
      const { ImapFlow } = await import('imapflow');
      const { simpleParser } = await import('mailparser');
      const client = new ImapFlow({
        host,
        port: 993,
        secure: true,
        auth: { user: opts.user, pass: opts.appPassword },
        logger: false, // never log — the auth object carries the app password
      });
      await client.connect();
      const out: RawMessage[] = [];
      try {
        const lock = await client.getMailboxLock('INBOX');
        try {
          for await (const msg of client.fetch(
            { since: new Date(sinceTs) },
            { source: true, internalDate: true },
          )) {
            const parsed = await simpleParser(msg.source);
            const to = parsed.to;
            const toText = Array.isArray(to)
              ? to.map((a) => a.text).join(', ')
              : to?.text ?? '';
            const when = parsed.date ?? msg.internalDate ?? new Date(0);
            out.push({
              from: parsed.from?.text ?? '',
              to: toText,
              subject: parsed.subject ?? '',
              html: typeof parsed.html === 'string' ? parsed.html : null,
              text: parsed.text ?? null,
              receivedAt: when.getTime(),
            });
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
      return out;
    },
  };
}

/** Convenience: build the Gmail transport with the app password from env. */
export function imapTransportFromEnv(opts: {
  host?: string;
  user: string;
}): MailTransport {
  return imapTransport({ ...opts, appPassword: appPasswordFromEnv() });
}
