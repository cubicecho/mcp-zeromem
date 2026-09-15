import { Check, X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { readableTextColor } from '@/lib/readable-text-color';
import { cn } from '@/lib/utils';

/**
 * A palette wide enough to look chosen from rather than settled for.
 *
 * These are Tailwind's 500s, which is what both of the pickers this replaces reached for — one
 * listed ten of them, one sixteen, and the eight they share are these. They are only a default:
 * an app whose colours mean something — a calendar's activity types, a tag taxonomy — passes its
 * own list, and that is the common case.
 */
export const COLOR_SWATCHES = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
] as const;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A typed colour with its `#` put back, and nothing else changed.
 *
 * People paste `2563eb` out of a design tool and type `#2563EB` from memory, and both are the
 * colour they meant. Case is left alone on purpose: the value goes to a database, and a picker
 * that silently rewrites `#2563EB` to `#2563eb` shows up as a dirty form and an audit-log entry
 * for an edit nobody made.
 */
export function normalizeHex(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

/** Whether a string is a `#rgb` or `#rrggbb` colour. */
export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

/** `#f80` and `#FF8800` are one colour. Shorthand doubles each digit; it does not pad. */
function expand(value: string): string {
  const digits = value.replace('#', '').toLowerCase();
  return digits.length === 3
    ? digits
        .split('')
        .map((digit) => digit + digit)
        .join('')
    : digits;
}

function sameColor(a: string, b: string): boolean {
  return isHexColor(a) && isHexColor(b) && expand(a) === expand(b);
}

/**
 * The subset of button props a field shell reaches through the picker onto the trigger — the same
 * set, and for the same reason, as {@link DatePicker}'s.
 */
type PickerAria = Pick<
  ComponentProps<'button'>,
  'id' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid' | 'aria-required'
>;

type ColorPickerProps = PickerAria & {
  value?: string | null;
  onValueChange: (value: string) => void;
  /** The colours offered as one click. Defaults to {@link COLOR_SWATCHES}. */
  swatches?: readonly string[];
  /** What the trigger reads with no colour set. */
  placeholder?: string;
  /**
   * The popover's own name, for assistive technology. It is never drawn — see the component note
   * on why it has to exist anyway.
   */
  popoverLabel?: string;
  /** The hex box's label. It has no visible one; the field's label names the trigger, not this. */
  hexLabel?: string;
  /** The native colour well's label. */
  customLabel?: string;
  /** The swatch grid's group label. */
  swatchesLabel?: string;
  clearable?: boolean;
  clearLabel?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
};

/**
 * A colour, chosen from a palette or typed as hex.
 *
 * `<input type="color">` alone is not enough anywhere it is actually used, which is why nobody
 * uses it alone: it opens the operating system's colour dialog, so it cannot show the palette the
 * app has opinions about, its swatch is unlabelled, and on react-native-web it degrades to a
 * plain text box with no picker behind it at all. Two projects wrote a replacement independently,
 * and a third wrote a heavier one over `react-color`; the two live ones agree on the parts, and
 * disagree on which parts to draw. This is both:
 *
 * - a **trigger** showing the current colour and its hex, from private project 1;
 * - a **swatch grid** for the palette, from both, with `auto-cal`'s tick on the chosen one;
 * - a **hex box** for a colour that is not on the list, from both;
 * - the **native well**, kept from private project 1, because the OS picker is the right answer when the
 *   colour is being matched to something outside the app.
 *
 * **The tick is drawn in {@link readableTextColor}, not white.** That is `auto-cal`'s fix and it
 * is the reason this control and that function ship together: a white tick on `#f59e0b` is 2.2:1,
 * which is a chosen swatch that does not look chosen. A ring alone is the other half of the same
 * problem — `ring-ring` is a theme colour, so on the swatch that happens to be near it the
 * selection disappears. Both are drawn here.
 *
 * **The value is a string, and an invalid one never reaches it.** Typing `#ab` is a colour
 * half-entered, not a colour; the box holds the draft, the form does not, and the draft is
 * dropped on blur. Clearing to `""` is a real answer and does reach the form — "no colour" is
 * what an optional colour column holds.
 *
 * Radix draws the popover as `role="dialog"`, so it needs a name; the name is rendered inside it
 * rather than borrowed from the trigger, for the reason spelled out in `date-picker`.
 *
 * ```tsx
 * <ColorPicker value={color} onValueChange={setColor} swatches={ACTIVITY_COLORS} />
 * ```
 */
export function ColorPicker({
  value,
  onValueChange,
  swatches = COLOR_SWATCHES,
  placeholder = 'No color',
  popoverLabel = 'Color',
  hexLabel = 'Hex',
  customLabel = 'Custom color',
  swatchesLabel = 'Swatches',
  clearable = true,
  clearLabel = 'Clear',
  disabled = false,
  className,
  contentClassName,
  ...aria
}: ColorPickerProps) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  // The box's own text while it is being typed in. `null` means "show the stored value" — which
  // is what a blur restores, so a half-typed colour cannot survive the popover closing.
  const [draft, setDraft] = useState<string | null>(null);

  const current = value ?? '';
  const text = draft ?? current;
  // The native well only speaks `#rrggbb`. Handed anything else it silently reports black, so it
  // is given black deliberately rather than a value it would misread.
  const well = isHexColor(current) ? `#${expand(current)}` : '#000000';

  function commit(next: string) {
    const normalized = normalizeHex(next);
    setDraft(normalized);
    if (normalized === '' || isHexColor(normalized)) onValueChange(normalized);
  }

  function choose(next: string) {
    setDraft(null);
    onValueChange(next);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          data-slot="color-picker-trigger"
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn('w-full justify-start gap-2 px-3 text-left font-normal', className)}
          {...aria}
        >
          <span
            data-slot="color-picker-swatch"
            aria-hidden
            className={cn('size-4 shrink-0 rounded-sm border', !current && 'bg-muted')}
            style={current ? { backgroundColor: current } : undefined}
          />
          <span className={cn('truncate', !current && 'text-muted-foreground')}>{current || placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn('w-64 space-y-3', contentClassName)} aria-labelledby={titleId}>
        <span id={titleId} className="sr-only">
          {popoverLabel}
        </span>
        <div className="flex items-center gap-2">
          {/* Not a shadcn `Input`: `type="color"` is a swatch well, not a text box, and the
              input styles size it as one. */}
          <input
            data-slot="color-picker-native-input"
            type="color"
            aria-label={customLabel}
            value={well}
            disabled={disabled}
            onChange={(event) => choose(event.target.value)}
            className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0"
          />
          <Input
            data-slot="color-picker-hex"
            aria-label={hexLabel}
            value={text}
            placeholder="#2563eb"
            spellCheck={false}
            autoComplete="off"
            maxLength={7}
            disabled={disabled}
            className="font-mono"
            onChange={(event) => commit(event.target.value)}
            onBlur={() => setDraft(null)}
          />
        </div>
        {/* `aria-pressed` rather than radio semantics: a radiogroup owes its members one tab stop
            and arrow-key movement between them, and a grid of sixteen plain buttons that claims
            to be one without doing that is worse for a keyboard than not claiming it. */}
        <fieldset className="grid min-w-0 grid-cols-8 gap-1.5">
          <legend className="sr-only">{swatchesLabel}</legend>
          {swatches.map((swatch) => {
            const selected = sameColor(current, swatch);
            return (
              <button
                key={swatch}
                data-slot="color-picker-option"
                type="button"
                aria-label={swatch}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => {
                  choose(swatch);
                  setOpen(false);
                }}
                className="flex size-6 items-center justify-center rounded-sm border outline-none transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                style={{ backgroundColor: swatch }}
              >
                {selected ? (
                  <Check className="size-3.5" aria-hidden style={{ color: readableTextColor(swatch) }} />
                ) : null}
              </button>
            );
          })}
        </fieldset>
        {clearable && current ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => {
              choose('');
              setOpen(false);
            }}
          >
            <X className="size-4" aria-hidden /> {clearLabel}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
