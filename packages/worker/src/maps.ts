import type { Ats } from '@apply-fleet/shared';

/**
 * Per-ATS quirks. The scanner is generic, so a map only needs the structural
 * bits that differ per ATS — for P1 that's the submit-button selector (used at
 * replay time, never clicked during prepare). Real per-field overrides land as
 * we meet each ATS on live forms.
 */
export interface AtsMap {
  id: Ats | 'unknown';
  submitSelector: string;
}

const MAPS: Partial<Record<Ats, AtsMap>> = {
  greenhouse: { id: 'greenhouse', submitSelector: '#submit_app, button[type="submit"]' },
  ashby: { id: 'ashby', submitSelector: 'button[type="submit"]' },
  lever: { id: 'lever', submitSelector: 'button[type="submit"], .postings-btn' },
};

export function pickMap(ats: Ats): AtsMap {
  return MAPS[ats] ?? { id: 'unknown', submitSelector: 'button[type="submit"]' };
}
