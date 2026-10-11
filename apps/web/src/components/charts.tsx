import type { ReactElement, ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';
import { formatTokens } from '../lib/format';

/** Shared chart styling. Colours come from CSS variables so both themes work. */
export const axisProps = {
  stroke: 'var(--border)',
  tick: { fill: 'var(--muted)', fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: 'var(--border)' },
} as const;

export const gridProps = { stroke: 'var(--border)', strokeDasharray: '2 4', vertical: false } as const;

export const tooltipProps = {
  contentStyle: {
    background: 'var(--raised)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontSize: 12,
    color: 'var(--text)',
  },
  labelStyle: { color: 'var(--muted)' },
  itemStyle: { color: 'var(--text)', padding: 0 },
  cursor: { fill: 'var(--raised)', opacity: 0.5 },
} as const;

export const tokenTick = (v: number) => formatTokens(v);

/** Accessible chart frame: a titled figure with a fixed-height responsive container. */
export const ChartFrame = ({
  title,
  height = 200,
  children,
  summary,
}: {
  title: string;
  height?: number;
  children: ReactElement;
  summary?: string;
}) => (
  <figure className="min-w-0" aria-label={title}>
    <figcaption className="sr-only">
      {title}
      {summary ? `. ${summary}` : ''}
    </figcaption>
    <div style={{ height }} className="w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        {children}
      </ResponsiveContainer>
    </div>
  </figure>
);

export const LegendDot = ({ color, label }: { color: string; label: string }) => (
  <span className="inline-flex items-center gap-1 text-[11px] text-muted">
    <span className="inline-block size-2 rounded-[2px]" style={{ backgroundColor: color }} />
    {label}
  </span>
);

/** Horizontal proportional bars without recharts — crisp, dense, accessible. */
export const HBarList = ({
  rows,
  color = 'var(--muted)',
  format,
  title,
}: {
  rows: { key: string; label: ReactNode; value: number; sub?: ReactNode; color?: string }[];
  color?: string;
  format: (v: number) => string;
  title: string;
}) => {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-[12px] text-muted">No data in this range.</p>;
  return (
    <ul aria-label={title} className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-[12px]">
          <span className="min-w-0 truncate">{r.label}</span>
          <span className="num text-fg">{format(r.value)}</span>
          <span className="col-span-2 h-1.5 overflow-hidden rounded-[2px] bg-raised">
            <span
              className="block h-full rounded-[2px]"
              style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%`, backgroundColor: r.color ?? color }}
            />
          </span>
          {r.sub ? <span className="col-span-2 text-[11px] text-muted">{r.sub}</span> : null}
        </li>
      ))}
    </ul>
  );
};
