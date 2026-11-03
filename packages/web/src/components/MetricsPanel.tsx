import { IconAlertTriangle } from '@tabler/icons-react';
import { ATS_LABEL, type Ats } from '@apply-fleet/shared';
import { useStore } from '../store';
import type { AtsStat, BreakerStat } from '../store';

/**
 * Fleet health in one strip: how well each ATS family actually fills, and which
 * domains are currently circuit-broken.
 *
 * The per-status counts in the top bar say what the queue looks like now; they
 * can't say "Workday takes 40 postings and yields two applications". Fill rate
 * is the number that tells you where the fleet is structurally weak, and the
 * open circuits explain why a family's rate just fell off.
 *
 * Hides itself whenever there is nothing real to report — demo mode, an
 * orchestrator without /api/metrics, or an empty event store. A zeroed panel
 * would read as "the fleet fills nothing", which is a different claim.
 */

/** Fill rate reads as a status, not a call to action: mint when the family is
 *  filling, amber when it's half-working, red when it's effectively dead. */
function rateColor(rate: number): string {
  if (rate >= 0.66) return 'var(--color-accent)';
  if (rate >= 0.33) return 'var(--color-amber)';
  return 'var(--color-red)';
}

/** The server reports the stored ATS key, which can outrun the `Ats` union. */
const atsLabel = (ats: string): string => ATS_LABEL[ats as Ats] ?? ats;

function cooldown(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
}

function AtsBar({ stat }: { stat: AtsStat }) {
  const pct = Math.round(stat.fillRate * 100);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      title={`${atsLabel(stat.ats)} · ${stat.ready + stat.submitted} of ${stat.total} filled · ${stat.needsYou} need you · ${stat.failed} failed`}
    >
      <span className="text-[11.5px] text-dim">{atsLabel(stat.ats)}</span>
      <span className="h-1 w-[42px] overflow-hidden rounded-full bg-surface">
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, background: rateColor(stat.fillRate) }}
        />
      </span>
      <span className="font-mono text-[11px] tabular-nums text-text">{pct}%</span>
      <span className="font-mono text-[11px] tabular-nums text-faint">
        /{stat.total}
      </span>
    </div>
  );
}

function OpenBreakers({ open }: { open: BreakerStat[] }) {
  return (
    <div className="flex h-8 items-center gap-2 border-t border-border px-5">
      <IconAlertTriangle
        size={13}
        stroke={1.9}
        style={{ color: 'var(--color-amber)' }}
      />
      <span className="text-[11.5px]" style={{ color: 'var(--color-amber)' }}>
        {open.length === 1 ? '1 circuit open' : `${open.length} circuits open`}
      </span>
      <span className="text-[11.5px] text-faint">
        — work paused on these domains; their applications stay queued
      </span>
      <span className="ml-auto flex min-w-0 items-center gap-3 overflow-x-auto font-mono text-[11px]">
        {open.slice(0, 3).map((b) => (
          <span key={b.domain} className="shrink-0 text-dim">
            {b.domain}
            <span className="text-faint"> {cooldown(b.opensInMs)}</span>
          </span>
        ))}
        {open.length > 3 && (
          <span className="shrink-0 text-faint">+{open.length - 3}</span>
        )}
      </span>
    </div>
  );
}

export function MetricsPanel() {
  const metrics = useStore((s) => s.metrics);
  const view = useStore((s) => s.view);

  // Settings and the reply log are not operational surfaces.
  if (!metrics || view === 'settings' || view === 'replies') return null;

  const open = metrics.breakers.filter((b) => b.open);
  // Already sorted by volume server-side; cap it so the strip stays one line.
  const ats = metrics.ats.slice(0, 6);
  if (!ats.length && !open.length) return null;

  return (
    <div className="shrink-0 border-b border-border bg-bg">
      {ats.length > 0 && (
        <div className="flex h-9 items-center gap-3 px-5">
          <span className="shrink-0 text-[11px] uppercase tracking-wider text-faint">
            Fill rate
          </span>
          <div className="flex min-w-0 items-center gap-3.5 overflow-x-auto">
            {ats.map((s) => (
              <AtsBar key={s.ats} stat={s} />
            ))}
            {metrics.ats.length > ats.length && (
              <span className="shrink-0 font-mono text-[11px] text-faint">
                +{metrics.ats.length - ats.length}
              </span>
            )}
          </div>
        </div>
      )}
      {open.length > 0 && <OpenBreakers open={open} />}
    </div>
  );
}
