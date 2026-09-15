import type { ComponentProps, ReactNode } from 'react';
import { bindToForm, type FieldProps, splitProps, useFieldContext, useFieldError } from '@/components/app-form';
import { FormField } from '@/components/form-field';
import { FieldDescription, FieldLabel } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

/** One choice. `description` is the line under it — what picking this one means. */
export type RadioOption = {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
};

type RadioGroupFieldProps = FieldProps & {
  options: readonly RadioOption[];
} & Omit<
    ComponentProps<typeof RadioGroup>,
    // The first four are this field's job. The rest collide with `FormField`'s own props of the
    // same name — `required` marks the group, `orientation` arranges the field, `className` is
    // the field's box — and a prop that means two things at one call site means neither.
    | 'value'
    | 'defaultValue'
    | 'onValueChange'
    | 'children'
    | 'id'
    | 'className'
    | 'required'
    | 'orientation'
    | 'aria-labelledby'
    | 'aria-describedby'
    | 'aria-invalid'
  >;

function BoundRadioGroupField(props: RadioGroupFieldProps) {
  const [fieldProps, rest] = splitProps(props);
  const { options, ...group } = rest;
  const field = useFieldContext<string | null>();
  const error = useFieldError();

  return (
    <FormField
      {...fieldProps}
      // Fixed, not defaulted: the control is a `<div role="radiogroup">`, and there is no
      // arrangement of this field in which a `<label for>` could reach it.
      asGroup
      error={error}
      control={(wired) => (
        <RadioGroup
          {...group}
          {...wired}
          value={field.state.value ?? ''}
          onValueChange={(next) => {
            field.handleChange(next);
            // Radix moves focus between the items with the arrow keys, so a blur happens on the
            // way to a *different option* rather than out of the field. Choosing is what marks it
            // touched.
            field.handleBlur();
          }}
        >
          {options.map((option, index) => {
            const itemId = `${wired.id}-option-${index}`;
            const descriptionId = option.description ? `${itemId}-description` : undefined;
            return (
              <div key={option.value} data-slot="radio-group-option" className="flex items-start gap-3">
                <RadioGroupItem
                  id={itemId}
                  value={option.value}
                  disabled={option.disabled}
                  // Per option, not per group: this sentence describes this choice. The group's
                  // own description and error are already on the group.
                  aria-describedby={descriptionId}
                  className="mt-0.5"
                />
                <div className="grid gap-1">
                  {/* A real `<label for>`, because a radio *item* is an element a label can
                      name — which is what makes the whole option, not just the 16px circle,
                      somewhere you can click. */}
                  <FieldLabel htmlFor={itemId} className="font-normal">
                    {option.label}
                  </FieldLabel>
                  {option.description ? (
                    <FieldDescription id={descriptionId}>{option.description}</FieldDescription>
                  ) : null}
                </div>
              </div>
            );
          })}
        </RadioGroup>
      )}
    />
  );
}

/**
 * A set of exclusive choices, all of them visible.
 *
 * A `SelectField` hides its options behind a click, which is right for twelve of them and wrong
 * for three — a form asking for a priority, a visibility, a billing period reads better with the
 * answers on the page, and it reads much better when each answer can carry a line saying what it
 * costs, which a `<SelectItem>` cannot.
 *
 * **This is the field that forced `asGroup` onto `FormField`.** A radio group is a
 * `<div role="radiogroup">`, and HTML will not let a `<label for>` name a `<div>` — so the
 * default wiring, which is otherwise the whole point of the shell, produces an association the
 * browser drops without saying so. On, the label is drawn as a title and the group is named by
 * `aria-labelledby` instead. The per-option labels are still real `<label for>`s, because a radio
 * item is a thing a label can name.
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
export const RadioGroupField = bindToForm<RadioGroupFieldProps, string>(BoundRadioGroupField, 'RadioGroupField');
