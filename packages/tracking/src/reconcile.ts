import { append, getApplication, type Db } from '@apply-fleet/data';
import { classify, type InboundEmail } from './ack.ts';

export interface ReconcileResult {
  matched?: string;
  kind: string;
  recorded: boolean;
}

/**
 * Reconcile an inbound email to its application via the plus-alias (the
 * deterministic match key), and record it in the event store. Returns the
 * matched application id, or no match if the alias is unknown.
 */
export async function reconcile(
  db: Db,
  email: InboundEmail,
): Promise<ReconcileResult> {
  const c = classify(email);
  if (!c.appId) return { kind: c.kind, recorded: false };

  const app = await getApplication(db, c.appId);
  if (!app) return { kind: c.kind, recorded: false };

  await append(db, {
    type: 'email.received',
    aggregate: 'email',
    aggregateId: `em_${Date.now()}_${c.appId}`,
    payload: {
      applicationId: c.appId,
      alias: email.to,
      direction: 'inbound',
      subject: email.subject,
      fromAddr: email.from,
      parsed: { kind: c.kind, ats: c.ats },
    },
  });

  return { matched: c.appId, kind: c.kind, recorded: true };
}
