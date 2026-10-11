import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

/** Radix Select cannot hold an empty value, so "any" is mapped to this sentinel. */
const ANY = '__any__';

export const Select = ({
  value,
  onValueChange,
  options,
  label,
  placeholder,
  anyLabel,
  className,
  id,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: SelectOption[];
  /** Accessible label (visually hidden when not rendered separately). */
  label: string;
  placeholder?: string;
  /** When set, adds an option that maps to the empty string. */
  anyLabel?: string;
  className?: string;
  id?: string;
}) => (
  <SelectPrimitive.Root
    value={value === '' && anyLabel ? ANY : value || undefined}
    onValueChange={(v) => onValueChange(v === ANY ? '' : v)}
  >
    <SelectPrimitive.Trigger
      id={id}
      aria-label={label}
      className={cn(
        'inline-flex h-8 min-w-0 items-center justify-between gap-2 rounded-[4px] border border-border bg-panel px-2 text-[13px] text-fg hover:bg-raised focus-visible:outline-2 focus-visible:outline-ring data-[placeholder]:text-muted',
        className,
      )}
    >
      <span className="truncate">
        <SelectPrimitive.Value placeholder={placeholder ?? label} />
      </span>
      <SelectPrimitive.Icon>
        <ChevronDown className="size-3.5 text-muted" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className="z-50 max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[6px] border border-border bg-panel text-fg shadow-lg"
      >
        <SelectPrimitive.Viewport className="p-1">
          {anyLabel ? <Item value={ANY} label={anyLabel} /> : null}
          {options.map((o) => (
            <Item key={o.value} value={o.value} label={o.label} />
          ))}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>
);

const Item = ({ value, label }: { value: string; label: string }) => (
  <SelectPrimitive.Item
    value={value}
    className="relative flex h-7 cursor-default select-none items-center rounded-[4px] pl-6 pr-2 text-[13px] outline-none data-[highlighted]:bg-raised"
  >
    <SelectPrimitive.ItemIndicator className="absolute left-1.5">
      <Check className="size-3.5" />
    </SelectPrimitive.ItemIndicator>
    <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
);
