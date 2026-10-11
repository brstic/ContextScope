import type { ReactNode } from 'react';
import { formatTokens, formatUsd, formatMs, formatPct, UNKNOWN, UNKNOWN_HINT, isUnknown } from '../lib/format';
import { cn } from '../lib/utils';
import { Tooltip } from './ui/tooltip';

/** Unknown value: an em dash with an explanation, never 0. */
export const Unknown = ({ hint = UNKNOWN_HINT, className }: { hint?: string; className?: string }) => (
  <Tooltip content={hint}>
    <span tabIndex={0} aria-label={hint} className={cn('num cursor-help text-muted', className)}>
      {UNKNOWN}
    </span>
  </Tooltip>
);

/** Small "est." label for estimated (not provider-reported) values. */
export const Est = ({ className }: { className?: string }) => (
  <span
    title="Estimated locally, not reported by the provider"
    className={cn('ml-1 align-baseline text-[10px] font-normal text-muted', className)}
  >
    est.
  </span>
);

type Fmt = 'tokens' | 'usd' | 'ms' | 'pct' | 'int';

const fmt = (v: number, as: Fmt): string => {
  switch (as) {
    case 'usd':
      return formatUsd(v);
    case 'ms':
      return formatMs(v);
    case 'pct':
      return formatPct(v);
    case 'int':
      return v.toLocaleString('en-US');
    default:
      return formatTokens(v);
  }
};

export const Num = ({
  value,
  as = 'tokens',
  estimated,
  hint,
  className,
  suffix,
}: {
  value: number | null | undefined;
  as?: Fmt;
  estimated?: boolean;
  hint?: string;
  className?: string;
  suffix?: ReactNode;
}) => {
  if (isUnknown(value)) return <Unknown hint={hint} className={className} />;
  return (
    <span className={cn('num', className)}>
      {fmt(value, as)}
      {suffix}
      {estimated ? <Est /> : null}
    </span>
  );
};
