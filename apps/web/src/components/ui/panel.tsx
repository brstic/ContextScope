import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

export const Panel = ({ className, ...props }: HTMLAttributes<HTMLElement>) => (
  <section className={cn('min-w-0 rounded-[6px] border border-border bg-panel', className)} {...props} />
);

export const PanelHeader = ({
  title,
  description,
  actions,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  id?: string;
}) => (
  <header
    className={cn('flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2', className)}
  >
    <div className="min-w-0">
      <h2 id={id} className="text-[13px] font-semibold text-fg">
        {title}
      </h2>
      {description ? <p className="mt-0.5 text-[12px] text-muted">{description}</p> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
  </header>
);

export const PanelBody = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-3', className)} {...props} />
);
