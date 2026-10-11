import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const Skeleton = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div aria-hidden="true" className={cn('cs-pulse rounded-[4px] bg-raised', className)} {...props} />
);
