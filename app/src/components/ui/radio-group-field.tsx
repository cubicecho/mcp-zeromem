import type { AnyFieldApi, DeepKeys } from '@tanstack/react-form';
import { useStore } from '@tanstack/react-form';
import type { ReactNode } from 'react';
import * as React from 'react';
import { Field, FieldDescription, FieldError, FieldTitle } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { messageOf } from '@/lib/error-message';
import { type BindableForm, type FormBinding, fieldOf, type NamesOfType, type ValuesOf } from '@/lib/form-binding';
import { cn, HEADING_GAP, hasSlot, type SlotNode } from '@/lib/utils';

/** One choice. `description` is the line under it — what picking this one means. */
export type RadioOption = {
  value: string;
  label: ReactNode;
  description?: ReactNode | undefined;
  /** The picture over the label, in the `card` variant. */
  iconSlot?: SlotNode | undefined;
  /** A hover hint on the web and the accessibility hint on device. */
  hint?: string | undefined;
  disabled?: boolean | undefined;
};

type RadioGroupFieldProps<TForm extends BindableForm, TName extends DeepKeys<ValuesOf<TForm>>> = FormBinding<
  TForm,
  TName
> & {
  options: readonly RadioOption[];
  /** The group's name, drawn as a title and pointed at by `aria-labelledby`. */
  label?: ReactNode | undefined;
  /** A line under the options, on the group as a whole. */
  description?: ReactNode | undefined;
  /** Marks the group required: an asterisk on the title and `aria-required` on the group. */
  required?: boolean | undefined;
  /** The title row's far end. */
  actionSlot?: SlotNode | undefined;
  /** Draws a placeholder where the options go, for a form whose values are still loading. */
  loading?: boolean | undefined;
  /** `row` (the default), `card` or `segmented` — see `RadioGroup`. */
  variant?: 'row' | 'card' | 'segmented' | undefined;
  /** How the options are laid out. Defaults to the variant's own. */
  orientation?: 'vertical' | 'horizontal' | undefined;
  /** No option can be chosen, and the title and the description fade with the options. */
  disabled?: boolean | undefined;
  loop?: boolean | undefined;
  className?: string | undefined;
  labelClassName?: string | undefined;
  descriptionClassName?: string | undefined;
  errorClassName?: string | undefined;
  loadingClassName?: string | undefined;
  groupClassName?: string | undefined;
};

type BodyProps = Omit<
  RadioGroupFieldProps<BindableForm, never>,
  'form' | 'name' | 'validators' | 'asyncDebounceMs' | 'listeners'
> & { field: AnyFieldApi };

function RadioGroupFieldBody({
  field,
  options,
  label,
  description,
  required = false,
  actionSlot,
  loading = false,
  variant,
  orientation,
  disabled,
  loop,
  className,
  labelClassName,
  descriptionClassName,
  errorClassName,
  loadingClassName,
  groupClassName,
}: BodyProps) {
  const uid = React.useId();
  const labelId = `${uid}-label`;
  const descriptionId = `${uid}-description`;
  const errorId = `${uid}-error`;

  const errors = useStore(field.store, (state) => state.meta.errors);
  const isTouched = useStore(field.store, (state) => state.meta.isTouched);
  const attempts = useStore(field.form.store, (state) => state.submissionAttempts);
  // Nothing is wrong until the user has chosen or tried to submit — otherwise a required group is
  // red on first paint.
  const error = isTouched || attempts > 0 ? messageOf(errors[0]) : undefined;

  const value: unknown = field.state.value;
  const describedBy = [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ');

  const title = label ? (
    <FieldTitle id={labelId} className={labelClassName}>
      {label}
      {required ? (
        <span aria-hidden className="cube-rn-text text-negative">
          {' *'}
        </span>
      ) : null}
    </FieldTitle>
  ) : null;

  return (
    // `Field`, so the title and the description fade with the options when it is `disabled`.
    <Field data-slot="radio-group-field" disabled={disabled} className={cn('min-w-0', className)}>
      {hasSlot(actionSlot) ? (
        <div className="cube-rn-view min-w-0 flex-row items-center gap-2">
          {title}
          <div className="cube-rn-view ml-auto shrink-0">{actionSlot}</div>
        </div>
      ) : (
        title
      )}
      {loading ? (
        // The Skeleton primitive, pulsing as FormField's does, not a hand-drawn still box.
        <Skeleton
          aria-hidden
          data-slot="radio-group-field-skeleton"
          className={cn('h-16 w-full rounded-md', loadingClassName)}
        />
      ) : (
        <RadioGroup
          value={typeof value === 'string' ? value : ''}
          onValueChange={(next) => {
            field.handleChange(next);
            // The arrow keys move focus between options, so a blur happens on the way to a
            // *different option* rather than out of the field. Choosing is what marks it touched.
            field.handleBlur();
          }}
          variant={variant}
          orientation={orientation}
          disabled={disabled}
          loop={loop}
          aria-labelledby={label ? labelId : undefined}
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          className={groupClassName}
        >
          {options.map((option) => (
            <RadioGroupItem
              key={option.value}
              value={option.value}
              label={option.label}
              description={option.description}
              iconSlot={option.iconSlot}
              hint={option.hint}
              disabled={option.disabled}
            />
          ))}
        </RadioGroup>
      )}
      {/* One column, so the description and the error are the heading rhythm's 4px apart, as in
          every other field; only text against the options is `Field`'s 8px. */}
      {description || error ? (
        <div className={cn('cube-rn-view', 'min-w-0', HEADING_GAP)}>
          {description ? (
            <FieldDescription id={descriptionId} className={descriptionClassName}>
              {description}
            </FieldDescription>
          ) : null}
          {error ? (
            <FieldError id={errorId} className={errorClassName}>
              {error}
            </FieldError>
          ) : null}
        </div>
      ) : null}
    </Field>
  );
}

/**
 * A set of exclusive choices, all of them visible, bound to a TanStack form field.
 *
 * A select hides its options behind a press, which is right for twelve of them and wrong for
 * three — a priority, a visibility, a theme reads better with the answers on the screen, and
 * better still when each can carry a line saying what it means.
 *
 * One source for both platforms. The web item used to be a `FormField` around shadcn's radix
 * group; it is now this, compiled, so the React Native app and the DOM one get the same field.
 *
 * The group is named by `aria-labelledby` pointing at a title, never by a `<label for>`: a radio
 * group is a `role="radiogroup"` box, and HTML will not let a label name one.
 *
 * ```tsx
 * <RadioGroupField
 *   form={form}
 *   name="visibility"
 *   label="Visibility"
 *   options={[
 *     { value: "private", label: "Private", description: "Only you." },
 *     { value: "team", label: "Team", description: "Everyone in the workspace." },
 *   ]}
 * />
 * ```
 */
export function RadioGroupField<TForm extends BindableForm, TName extends NamesOfType<ValuesOf<TForm>, string>>({
  form,
  name,
  validators,
  asyncDebounceMs,
  listeners,
  ...body
}: RadioGroupFieldProps<TForm, TName>) {
  const Subscribe = fieldOf(form);

  return (
    <Subscribe name={name} validators={validators} asyncDebounceMs={asyncDebounceMs} listeners={listeners}>
      {(field) => <RadioGroupFieldBody {...body} field={field} />}
    </Subscribe>
  );
}
