import type { ScopeSummary } from '@mcp-zeromem/shared';
import type { ComponentProps } from 'react';
import { OptionSelect } from '@/components/option-select';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Radix refuses an empty item value, so "every scope" travels as this and leaves as `''`. */
const EVERY = '__every_scope__';

type ScopeSelectProps = Omit<ComponentProps<typeof OptionSelect>, 'options' | 'value' | 'onValueChange'> & {
  /** From `Stats.scopes`: absent while nothing in the store is scoped. */
  scopes: readonly ScopeSummary[] | undefined;
  /** The chosen scope; `''` is every scope. */
  value: string;
  onValueChange: (scope: string) => void;
};

/**
 * Narrow a page to one scope. Draws nothing for a store with no scopes, so a
 * single-project store never shows a filter with one row in it.
 */
export function ScopeSelect({ scopes, value, onValueChange, className, ...props }: ScopeSelectProps) {
  // The unscoped turns are listed as the scope `''`, which is not one to choose.
  const named = (scopes ?? []).filter((item) => item.scope !== '');
  if (named.length === 0) {
    return null;
  }
  const options = [
    { label: 'Every scope', value: EVERY },
    { separator: true as const },
    ...named.map((item) => ({ label: `${item.scope} · ${formatCount(item.turns)} turns`, value: item.scope })),
  ];
  return (
    <OptionSelect
      aria-label="Scope"
      {...props}
      className={cn('w-64', className)}
      options={options}
      value={value || EVERY}
      onValueChange={(next) => onValueChange(next === EVERY ? '' : next)}
    />
  );
}
