import type { ApplicationStatus, Ats, FieldSource } from '@apply-fleet/shared';
import { ATS_LABEL } from '@apply-fleet/shared';
import { hueFor, monogram, STATUS_META, SOURCE_LABEL } from '../lib/format';

export function Monogram({
  company,
  size = 30,
}: {
  company: string;
  size?: number;
}) {
  const h = hueFor(company);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[7px] font-mono font-medium"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        color: `oklch(0.86 0.05 ${h})`,
        background: `oklch(0.29 0.045 ${h})`,
        border: `1px solid oklch(0.42 0.06 ${h} / 0.45)`,
      }}
    >
      {monogram(company)}
    </div>
  );
}

export function StatusDot({
  status,
  ring = false,
}: {
  status: ApplicationStatus;
  ring?: boolean;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-block rounded-full ${meta.active ? 'dot-pulse' : ''} ${
        ring && meta.active ? 'ring-pulse' : ''
      }`}
      style={{ width: 7, height: 7, background: meta.color, color: meta.color }}
    />
  );
}

export function AtsBadge({ ats }: { ats: Ats }) {
  return (
    <span className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-faint">
      {ATS_LABEL[ats]}
    </span>
  );
}

export const SOURCE_HUE: Record<FieldSource, number> = {
  profile: 244,
  answers: 292,
  vault: 162,
  llm: 265,
  you: 79,
};

export function SourceChip({ source }: { source: FieldSource }) {
  const h = SOURCE_HUE[source];
  return (
    <span
      className="rounded px-1.5 py-px font-mono text-[10px]"
      style={{
        color: `oklch(0.8 0.06 ${h})`,
        background: `oklch(0.3 0.04 ${h} / 0.55)`,
      }}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}
