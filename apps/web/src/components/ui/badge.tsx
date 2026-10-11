import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-raised text-muted',
        error: 'border-error/40 bg-error/10 text-error',
        success: 'border-success/40 bg-success/10 text-success',
        read: 'border-cache-read/40 bg-cache-read/10 text-cache-read',
        write: 'border-cache-write/40 bg-cache-write/10 text-cache-write',
        uncached: 'border-uncached/40 bg-uncached/10 text-uncached',
        output: 'border-output/40 bg-output/10 text-output',
        outline: 'border-border text-fg',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, tone, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ tone }), className)} {...props} />
);
