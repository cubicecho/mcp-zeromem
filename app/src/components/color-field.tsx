import type { ComponentProps } from 'react';
import { bindToForm, type FieldProps, splitProps, useFieldContext, useFieldError } from '@/components/app-form';
import { FormField } from '@/components/form-field';
import { COLOR_SWATCHES, ColorPicker, isHexColor, normalizeHex } from '@/components/ui/color-picker';

type ColorFieldProps = FieldProps &
  Omit<
    ComponentProps<typeof ColorPicker>,
    // Both setters: the picker takes `onChange` and its alias `onValueChange`, and the field
    // supplies the value, so a caller's own would only be overwritten.
    'id' | 'value' | 'onValueChange' | 'onChange' | 'aria-describedby' | 'aria-invalid' | 'aria-required'
  >;

function BoundColorField(props: ColorFieldProps) {
  const [fieldProps, control] = splitProps(props);
  const field = useFieldContext<string | null>();
  const error = useFieldError();

  return (
    <FormField
      {...fieldProps}
      error={error}
      // The function form, so the wiring lands on the picker itself: it puts `id` on its hex box,
      // which the label then names, and the description and error on the swatch group.
      controlSlot={(wired, { labelId }) => (
        <ColorPicker
          {...control}
          {...wired}
          // The label is a `<label htmlFor>` on the hex box, and a `<label>` cannot also name the
          // swatch row — a `radiogroup` with no name is an axe failure and a screen reader saying
          // "radio group" and nothing else. So the row points back at the label, unless the
          // caller named it some other way.
          aria-labelledby={
            control['aria-labelledby'] ??
            (control['aria-label'] === undefined && control.swatchesLabel === undefined ? labelId : undefined)
          }
          value={field.state.value ?? ''}
          onChange={(next: string) => {
            field.handleChange(next);
            // Choosing a swatch is the whole interaction, and a swatch click is not a blur of the
            // hex box, so nothing else would tell the field it was touched.
            field.handleBlur();
          }}
        />
      )}
    />
  );
}

/**
 * A colour, as one line, over a field holding a hex string.
 *
 * ```tsx
 * <ColorField form={form} name="color" label="Colour" swatches={ACTIVITY_COLORS} />
 * ```
 *
 * Its own file rather than another export from `app-form`, so a form of plain inputs does not
 * pull in the picker. See {@link ColorPicker} for what the control fixes.
 */
export const ColorField = bindToForm<ColorFieldProps, string>(BoundColorField, 'ColorField');

// Local bindings rather than `export … from`: the shadcn CLI rewrites import declarations on
// install and leaves re-export declarations alone, so the `from` form would ship a path into
// `control/` that does not exist in a consumer's tree. See AGENTS.md.
export { COLOR_SWATCHES, ColorPicker, isHexColor, normalizeHex };
