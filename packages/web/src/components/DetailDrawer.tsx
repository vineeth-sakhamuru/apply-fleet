import { useState } from 'react';
import { Drawer } from 'vaul';
import {
  IconArrowUpRight,
  IconExternalLink,
  IconFileText,
  IconCheck,
} from '@tabler/icons-react';
import type { Application, FieldSource, ResolvedField } from '@apply-fleet/shared';
import { relativeTime, STATUS_META, SOURCE_LABEL } from '../lib/format';
import { Monogram, AtsBadge, SourceChip, SOURCE_HUE } from './primitives';
import { useStore } from '../store';
import { API } from '../api';

/**
 * The real, fully-filled form as the worker left it — the review surface before
 * an irreversible submit. A field/value list can't show a missed required field
 * or a value the page's own JS reset; the rendered form can. 404s until the
 * worker has written a preview, so it hides itself rather than showing a
 * broken image.
 */
function FormPreview({ app }: { app: Application }) {
  const [available, setAvailable] = useState(true);
  const src = `${API}/api/preview?id=${encodeURIComponent(app.id)}`;
  if (!available) return null;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-faint">
          Filled form
        </div>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-[11px] text-dim transition-colors hover:text-text"
        >
          full size
          <IconExternalLink size={12} stroke={1.8} />
        </a>
      </div>
      <div className="max-h-[440px] overflow-y-auto rounded-lg border border-border bg-white">
        <img
          src={src}
          alt={`${app.company} application form, filled`}
          onError={() => setAvailable(false)}
          className="block w-full"
        />
      </div>
    </div>
  );
}

/**
 * Written, not grounded: an answer the model drafted, or one you typed at a HITL
 * prompt. Everything else was copied out of profile.yml / answers.yml / the
 * vault and is reproducible without a model.
 */
const isDrafted = (f: ResolvedField) => f.source === 'llm' || f.source === 'you';

/**
 * Provenance review, above the field list.
 *
 * `Fields` treats all ten fields as peers, so the one paragraph a model wrote
 * sits in the same visual weight as your own email address — and it's truncated,
 * which is exactly backwards: the generated prose is the part that needs
 * reading before an irreversible submit. This pulls those out, shows them in
 * full, and states plainly how much of the form needed no model at all.
 */
