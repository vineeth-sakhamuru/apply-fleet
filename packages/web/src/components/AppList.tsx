import { motion, AnimatePresence } from 'motion/react';
import { IconBolt } from '@tabler/icons-react';
import type { Application, ApplicationStatus } from '@apply-fleet/shared';
import { useStore } from '../store';
import { AppRow } from './AppRow';

const EASE = [0.23, 1, 0.32, 1] as const;

interface Group {
  key: string;
  title: string;
  statuses: ApplicationStatus[];
  /** sort by match score instead of freshness (best-first for actionable work) */
  byScore?: boolean;
}

const GROUPS: Group[] = [
  { key: 'needs', title: 'Needs you', statuses: ['needs_you'], byScore: true },
  { key: 'ready', title: 'Ready to submit', statuses: ['ready'], byScore: true },
  { key: 'working', title: 'Working', statuses: ['tailoring', 'filling', 'submitting'] },
  { key: 'queued', title: 'Queued', statuses: ['queued'] },
  { key: 'applied', title: 'Applied', statuses: ['submitted'] },
  { key: 'failed', title: 'Needs attention', statuses: ['failed'] },
];

function sortGroup(apps: Application[], byScore?: boolean): Application[] {
  return [...apps].sort((a, b) =>
    byScore
      ? b.matchScore - a.matchScore
      : b.postedAt.localeCompare(a.postedAt),
  );
}

function SubmitAll() {
  const submitAllReady = useStore((s) => s.submitAllReady);
  const readyCount = useStore(
    (s) => s.apps.filter((a) => a.status === 'ready').length,
  );
  if (!readyCount) return null;
  return (
    <button
      onClick={submitAllReady}
      className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
    >
      <IconBolt size={13} stroke={2.2} />
      Submit all ready
    </button>
  );
}

function emptyMessage(view: string): string {
  if (view === 'discovery') return 'No roles discovered yet — the fleet is polling ATS feeds.';
  if (view === 'applied') return 'No applications submitted yet.';
  return 'Queue is clear — nothing waiting on you.';
}

const DISCOVERY_STATUSES: ApplicationStatus[] = [
  'queued', 'tailoring', 'filling', 'needs_you', 'ready', 'submitting', 'submitted', 'failed',
];

export function AppList() {
  const apps = useStore((s) => s.apps);
  const view = useStore((s) => s.view);

  const groups: Group[] =
    view === 'applied'
      ? GROUPS.filter((g) => g.key === 'applied')
      : view === 'discovery'
        ? [{ key: 'discovered', title: 'Discovered · newest first', statuses: DISCOVERY_STATUSES }]
        : GROUPS.filter((g) => g.key !== 'applied');

  const sections = groups
    .map((g) => ({
      g,
      items: sortGroup(apps.filter((a) => g.statuses.includes(a.status)), g.byScore),
    }))
    .filter((s) => s.items.length > 0);

  if (!sections.length) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-faint">
        {emptyMessage(view)}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto pb-16">
      {sections.map(({ g, items }) => {
        return (
          <section key={g.key}>
            <div className="sticky top-0 z-10 flex h-9 items-center justify-between border-b border-border bg-bg px-5">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint">
                <span>{g.title}</span>
                <span className="font-mono text-dim tabular-nums">
                  {items.length}
                </span>
              </div>
              {g.key === 'ready' && <SubmitAll />}
            </div>
            <div className="divide-y divide-border">
              <AnimatePresence initial={false}>
                {items.map((app) => (
                  <motion.div
                    key={app.id}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25, ease: EASE }}
                    style={{ position: 'relative' }}
                  >
                    <AppRow app={app} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </section>
        );
      })}
    </div>
  );
}
