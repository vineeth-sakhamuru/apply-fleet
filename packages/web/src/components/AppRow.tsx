import type * as React from 'react';
import {
  IconArrowUpRight,
  IconCheck,
  IconRefresh,
  IconExternalLink,
} from '@tabler/icons-react';
import type { Application } from '@apply-fleet/shared';
import { relativeTime, STATUS_META } from '../lib/format';
import { Monogram, StatusDot, AtsBadge } from './primitives';
import { useStore } from '../store';

function Action({ app }: { app: Application }) {
  const submit = useStore((s) => s.submit);
  const select = useStore((s) => s.select);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  switch (app.status) {
    case 'ready':
      return (
        <button
          onClick={(e) => {
            stop(e);
            submit(app.id);
          }}
          className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        >
          <IconArrowUpRight size={13} stroke={2.2} />
          Submit
        </button>
      );
    case 'needs_you':
      return (
        <button
          onClick={(e) => {
            stop(e);
            select(app.id);
          }}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] transition-colors hover:border-border-strong"
          style={{ color: 'var(--color-amber)' }}
        >
          {app.hitl?.severity === 'attention' ? (
            <>
              <IconExternalLink size={13} stroke={1.9} />
              Open in Safari
            </>
          ) : (
            'Answer'
          )}
        </button>
      );
    case 'failed':
      return (
        <button
          onClick={stop}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] text-dim transition-colors hover:text-text"
        >
          <IconRefresh size={13} stroke={1.9} />
          Retry
        </button>
      );
    case 'submitted':
      return (
        <span className="flex items-center gap-1 text-[12px] text-dim">
          <IconCheck size={13} stroke={2} style={{ color: 'var(--color-accent)' }} />
          Applied
        </span>
      );
    default:
      return (
        <span className="font-mono text-[11px] text-faint">
          {STATUS_META[app.status].label}
        </span>
      );
  }
}

export function AppRow({ app }: { app: Application }) {
  const select = useStore((s) => s.select);
  return (
    <div
      onClick={() => select(app.id)}
      className="grid cursor-pointer grid-cols-[14px_30px_1fr_44px_48px_150px] items-center gap-x-3 px-5 py-2.5 transition-colors hover:bg-surface/50"
    >
      <StatusDot status={app.status} ring />
      <Monogram company={app.company} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-text">{app.company}</span>
          <AtsBadge ats={app.ats} />
        </div>
        <div className="truncate text-[12px] text-dim">
          {app.role} · {app.location}
        </div>
      </div>
      <div className="text-right font-mono text-[12px] tabular-nums text-dim">
        {app.matchScore}
      </div>
      <div className="text-right font-mono text-[12px] tabular-nums text-faint">
        {relativeTime(app.postedAt)}
      </div>
      <div className="flex justify-end">
        <Action app={app} />
      </div>
    </div>
  );
}