function AnswerReview({ app }: { app: Application }) {
  const fields = app.fields ?? [];
  if (!fields.length) return null;

  const drafted = fields.filter(isDrafted);
  const counts = new Map<FieldSource, number>();
  for (const f of fields) {
    if (!isDrafted(f)) counts.set(f.source, (counts.get(f.source) ?? 0) + 1);
  }

  if (!drafted.length) {
    return (
      <div className="rounded-lg border border-border bg-surface/40 px-3 py-2 text-[12px] text-dim">
        Nothing was drafted — all {fields.length} fields came straight from your
        own config.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-faint">
          Drafted answers
        </div>
        <div className="font-mono text-[11px] tabular-nums text-dim">
          {drafted.length} of {fields.length}
        </div>
      </div>
      <div className="space-y-1.5">
        {drafted.map((f, i) => (
          <div
            key={i}
            className="rounded-lg border border-l-2 border-border bg-surface/40 px-3 py-2"
            style={{ borderLeftColor: `oklch(0.7 0.11 ${SOURCE_HUE[f.source]})` }}
          >
            <div className="flex items-start justify-between gap-3">
              {/* Real specs do carry the odd unlabelled control (a bare file
                  input). Say so rather than rendering a blank line. */}
              <div className="min-w-0 text-[12px] text-dim">
                {f.label || '(unlabelled field)'}
              </div>
              <div className="shrink-0">
                <SourceChip source={f.source} />
              </div>
            </div>
            <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-text">
              {f.value}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 font-mono text-[10.5px] text-faint">
        {fields.length - drafted.length} grounded
        {[...counts].map(([s, n]) => ` · ${SOURCE_LABEL[s]} ${n}`).join('')}
      </div>
    </div>
  );
}

function Fields({ app }: { app: Application }) {
  if (!app.fields?.length) return null;
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">
        Filled fields
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {app.fields.map((f, i) => (
          <div
            key={i}
            className="flex items-start justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-[12px] text-dim">{f.label}</div>
              <div className="mt-0.5 truncate text-[13px] text-text">
                {f.value}
              </div>
            </div>
            <div className="mt-0.5 shrink-0">
              <SourceChip source={f.source} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Footer({ app }: { app: Application }) {
  const submit = useStore((s) => s.submit);
  const answerHitl = useStore((s) => s.answerHitl);
  const select = useStore((s) => s.select);
  const [answer, setAnswer] = useState('');

  if (app.status === 'ready') {
    return (
      <button
        onClick={() => {
          submit(app.id);
          select(null);
        }}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent py-2.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
      >
        <IconArrowUpRight size={15} stroke={2.2} />
        Submit application
      </button>
    );
  }

  if (app.status === 'needs_you' && app.hitl?.severity === 'quick') {
    return (
      <div>
        <div className="mb-2 text-[13px] text-text">{app.hitl.question}</div>
        <div className="flex gap-2">
          <input
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && answer.trim()) {
                answerHitl(app.id, answer.trim());
                select(null);
              }
            }}
            placeholder="Your answer…"
            className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-[13px] text-text outline-none placeholder:text-faint focus:border-border-strong"
          />
          <button
            disabled={!answer.trim()}
            onClick={() => {
              answerHitl(app.id, answer.trim());
              select(null);
            }}
            className="rounded-md bg-accent px-3.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  if (app.status === 'needs_you' && app.hitl?.severity === 'attention') {
    return (
      <div>
        <div className="mb-2 text-[13px] text-text">{app.hitl.question}</div>
        <button
          onClick={() => {
            answerHitl(app.id, 'Completed in Safari');
            select(null);
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border py-2.5 text-[13px] transition-colors hover:border-border-strong"
          style={{ color: 'var(--color-amber)' }}
        >
          <IconExternalLink size={15} stroke={1.9} />
          Open in Safari to finish
        </button>
      </div>
    );
  }

  if (app.status === 'submitted') {
    return (
      <div className="flex items-center justify-center gap-1.5 rounded-md border border-border py-2.5 text-[13px] text-dim">
        <IconCheck size={15} stroke={2} style={{ color: 'var(--color-accent)' }} />
        Application submitted
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border py-2.5 text-center text-[12px] text-faint">
      Worker is {STATUS_META[app.status].label.toLowerCase()} — nothing needed from you
    </div>
  );
}

export function DetailDrawer() {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const app = useStore((s) => s.apps.find((a) => a.id === s.selectedId));

  return (
    <Drawer.Root
      direction="right"
      open={!!selectedId}
      onOpenChange={(o) => !o && select(null)}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/55" />
        <Drawer.Content
          aria-describedby={undefined}
          className="fixed bottom-0 right-0 top-0 z-50 flex w-[440px] flex-col border-l border-border bg-panel outline-none"
        >
          {app && (
            <>
              <div className="border-b border-border p-5">
                <div className="flex items-start gap-3">
                  <Monogram company={app.company} size={40} />
                  <div className="min-w-0 flex-1">
                    <Drawer.Title className="truncate text-[15px] font-medium text-text">
                      {app.company}
                    </Drawer.Title>
                    <div className="truncate text-[12.5px] text-dim">
                      {app.role}
                    </div>
                    <div className="mt-1 truncate text-[12px] text-faint">
                      {app.location}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <AtsBadge ats={app.ats} />
                  <span className="font-mono text-[11px] text-dim tabular-nums">
                    {app.matchScore} match
                  </span>
                  <span className="font-mono text-[11px] text-faint tabular-nums">
                    posted {relativeTime(app.postedAt)} ago
                  </span>
                  <a
                    href={app.applyUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="ml-auto flex items-center gap-1 text-[11px] text-dim transition-colors hover:text-text"
                  >
                    posting
                    <IconExternalLink size={12} stroke={1.8} />
                  </a>
                </div>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                {app.resumeVariant && (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/40 px-3 py-2.5">
                    <IconFileText size={16} stroke={1.7} className="text-dim" />
                    <span className="text-[12.5px] text-text">
                      Résumé tailored
                    </span>
                    <span className="ml-auto font-mono text-[11px] text-dim">
                      {app.resumeVariant}.pdf
                    </span>
                  </div>
                )}
                <FormPreview app={app} />
                <AnswerReview app={app} />
                <Fields app={app} />
              </div>

              <div className="border-t border-border p-5">
                <Footer app={app} />
              </div>
            </>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
