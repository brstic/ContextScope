import { forwardRef, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/** Tables scroll inside their own wrapper, never the page. */
export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement> & { wrapperClassName?: string }>(
  ({ className, wrapperClassName, ...props }, ref) => (
    <div className={cn('w-full max-w-full overflow-x-auto', wrapperClassName)}>
      <table ref={ref} className={cn('w-full border-collapse text-[12px]', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

export const THead = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('bg-panel', className)} {...props} />
);
export const TBody = (props: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />;

export const Tr = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr ref={ref} className={cn('border-b border-border last:border-b-0', className)} {...props} />
  ),
);
Tr.displayName = 'Tr';

export const Th = ({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    className={cn(
      'h-8 whitespace-nowrap border-b border-border px-2.5 text-left text-[12px] font-medium text-muted',
      className,
    )}
    {...props}
  />
);

export const Td = ({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('h-8 whitespace-nowrap px-2.5 align-middle', className)} {...props} />
);
