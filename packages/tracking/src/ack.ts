import { appIdFromAddress } from './alias.ts';

export type EmailKind = 'ack' | 'verify' | 'reject' | 'interview' | 'other';

export interface InboundEmail {
  /** The plus-aliased address it was sent to. */
  to: string;
  from: string;
  subject: string;
  body: string;
  links?: string[];
}

export interface Classification {
  kind: EmailKind;
  appId?: string;
  ats?: string;
  links: string[];
}

function detectAts(from: string): string | undefined {
  const host = (from.split('@')[1] ?? '').toLowerCase();
  if (host.includes('greenhouse')) return 'greenhouse';
  if (host.includes('lever')) return 'lever';
  if (host.includes('ashby')) return 'ashby';
  if (host.includes('workday') || host.includes('myworkday')) return 'workday';
  return undefined;
}

/** Classify an inbound email and recover which application it belongs to. */
export function classify(email: InboundEmail): Classification {
  const appId = appIdFromAddress(email.to);
  const ats = detectAts(email.from);
  const s = `${email.subject}\n${email.body}`.toLowerCase();

  let kind: EmailKind = 'other';
  if (/verify (your )?email|confirm your email|verification (link|code)|activate your account/.test(s)) {
    kind = 'verify';
  } else if (/thank you for applying|thanks for applying|application (has been )?(received|submitted)|received your application|we('| ha)ve received your application/.test(s)) {
    kind = 'ack';
  } else if (/unfortunately|not (moving|move) forward|decided (not )?to (move|proceed)|other candidates|regret to inform|will not be moving/.test(s)) {
    kind = 'reject';
  } else if (/schedule (a|your)|interview|next steps|phone screen|technical screen|your availability/.test(s)) {
    kind = 'interview';
  }

  return { kind, appId, ats, links: email.links ?? [] };
}
