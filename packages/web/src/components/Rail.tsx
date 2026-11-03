import {
  IconStack2,
  IconRadar2,
  IconSend,
  IconMail,
  IconSettings,
} from '@tabler/icons-react';
import { useStore } from '../store';
import type { NavView } from '../store';

const NAV: { icon: typeof IconStack2; label: string; view: NavView }[] = [
  { icon: IconStack2, label: 'Queue', view: 'queue' },
  { icon: IconRadar2, label: 'Discovery', view: 'discovery' },
  { icon: IconSend, label: 'Applied', view: 'applied' },
  { icon: IconMail, label: 'Replies', view: 'replies' },
  { icon: IconSettings, label: 'Settings', view: 'settings' },
];

export function Rail() {
  const apps = useStore((s) => s.apps);
  const cost = useStore((s) => s.costToday);
  const llmCalls = useStore((s) => s.llmCalls);
  const workerCount = useStore((s) => s.workerCount);
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);

  const active = apps.filter((a) =>
    ['tailoring', 'filling', 'submitting'].includes(a.status),
  ).length;

  return (
    <aside className="flex w-[212px] shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-accent">
          <IconSend size={15} stroke={2.2} className="text-accent-fg" />
        </div>
        <span className="text-[13.5px] font-medium tracking-tight">
          apply-fleet
        </span>
      </div>

      <nav className="mt-1 flex flex-col gap-0.5 px-2">
        {NAV.map(({ icon: Icon, label, view: v }) => {
          const isActive = view === v;
          return (
            <button
              key={label}
              onClick={() => setView(v)}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                isActive
                  ? 'bg-surface text-text'
                  : 'text-dim hover:bg-surface/60 hover:text-text'
              }`}
            >
              <Icon size={16} stroke={1.7} />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 dot-pulse" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          <span className="text-[11px] uppercase tracking-wider text-faint">
            {mode === 'live' ? 'Fleet live' : 'Demo data'}
          </span>
        </div>
        <div className="mt-2 flex items-baseline justify-between font-mono text-[11px]">
          <span className="text-dim">
            <span className="text-text tabular-nums">{active}</span>
            <span className="text-faint">/{workerCount}</span> working
          </span>
          {/* Real model usage this run. Free-tier providers cost $0, so show
              the call count too — otherwise the row reads as "nothing happened". */}
          <span className="tabular-nums text-dim" title={`${llmCalls} model call${llmCalls === 1 ? '' : 's'} this run`}>
            {llmCalls} calls · ${cost.toFixed(2)}
          </span>
        </div>
      </div>
    </aside>
  );
}
