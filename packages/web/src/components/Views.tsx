import type * as React from 'react';
import { useStore } from '../store';
import type { AutonomyMode, EmailRecord } from '@apply-fleet/shared';
import { relativeTime } from '../lib/format';
import { Monogram } from './primitives';

/** Classifier verdict → the same palette the status dots use. */
const KIND_HUE: Record<string, string> = {
  ack: 'var(--color-accent)',
  verify: 'var(--color-blue)',
  interview: 'var(--color-violet)',
  reject: 'var(--color-red)',
  other: 'var(--color-faint)',
};

function KindChip({ kind }: { kind: string }) {
  const color = KIND_HUE[kind] ?? KIND_HUE.other;
  return (
    <span
      className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide"
      style={{ color }}
    >
      {kind}
    </span>
  );
}

function EmailRow({ email }: { email: EmailRecord }) {
  // No joined application means the alias never resolved — say so rather than
  // guessing a company.
  const company = email.company ?? 'Unmatched';
  return (
    <div className="grid grid-cols-[30px_1fr_80px_48px] items-center gap-x-3 px-5 py-2.5">
      <Monogram company={company} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-text">{company}</span>
          {email.role && (
            <span className="truncate text-[12px] text-dim">{email.role}</span>
          )}
        </div>
        <div className="truncate text-[12px] text-dim">
          {email.subject ?? email.alias}
        </div>
      </div>
      <div className="flex justify-end">
        <KindChip kind={email.kind ?? 'other'} />
      </div>
      <div className="text-right font-mono text-[12px] tabular-nums text-faint">
        {relativeTime(email.receivedAt)}
      </div>
    </div>
  );
}

export function RepliesView() {
  const emails = useStore((s) => s.emails);

  if (!emails.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="text-[13px] text-dim">No replies yet</div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
            Recruiter emails and ATS confirmations land here once applications are
            submitted and the proxy inbox is connected
            (<span className="font-mono">APPLY_FLEET_GMAIL_APP_PASSWORD</span>).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto pb-16">
      <section>
        <div className="sticky top-0 z-10 flex h-9 items-center border-b border-border bg-bg px-5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint">
            <span>Replies · newest first</span>
            <span className="font-mono text-dim tabular-nums">
              {emails.length}
            </span>
          </div>
        </div>
        <div className="divide-y divide-border">
          {emails.map((e) => (
            <EmailRow key={e.id} email={e} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <span className="text-[12.5px] text-dim">{label}</span>
      <span className="font-mono text-[12px] text-text">{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">{title}</div>
      <div className="divide-y divide-border rounded-lg border border-border bg-panel">
        {children}
      </div>
    </section>
  );
}

export function SettingsView() {
  const mode = useStore((s) => s.mode);
  const autonomy = useStore((s) => s.autonomy);
  const setAutonomy = useStore((s) => s.setAutonomy);

  const seg = (v: AutonomyMode, label: string) => (
    <button
      onClick={() => setAutonomy(v)}
      className={`rounded-[6px] px-2.5 py-1 text-[12px] transition-colors ${
        autonomy === v ? 'bg-surface text-text' : 'text-dim hover:text-text'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <Card title="Autonomy">
          <div className="flex items-center justify-between px-3.5 py-3">
            <div>
              <div className="text-[12.5px] text-text">Submit mode</div>
              <div className="mt-0.5 text-[11.5px] text-faint">
                {autonomy === 'auto'
                  ? 'Ready apps submit hands-free (also needs the server arm flags).'
                  : 'Every application waits for your Submit click.'}
              </div>
            </div>
            <div className="flex items-center gap-1 rounded-[8px] border border-border bg-panel p-0.5">
              {seg('stage', 'Stage for review')}
              {seg('auto', 'Auto-submit')}
            </div>
          </div>
        </Card>
        <Card title="Runtime">
          <Row label="Data source" value={mode === 'live' ? 'Live orchestrator (SSE)' : 'Demo stream'} />
          <Row label="Submit gate" value="Human click + APPLY_FLEET_ARM_SUBMIT" />
          <Row label="Config" value="profile.yml · answers.yml · resume.yml" />
          <Row label="Proxy inbox" value="APPLY_FLEET_GMAIL_APP_PASSWORD" />
        </Card>
      </div>
    </div>
  );
}
