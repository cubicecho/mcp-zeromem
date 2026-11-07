import type { VariantProps } from 'class-variance-authority';
import { Separator as SeparatorPrimitive, Slot } from 'radix-ui';
import type * as React from 'react';
import {
  ITEM_ACTIONS_CLASS,
  ITEM_CONTENT_CLASS,
  ITEM_DESCRIPTION_CLASS,
  ITEM_FOOTER_CLASS,
  ITEM_HEADER_CLASS,
  ITEM_SELECTED_CLASS,
  ITEM_SEPARATOR_CLASS,
  ITEM_TITLE_CLASS,
  ITEM_TITLE_TEXT,
  itemMediaVariants,
  itemVariants,
} from '@/components/ui/item-base';
import { cn } from '@/lib/utils';

/**
 * Upstream ships this with `role="list"`, and it is dropped here on purpose: nothing in this
 * file can be the `listitem` that role requires. `Item` takes `asChild`, so a caller may render
 * it as an `<a>` or a `<button>`, and a fixed role here would clobber that one — which is why
 * upstream does not put it there either. A `list` owning no `listitem` is not a neutral
 * overclaim: it announces as an empty list, and an AT that exposes only listitem children hides
 * whatever is inside it. A caller that really is drawing a list can say so on its own wrapper,
 * which is also where it owns the items.
 */
function ItemGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="item-group" className={cn('group/item-group flex flex-col', className)} {...props} />;
}

/** A rule between two items. */
function ItemSeparator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="item-separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        ITEM_SEPARATOR_CLASS,
        'data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}

/** What only a DOM row has: the hover on a link row, and the focus ring. */
const ITEM_WEB =
  'group/item flex text-sm transition-colors duration-100 outline-none [a]:transition-colors [a]:hover:bg-hover [a]:focus-visible:bg-hover';

/** One row: media, content and actions side by side. */
function Item({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  selected = false,
  ...props
}: React.ComponentProps<'div'> &
  VariantProps<typeof itemVariants> & {
    asChild?: boolean;
    /**
     * The chosen row: the one open beside the list. Tinted in `active`, a step further under the
     * pointer. Set `aria-current` or `aria-selected` on the row or the link inside as well.
     */
    selected?: boolean | undefined;
  }) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-slot="item"
      data-variant={variant}
      data-size={size}
      data-selected={selected ? '' : undefined}
      className={cn(
        ITEM_WEB,
        itemVariants({ variant, size }),
        selected && ITEM_SELECTED_CLASS,
        selected && '[a]:hover:bg-active/60 [a]:focus-visible:bg-active/60',
        className,
      )}
      {...props}
    />
  );
}

/** Sizing what is inside, which a device cannot select for, and the nudge beside a description. */
const ITEM_MEDIA_WEB = {
  default: '',
  icon: "[&_svg:not([class*='size-'])]:size-4",
  image: '[&_img]:size-full [&_img]:object-cover',
} as const;

/** The icon or image at the start of an item. */
function ItemMedia({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof itemMediaVariants>) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(
        'flex group-has-[[data-slot=item-description]]/item:translate-y-0.5 group-has-[[data-slot=item-description]]/item:self-start [&_svg]:pointer-events-none',
        itemMediaVariants({ variant }),
        ITEM_MEDIA_WEB[variant ?? 'default'],
        className,
      )}
      {...props}
    />
  );
}

/** The middle of an item, holding its title and description. */
function ItemContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-content"
      className={cn('flex flex-col [&+[data-slot=item-content]]:flex-none', ITEM_CONTENT_CLASS, className)}
      {...props}
    />
  );
}

/** The item's title. */
function ItemTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="item-title" className={cn('flex w-fit', ITEM_TITLE_CLASS, ITEM_TITLE_TEXT, className)} {...props} />
  );
}

/** The muted line under the item's title. */
function ItemDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        ITEM_DESCRIPTION_CLASS,
        // ITEM_SELECTED_DESCRIPTION_CLASS on the chosen row, which says so with `data-selected`:
        // read here rather than through context so the part stays a plain `<p>`.
        'in-data-selected:text-foreground',
        'text-balance [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-info',
        className,
      )}
      {...props}
    />
  );
}

/** The buttons at the far end of an item. */
function ItemActions({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="item-actions" className={cn('flex', ITEM_ACTIONS_CLASS, className)} {...props} />;
}

/** A full-width line above the item's row. */
function ItemHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="item-header" className={cn('flex basis-full', ITEM_HEADER_CLASS, className)} {...props} />;
}

/** A full-width line below the item's row. */
function ItemFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="item-footer" className={cn('flex basis-full', ITEM_FOOTER_CLASS, className)} {...props} />;
}

export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
};
