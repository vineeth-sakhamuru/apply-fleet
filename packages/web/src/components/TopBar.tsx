import type * as React from 'react';
import { useStore } from '../store';
import type { AutonomyMode } from '@apply-fleet/shared';

function Segment({
  value,
  current,
  onSelect,
  children,
}: {
  value: AutonomyMode;
  current: AutonomyMode;
  onSelect: (v: AutonomyMode) => void;
  children: React.ReactNode;
}) {
  const on = value === current;
  return (
    <button
      onClick={() => onSelect(value)}
      className={`rounded-[6px] px-2.5 py-1 text-[12px] transition-colors ${
        on ? 'bg-surface text-text' : 'text-dim hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const apps = useStore((s) => s.apps);
  const autonomy = useStore((s) => s.autonomy);
  const setAutonomy = useStore((s) => s.setAutonomy);

  const count = (s: string) => apps.filter((a) => a.status === s).length;
  const working =
    count('tailoring') + count('filling') + count('submitting');

  const parts = [
    { n: count('ready'), label: 'ready', hot: count('ready') > 0 },
    { n: working, label: 'working', hot: false },
    { n: count('needs_you'), label: 'need you', hot: count('needs_you') > 0 },
    { n: count('queued'), label: 'queued', hot: false },
    { n: count('submitted'), label: 'applied', hot: false },
  ];

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
      <div className="flex items-baseline gap-1.5 font-mono text-[12.5px]">
        {parts.map((p, i) => (
          <span key={p.label} className="flex items-baseline gap-1.5">
            {i > 0 && <span className="text-faint">·</span>}
            <span
              className={`tabular-nums ${
                p.hot ? 'text-accent' : 'text-text'
              }`}
            >
              {p.n}
            </span>
            <span className="text-dim">{p.label}</span>
          </span>
        ))}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1 rounded-[8px] border border-border bg-panel p-0.5">
          <Segment value="stage" current={autonomy} onSelect={setAutonomy}>
            Stage for review
          </Segment>
          <Segment value="auto" current={autonomy} onSelect={setAutonomy}>
            Auto-submit
          </Segment>
        </div>
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-dim transition-colors hover:text-text"
        >
          Search
          <span className="kbd">⌘K</span>
        </button>
      </div>
    </header>
  );
}
