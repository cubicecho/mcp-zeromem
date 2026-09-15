import type { ComponentProps, ReactNode } from 'react';
import { useMemo } from 'react';
import {
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  Select as SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type SelectOption = {
  label: ReactNode;
  value: string;
  /**
   * The heading this option is drawn under. Options sharing one are drawn together beneath it,
   * in the order they were given rather than sorted — a board's lanes are ordered, and
   * alphabetical would be wrong.
   */
  group?: string;
};

/** A rule across the list. The one entry that is not an option, so it has no `value`. */
export type SelectSeparatorEntry = { separator: true };

/**
 * What `options` holds: the options, and the rules between them.
 *
 * A list of peers is still a list of peers — nothing here is written until an option is not one.
 * The case that asked for it: a picker answering "where does this card go when it passes" with
 * *stay here*, then the other lanes, then *archive it*, which is not a lane at all. Without a
 * rule the last row sits flush against the lane names and reads as one of them, and the
 * workaround is a sentence doing a divider's job — `"Archive it — off the board"`.
 */
export type SelectEntry = SelectOption | SelectSeparatorEntry;

/** Generic over the entry, so the same test sorts a raw list and the blocks built from one. */
function isSeparator<T extends object>(entry: T): entry is T & SelectSeparatorEntry {
  return 'separator' in entry;
}

type SelectBlock = SelectSeparatorEntry | { group?: string; options: SelectOption[] };

/**
 * The flat list, as the runs Radix draws: a rule is its own block, and consecutive options
 * sharing a `group` are one.
 *
 * Walked rather than bucketed, because the order is the caller's and a group that reappears
 * later is a caller who meant it. Options with no `group` are a block with no heading, which is
 * every list that has not asked for one.
 */
function blocksOf(entries: readonly SelectEntry[]): SelectBlock[] {
  const blocks: SelectBlock[] = [];
  for (const entry of entries) {
    if (isSeparator(entry)) {
      blocks.push(entry);
      continue;
    }
    const last = blocks.at(-1);
    if (last && !isSeparator(last) && last.group === entry.group) {
      last.options.push(entry);
    } else {
      blocks.push({ group: entry.group, options: [entry] });
    }
  }
  return blocks;
}

type OptionSelectProps = Omit<ComponentProps<'button'>, 'value' | 'onChange' | 'type' | 'children'> & {
  options: readonly SelectEntry[];
  value?: string;
  onValueChange: (value: string) => void;
  /** What the trigger says with nothing chosen. */
  placeholder?: string;
  /** The dropdown's class. `className` still goes to the trigger, which is the control. */
  contentClassName?: string;
};

/**
 * A select taking a list of options, rather than seven primitives to assemble.
 *
 * The other four pickers in this set ship twice — a control taking `value` and `onValueChange`,
 * and a bound field wrapping it. Select shipped once, as `SelectField`, so the only way to get
 * one was through a TanStack form: a filter bar, a search box or a `useState` screen had to
 * hand-write the trigger, the value, the content and the mapped items, and there are ten of
 * those across these projects.
 *
 * They are hand-written wrong in the same place every time. **Radix's `Select` root renders no
 * DOM**, so an `id` or an `aria-invalid` put on it goes nowhere; both belong on the trigger.
 * Which is why this takes the rest of a `<button>`'s props and spreads them there — the shape
 * `FormField`'s function form hands its control, so this drops into one without a wrapper:
 *
 * ```tsx
 * <FormField
 *   label="Kind"
 *   control={(wired) => (
 *     <OptionSelect {...wired} options={KINDS} value={kind} onValueChange={setKind} />
 *   )}
 * />
 * ```
 *
 * **The name is `OptionSelect` because `Select` did not survive an install.** This shipped as
 * `Select`, on the reasoning that the import path tells it apart from the primitive at
 * `ui/select` the way it does for shadcn itself. It does not: the shadcn CLI resolves a
 * cross-item import by the source file's *basename*, so with `control/select.tsx` and
 * `ui/select.tsx` both in one install it rewrote `app-form`'s import to the primitive. That
 * compiles as far as the import and fails on the members, three files from the cause — see #36.
 * A name a human disambiguates by path is not one the CLI does, so no item here may share a
 * basename with a shadcn primitive.
 */
export function OptionSelect({
  options,
  value,
  onValueChange,
  placeholder,
  className,
  contentClassName,
  disabled,
  ...props
}: OptionSelectProps) {
  const blocks = useMemo(() => blocksOf(options), [options]);

  return (
    <SelectRoot value={value ?? ''} onValueChange={onValueChange} disabled={disabled}>
      {/* Full width by default, because a select in a field is one and a trigger that shrinks to
          its longest option makes a column of them ragged. `cn` lets a caller say otherwise. */}
      <SelectTrigger {...props} className={cn('w-full', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {/*
          Keyed by position, and it has to be: a rule has no identity of its own, and a heading
          that appears twice is a caller who meant it, so neither is unique. The list is the
          caller's and is drawn in the order given, so a position is stable enough.
        */}
        {blocks.map((block, index) =>
          isSeparator(block) ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a rule has no identity of its own
            <SelectSeparator key={`block-${index}`} />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: nor does a repeated heading
            <SelectGroup key={`block-${index}`}>
              {block.group ? <SelectLabel>{block.group}</SelectLabel> : null}
              {block.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ),
        )}
      </SelectContent>
    </SelectRoot>
  );
}
