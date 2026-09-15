import { Check, ChevronsUpDown, Plus, X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { readableTextColor } from '@/lib/readable-text-color';
import { cn } from '@/lib/utils';

export type MultiSelectOption = {
  value: string;
  /** What is read, searched and shown on the chip. A string, because all three need one. */
  label: string;
  /** Extra words the search should match — a synonym, an old name, a code. */
  keywords?: string[];
  /** A CSS colour for the chip. The text on it is chosen for contrast, not hardcoded. */
  color?: string;
  disabled?: boolean;
  /**
   * The end of the row: a status badge, a count, a date. Drawn beside the label, never on the
   * chip — the chip is a string and stays one.
   *
   * A description rather than a name, so a row still announces as what it is called and the
   * badge is read after it. `color` cannot do this job: it is the chip's colour, and pointing it
   * at a status would mint a second colour vocabulary beside the app's own.
   */
  meta?: ReactNode;
  /**
   * The heading these options are drawn under. Options sharing one are drawn together beneath
   * it, in the order they were given rather than sorted — a board's lanes are ordered, and
   * alphabetical would be wrong.
   *
   * The heading is also searched, so typing a lane's name still finds the cards in it. cmdk
   * hides a heading whose options are all filtered out, which is what you want.
   */
  group?: string;
  /**
   * Why this option is the way it is — most often why it is unavailable.
   *
   * Drawn under the label and read after it, so it survives the case it is for: a `disabled` row
   * fires no hover, so a tooltip on it is text nobody can reach, and "greyed out" on its own
   * reads as a bug in the picker rather than as a decision. The reason is knowable when the
   * options are built and unreachable by the time somebody wonders — this is the one place to
   * put it.
   *
   * Same argument as {@link ActionButton}'s `hint`, in a control that had not had it yet.
   */
  hint?: ReactNode;
};

/**
 * The options to draw, with one synthesised for every selected value nothing covers.
 *
 * A row loaded from the server holds ids; the options come from a query that may not have
 * finished, may be paged, or may simply no longer contain a tag someone deleted. Without this
 * the chip for that value is not drawn at all — so it is invisible, still submitted, and
 * unremovable, which is the "why is this tag stuck on it" bug in two of these apps.
 */
export function mergeMultiSelectOptions(
  options: readonly MultiSelectOption[],
  value: readonly string[],
): MultiSelectOption[] {
  const known = new Set(options.map((option) => option.value));
  const orphans = value.filter((selected) => !known.has(selected));
  return orphans.length === 0
    ? [...options]
    : [...options, ...orphans.map((selected) => ({ value: selected, label: selected }))];
}

type MultiSelectRun = { group?: string; options: MultiSelectOption[] };

/**
 * The flat list as the runs it is drawn in: consecutive options sharing a `group` are one.
 *
 * Walked rather than bucketed, because the order is the caller's — a board's lanes are ordered —
 * and a heading that reappears later is a caller who meant it. Options with no `group` are a run
 * with no heading, which is every list that has not asked for one, including the values
 * {@link mergeMultiSelectOptions} synthesised.
 */
function groupsOf(options: readonly MultiSelectOption[]): MultiSelectRun[] {
  const runs: MultiSelectRun[] = [];
  for (const option of options) {
    const last = runs.at(-1);
    if (last && last.group === option.group) {
      last.options.push(option);
    } else {
      runs.push({ group: option.group, options: [option] });
    }
  }
  return runs;
}

/**
 * Whether a typed name is worth offering to create.
 *
 * Exact match only, ignoring case and surrounding space. Not a substring test: "Work" must stay
 * addable while "Workshop" exists, and a `.includes` here is the reason one of these apps cannot
 * create a tag whose name is a prefix of another.
 */
export function isAddableOptionName(name: string, options: readonly MultiSelectOption[]): boolean {
  const trimmed = name.trim();
  if (trimmed === '') return false;
  const folded = trimmed.toLocaleLowerCase();
  return !options.some((option) => option.label.trim().toLocaleLowerCase() === folded);
}

/**
 * cmdk's filter, replaced: every whitespace-separated word must appear somewhere.
 *
 * The default is a fuzzy scorer that ranks, which is right for a command palette and wrong for a
 * list of tags — typing "back end" should find "Backend infrastructure", and the words being in
 * the other order should not matter. Returns 1 or 0 because there is no ranking to do here; the
 * list is already in the order the caller wanted.
 */
function matchesAllWords(haystack: string, search: string): number {
  const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const target = haystack.toLocaleLowerCase();
  return words.every((word) => target.includes(word)) ? 1 : 0;
}

function chipStyle(color: string | undefined) {
  if (!color) return undefined;
  return { backgroundColor: color, color: readableTextColor(color), borderColor: 'transparent' };
}

type MultiSelectProps = Omit<ComponentProps<'button'>, 'value' | 'onChange' | 'type' | 'children'> & {
  options: readonly MultiSelectOption[];
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  /** What the trigger says with nothing selected. */
  placeholder?: string;
  searchPlaceholder?: string;
  /**
   * The search box's accessible name. cmdk points its input at a hidden `<label>` it renders
   * from `Command`'s `label`, so without this the search box is a `combobox` with no name at
   * all — a placeholder is not one.
   */
  searchLabel?: string;
  /**
   * What the popover is called. It is a `role="dialog"`, and a dialog needs a name.
   *
   * The name is rendered inside it rather than borrowed from the trigger with
   * `aria-labelledby`: a label that lives outside the dialog resolves to nothing the moment the
   * thing it points at is hidden, removed or re-keyed, and then the failure is a silent one that
   * only an axe run catches.
   */
  popoverLabel?: string;
  /** What the list says when the search matches nothing and there is nothing to add. */
  emptyMessage?: string;
  /** Off, the list has no search box — for the six-option case where it is only in the way. */
  searchable?: boolean;
  /**
   * Offer to create what was typed. The handler owns the creation *and* the selection: it is
   * usually a mutation, and only the caller knows the id the new row came back with.
   */
  onCreateOption?: (name: string) => void;
  /** What the create row says, before the quoted name. */
  createLabel?: string;
  /** Chips to draw before collapsing to a count. `0` always shows the count. */
  maxDisplay?: number;
  clearable?: boolean;
  contentClassName?: string;
};

/**
 * One option, which is up to four things: the tick, the colour dot, what it is called, and what
 * else is true of it.
 *
 * Its own component because the rows are drawn inside a run now rather than in one flat map, and
 * because everything about the row that is not the label is a *description* — which takes two
 * ids, an explicit name, and a layout that changes when there is a second line. That is more
 * than belongs in a nested map.
 */
function OptionRow({
  option,
  idPrefix,
  selected,
  onToggle,
}: {
  option: MultiSelectOption;
  idPrefix: string;
  selected: boolean;
  onToggle: (value: string) => void;
}) {
  const hintId = option.hint ? `${idPrefix}-hint-${option.value}` : undefined;
  const metaId = option.meta ? `${idPrefix}-meta-${option.value}` : undefined;
  // A second line changes the row from centred to top-aligned, and everything on the first line
  // has to be nudged down to sit on it.
  const stacked = Boolean(option.hint);

  return (
    <CommandItem
      // What the filter sees. `value` alone would search ids, which nobody types; the heading is
      // in here so that typing a lane's name still finds the cards in it.
      value={[option.label, option.group, ...(option.keywords ?? [])].filter(Boolean).join(' ')}
      disabled={option.disabled}
      // `aria-checked`, not `aria-selected`, and not by preference: cmdk uses
      // `aria-selected` for which option is *highlighted* and sets it after the
      // props it is given, so it cannot also carry which options are chosen.
      // `aria-checked` is valid on `role="option"`, is the one cmdk leaves alone,
      // and is read as "checked" — which is what the tick beside it means. Without
      // it the selection is a visual mark and nothing else, which is what every
      // version of this in these projects ships.
      aria-checked={selected}
      // The name is the label and nothing else. Without this the badge and the hint would be
      // swept into the accessible name by the contents, so the row would announce them as part
      // of what it is called, and again as its description — twice, in the wrong order, as one
      // sentence.
      aria-label={option.label}
      // In reading order: the end of the row, then the line under it.
      aria-describedby={[metaId, hintId].filter(Boolean).join(' ') || undefined}
      onSelect={() => onToggle(option.value)}
      // `group` so the two muted lines can answer the highlight. cmdk paints the highlighted row
      // `bg-accent`, and muted text on it is 4.34:1 — under the 4.5 a body-size string needs, so
      // whichever row the arrow keys are on is the one that cannot be read.
      className={cn('group', stacked && 'items-start')}
    >
      <Check
        className={cn('size-4 shrink-0', stacked && 'mt-0.5', selected ? 'opacity-100' : 'opacity-0')}
        aria-hidden
      />
      {option.color ? (
        <span
          className={cn('size-2.5 shrink-0 rounded-full', stacked && 'mt-1.5')}
          style={{ backgroundColor: option.color }}
          aria-hidden
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {option.hint ? (
          // Wrapped rather than truncated: a reason cut off at the edge of the
          // popover is the same as no reason.
          <span
            id={hintId}
            data-slot="multi-select-option-hint"
            className="block text-muted-foreground text-xs group-data-[selected=true]:text-accent-foreground/80"
          >
            {option.hint}
          </span>
        ) : null}
      </span>
      {option.meta ? (
        <span
          id={metaId}
          data-slot="multi-select-option-meta"
          className={cn(
            'shrink-0 text-muted-foreground text-xs group-data-[selected=true]:text-accent-foreground/80',
            stacked && 'mt-0.5',
          )}
        >
          {option.meta}
        </span>
      ) : null}
    </CommandItem>
  );
}

/**
 * A combobox that selects more than one thing.
 *
 * There are three of these across these projects and none of them is the same shape. One is a
 * `Popover` over a `Command` with search and a create row; one is a hand-rolled `div` with an
 * outside-click `useEffect`, no portal, no keyboard navigation, and `aria-haspopup="listbox"` on
 * a button with no listbox anywhere beneath it; the third is a stack of checkboxes. The middle
 * one is the one that matters, because it looks like a combobox and is not operable as one — it
 * cannot be opened, moved through or chosen from without a mouse.
 *
 * So this is the first shape, kept: a real `Popover` (portalled, focus-trapped, closes on Escape
 * and on outside click without anyone writing the listener) over cmdk, which owns the roving
 * focus and the typeahead.
 *
 * **Clearing is in the footer, not on the trigger.** The obvious place for an `X` is inside the
 * trigger, and the trigger is a `<button>` — a button inside a button is not valid HTML and the
 * inner one is unreachable by keyboard in every browser. Chips get their own remove buttons only
 * when they are outside the trigger, which they are not here, so the footer holds the one Clear.
 */
export function MultiSelect({
  options,
  value,
  onValueChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  searchLabel = 'Search',
  popoverLabel = 'Options',
  emptyMessage = 'No matches.',
  searchable = true,
  onCreateOption,
  createLabel = 'Add',
  maxDisplay = 3,
  clearable = true,
  className,
  contentClassName,
  disabled,
  id,
  ...props
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const generatedId = useId();
  const titleId = useId();
  const rowId = useId();
  // The trigger needs a stable id whether or not a field shell gave it one, because the popover
  // is named by pointing at it — a Radix popover is `role="dialog"`, and an unnamed dialog is an
  // accessibility failure that only shows up once something opens it.
  const triggerId = id ?? generatedId;

  const merged = useMemo(() => mergeMultiSelectOptions(options, value), [options, value]);
  const runs = useMemo(() => groupsOf(merged), [merged]);
  const selected = useMemo(
    () => value.map((v) => merged.find((option) => option.value === v)).filter(Boolean),
    [merged, value],
  ) as MultiSelectOption[];

  const canCreate = Boolean(onCreateOption) && isAddableOptionName(search, merged);

  const toggle = (option: string) => {
    onValueChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option]);
  };

  const shown = maxDisplay > 0 ? selected.slice(0, maxDisplay) : [];
  const overflow = selected.length - shown.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-slot="multi-select-trigger"
          id={triggerId}
          type="button"
          role="combobox"
          // `aria-controls` and `aria-haspopup` are Radix's, through `asChild`, and point at the
          // popover it owns. cmdk mints the listbox id itself and overwrites any id passed to
          // `CommandList`, so there is nothing here that could point at it honestly.
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs outline-none transition-[color,box-shadow]',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...props}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {selected.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              <>
                {shown.map((option) => (
                  <Badge
                    key={option.value}
                    variant="secondary"
                    style={chipStyle(option.color)}
                    className="max-w-40 truncate"
                  >
                    {option.label}
                  </Badge>
                ))}
                {overflow > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    {shown.length === 0 ? `${overflow} selected` : `+${overflow}`}
                  </span>
                ) : null}
              </>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        aria-labelledby={titleId}
        // Matches the trigger, so the list does not jump narrower than the thing that opened it.
        className={cn('w-[var(--radix-popover-trigger-width)] p-0', contentClassName)}
      >
        <span id={titleId} className="sr-only">
          {popoverLabel}
        </span>
        <Command label={searchLabel} filter={matchesAllWords} shouldFilter={searchable}>
          {searchable ? (
            <CommandInput value={search} onValueChange={setSearch} placeholder={searchPlaceholder} />
          ) : null}
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {runs.map((run, index) => (
              // Positional, because a heading that appears twice is a caller who meant it and so
              // is not unique. The list is the caller's and is drawn in the order given.
              // biome-ignore lint/suspicious/noArrayIndexKey: a run has no id of its own
              <CommandGroup key={`run-${index}`} heading={run.group}>
                {run.options.map((option) => (
                  <OptionRow
                    key={option.value}
                    option={option}
                    idPrefix={rowId}
                    selected={value.includes(option.value)}
                    onToggle={toggle}
                  />
                ))}
              </CommandGroup>
            ))}

            {canCreate ? (
              // An explicit row, not an Enter handler on the input: cmdk already consumes Enter
              // to choose the highlighted item, so a keydown listener races it and wins only
              // sometimes. A row is a thing you can see, arrow to, and click.
              <CommandGroup forceMount className="sticky bottom-0 border-t bg-popover">
                <CommandItem
                  forceMount
                  value={`__create__${search}`}
                  onSelect={() => {
                    onCreateOption?.(search.trim());
                    setSearch('');
                  }}
                >
                  <Plus className="size-4" aria-hidden />
                  <span className="truncate">
                    {createLabel} “{search.trim()}”
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>

        {clearable && selected.length > 0 ? (
          <div className="flex justify-end border-t p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onValueChange([])}
            >
              <X className="size-4" aria-hidden /> Clear
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
