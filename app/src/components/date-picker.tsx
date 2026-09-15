import { format as formatDateFns } from 'date-fns';
import { CalendarIcon, X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { useId, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type { DateRange };

/**
 * A `Date` with the day taken from one and the clock from another.
 *
 * Picking a day must not move the time, and setting a time must not move the day — which sounds
 * obvious and is exactly what a `new Date(picked)` loses, because the calendar hands back
 * midnight. Both of these copy rather than mutate: a `Date` from props is somebody else's state,
 * and `setHours` on it is a change nothing re-renders for.
 */
export function combineDateAndTime(day: Date, timeSource: Date): Date {
  const combined = new Date(day);
  combined.setHours(
    timeSource.getHours(),
    timeSource.getMinutes(),
    timeSource.getSeconds(),
    timeSource.getMilliseconds(),
  );
  return combined;
}

/** The same, from an `<input type="time">` value — `"14:30"`, or `"14:30:05"`. */
export function setTime(day: Date, time: string): Date {
  const [hours, minutes, seconds] = time.split(':').map(Number);
  const combined = new Date(day);
  combined.setHours(hours ?? 0, minutes ?? 0, seconds ?? 0, 0);
  return combined;
}

function timeValue(date: Date): string {
  return formatDateFns(date, 'HH:mm');
}

/**
 * The trigger every picker here draws: a full-width outline button that reads left, with the
 * placeholder in the muted colour and the value in the normal one.
 *
 * Three call sites had this as a copied `w-[250px] justify-between bg-input-background pl-2 pr-3
 * text-left font-normal`, and a fourth had it in React Native. The fixed `250px` is dropped —
 * width belongs to the layout the field is in, and `FormField` already gives it one.
 */
const TRIGGER = 'w-full justify-between px-3 text-left font-normal';

/**
 * The subset of button props a field shell needs to reach through the picker onto the trigger.
 *
 * `FormField` hands back an `id` and three aria attributes, and they have to land on the element
 * the label points at — otherwise the picker is a control with a label beside it and no relation
 * between the two, which is what all three of the pickers this replaces are.
 */
type PickerAria = Pick<
  ComponentProps<'button'>,
  'id' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid' | 'aria-required'
>;

type PickerTriggerProps = ComponentProps<'button'> & { empty: boolean; children: ReactNode };

/**
 * The popover's name, rendered inside it.
 *
 * Radix draws the content as `role="dialog"`, and a dialog with no accessible name is a failure
 * every axe run reports. The name goes *in* the dialog rather than being borrowed from the
 * trigger with `aria-labelledby`, because a reference out of the dialog resolves to nothing the
 * moment the thing it points at is hidden or re-keyed — and then it fails quietly.
 */
function PopoverName({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="sr-only">
      {children}
    </span>
  );
}

function PickerTrigger({ empty, className, children, ...props }: PickerTriggerProps) {
  return (
    <PopoverTrigger asChild>
      <Button
        data-slot="date-picker-trigger"
        type="button"
        variant="outline"
        className={cn(TRIGGER, empty && 'text-muted-foreground', className)}
        {...props}
      >
        <span className="truncate">{children}</span>
        <CalendarIcon className="size-4 shrink-0 opacity-50" aria-hidden />
      </Button>
    </PopoverTrigger>
  );
}

/**
 * The Clear row, in the popover's footer.
 *
 * Not an `X` inside the trigger, which is where all three of the pickers this replaces put it: a
 * `<button>` inside a `<button>` is invalid HTML, and the inner one is unreachable by keyboard in
 * every browser — so the affordance exists for a mouse and for nothing else. Two of the three
 * then had to render an empty `<div className="h-4 w-4" />` in its place to stop the label
 * shifting, which is the tell that the control was fighting its own markup.
 */
function ClearRow({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex justify-end border-t p-1">
      <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={onClear}>
        <X className="size-4" aria-hidden /> Clear
      </Button>
    </div>
  );
}

type CalendarProps = ComponentProps<typeof Calendar>;

type DatePickerProps = PickerAria & {
  value?: Date | null;
  onValueChange: (value: Date | null) => void;
  /** Adds a time box under the calendar and keeps the clock through a day change. */
  showTime?: boolean;
  placeholder?: string;
  /** How the chosen date reads on the trigger. Defaults to `PPP`, or `PPP p` with a time. */
  format?: string;
  /** Which days cannot be chosen — react-day-picker's matcher, so `{ before: new Date() }` works. */
  disabledDates?: CalendarProps['disabled'];
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  contentClassName?: string;
  /** Anything else the calendar takes: `startMonth`, `numberOfMonths`, `weekStartsOn`. */
  calendarProps?: Omit<CalendarProps, 'mode' | 'selected' | 'onSelect' | 'disabled'>;
};

/**
 * A date, and optionally a time, behind a popover.
 *
 * `showTime` is a prop rather than a `DateTimePicker` because the two differ by one input and
 * one format string — a variant is not a component. The three near-identical pickers this
 * replaces were three files for that reason and drifted apart anyway: one of them still passes
 * `initialFocus`, removed in react-day-picker v9, and each carries a `<Label>` with no `htmlFor`,
 * so none of the three is actually labelled. Here the label is `FormField`'s job and the trigger
 * is a `<button>`, which is a labelable element — see {@link DateField}.
 */
export function DatePicker({
  value,
  onValueChange,
  showTime = false,
  placeholder = 'Pick a date',
  format,
  disabledDates,
  clearable = true,
  disabled,
  className,
  contentClassName,
  calendarProps,
  ...aria
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const pattern = format ?? (showTime ? 'PPP p' : 'PPP');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PickerTrigger {...aria} empty={!value} disabled={disabled} className={className}>
        {value ? formatDateFns(value, pattern) : placeholder}
      </PickerTrigger>
      <PopoverContent align="start" aria-labelledby={titleId} className={cn('w-auto p-0', contentClassName)}>
        <PopoverName id={titleId}>{placeholder}</PopoverName>
        <Calendar
          // Opening on today with a value set in March means the value is not on screen — the
          // calendar takes its first month from `defaultMonth`, never from `selected`.
          defaultMonth={value ?? undefined}
          {...calendarProps}
          mode="single"
          selected={value ?? undefined}
          disabled={disabledDates}
          onSelect={(day) => {
            if (!day) {
              onValueChange(null);
              return;
            }
            // The clock survives the day changing — the whole reason this is not `new Date(day)`.
            onValueChange(value ? combineDateAndTime(day, value) : day);
            if (!showTime) setOpen(false);
          }}
        />
        {showTime ? (
          <div className="flex items-center gap-2 border-t p-3">
            <Input
              type="time"
              // A time with no date is not a value this control can hold, so it waits.
              disabled={!value}
              aria-label="Time"
              value={value ? timeValue(value) : ''}
              onChange={(event) => {
                if (value && event.target.value) {
                  onValueChange(setTime(value, event.target.value));
                }
              }}
              className="w-full"
            />
          </div>
        ) : null}
        {clearable && value ? (
          <ClearRow
            onClear={() => {
              onValueChange(null);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

type DateRangePickerProps = Omit<DatePickerProps, 'value' | 'onValueChange' | 'showTime' | 'calendarProps'> & {
  value?: DateRange | null;
  onValueChange: (value: DateRange | null) => void;
  /** Months side by side. Two, because a range usually crosses one. */
  numberOfMonths?: number;
  calendarProps?: Omit<CalendarProps, 'mode' | 'selected' | 'onSelect' | 'disabled'>;
};

/**
 * A start and an end, behind a popover.
 *
 * Its own component and not a `range` prop on {@link DatePicker}, because the value is a
 * different type: everything a caller does with it — the state, the validator, the submitted
 * row — is `DateRange`, not `Date`, and a prop cannot change what `onValueChange` hands back.
 *
 * It also closes. The version this replaces holds no open state at all, so choosing the end of
 * the range leaves the calendar sitting over the rest of the form until something else is
 * clicked; here the second date is the end of the interaction, which is what it means.
 */
export function DateRangePicker({
  value,
  onValueChange,
  placeholder = 'Pick a date range',
  format,
  disabledDates,
  clearable = true,
  disabled,
  className,
  contentClassName,
  numberOfMonths = 2,
  calendarProps,
  ...aria
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const pattern = format ?? 'PP';

  const label = value?.from
    ? value.to
      ? `${formatDateFns(value.from, pattern)} – ${formatDateFns(value.to, pattern)}`
      : formatDateFns(value.from, pattern)
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PickerTrigger {...aria} empty={!value?.from} disabled={disabled} className={className}>
        {label}
      </PickerTrigger>
      <PopoverContent align="start" aria-labelledby={titleId} className={cn('w-auto p-0', contentClassName)}>
        <PopoverName id={titleId}>{placeholder}</PopoverName>
        <Calendar
          defaultMonth={value?.from}
          {...calendarProps}
          mode="range"
          numberOfMonths={numberOfMonths}
          selected={value ?? undefined}
          disabled={disabledDates}
          onSelect={(range) => {
            onValueChange(range ?? null);
            if (range?.from && range.to) setOpen(false);
          }}
        />
        {clearable && value?.from ? (
          <ClearRow
            onClear={() => {
              onValueChange(null);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
