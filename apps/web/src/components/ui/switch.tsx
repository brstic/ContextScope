import * as SwitchPrimitive from '@radix-ui/react-switch';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/utils';

export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-border bg-raised transition-colors data-[state=checked]:bg-fg focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block size-3 translate-x-0.5 rounded-full bg-muted transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-bg" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
