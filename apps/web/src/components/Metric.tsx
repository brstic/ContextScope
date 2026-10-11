import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export const Metric = ({
  label,
  value,
  sub,
  accent,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** CSS colour for the left rule; signal colours only when the metric is that signal. */
  accent?: string;
  className?: string;
}) => (
  <div
    className={cn('min-w-0 rounded-[6px] border border-border bg-panel px-3 py-2.5', className)}
    style={accent ? { boxShadow: `inset 2px 0 0 ${accent}` } : undefined}
  >
    <div className="truncate text-[12px] text-muted">{label}</div>
    <div className="num mt-1 truncate text-[19px] font-semibold leading-6 text-fg">{value}</div>
    {sub ? <div className="mt-0.5 text-[11px] text-muted">{sub}</div> : null}
  </div>
);

export const MetricGrid = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8', className)}>
    {children}
  </div>
);
