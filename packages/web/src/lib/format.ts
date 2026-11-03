import type { ApplicationStatus } from '@apply-fleet/shared';

/** Compact relative time: "just now", "18m", "2h", "1d". */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** One- or two-letter monogram from a company name. */
export function monogram(company: string): string {
  const words = company.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  // Single word: use internal capitals (DoorDash -> DD) else first letter.
  const caps = company.replace(/[^A-Z]/g, '');
  if (caps.length >= 2) return caps.slice(0, 2);
  return company.slice(0, 1).toUpperCase();
}

/** Deterministic muted hue for a company monogram tile. */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export const STATUS_META: Record<
  ApplicationStatus,
  { label: string; color: string; active: boolean }
> = {
  queued: { label: 'Queued', color: 'var(--color-faint)', active: false },
  tailoring: { label: 'Tailoring résumé', color: 'var(--color-violet)', active: true },
  filling: { label: 'Filling', color: 'var(--color-blue)', active: true },
  needs_you: { label: 'Needs you', color: 'var(--color-amber)', active: false },
  ready: { label: 'Ready', color: 'var(--color-accent)', active: false },
  submitting: { label: 'Submitting', color: 'var(--color-blue)', active: true },
  submitted: { label: 'Applied', color: 'var(--color-dim)', active: false },
  failed: { label: 'Failed', color: 'var(--color-red)', active: false },
};

export const SOURCE_LABEL: Record<string, string> = {
  profile: 'profile',
  answers: 'answers.yml',
  vault: 'vault',
  llm: 'model',
  you: 'you',
};
