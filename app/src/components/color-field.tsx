import type { ComponentProps } from 'react';
import { bindToForm, type FieldProps, splitProps, useFieldContext, useFieldError } from '@/components/app-form';
import { COLOR_SWATCHES, ColorPicker, isHexColor, normalizeHex } from '@/components/color-picker';
import { FormField } from '@/components/form-field';

type ColorFieldProps = FieldProps &
  Omit<
    ComponentProps<typeof ColorPicker>,
    'id' | 'value' | 'onValueChange' | 'aria-describedby' | 'aria-invalid' | 'aria-required'
  >;

function BoundColorField(props: ColorFieldProps) {
  const [fieldProps, control] = splitProps(props);
  const field = useFieldContext<string | null>();
  const error = useFieldError();

  return (
    <FormField
      {...fieldProps}
      error={error}
      // The function form: the picker's root is a `Popover`, which draws no DOM of its own, so a
      // clone would hand the id to nothing.
      control={(wired) => (
        <ColorPicker
          {...control}
          {...wired}
          value={field.state.value ?? ''}
          onValueChange={(next) => {
            field.handleChange(next);
            // Choosing is the interaction. Focus leaves for the portal and comes back, so there
            // is no blur here that means "done" — the same reason `MultiSelectField` says so.
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
