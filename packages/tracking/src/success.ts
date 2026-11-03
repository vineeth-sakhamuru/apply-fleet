/**
 * Submit-time success signal. Silence never means "submitted", so at submit we
 * classify the resulting page/response: only an explicit confirmation counts.
 */
export function classifySubmitOutcome(o: {
  httpStatus?: number;
  url?: string;
  bodyText?: string;
}): 'submitted' | 'unknown' | 'failed' {
  const t = (o.bodyText ?? '').toLowerCase();
  const u = (o.url ?? '').toLowerCase();

  const confirmed =
    /thank you for applying|application (received|submitted)|we('| ha)ve received your application|successfully submitted|thanks for applying/.test(t) ||
    /confirmation|thank-you|thankyou|submitted|success|complete/.test(u);
  if (confirmed) return 'submitted';

  if (typeof o.httpStatus === 'number' && o.httpStatus >= 400) return 'failed';
  return 'unknown';
}
