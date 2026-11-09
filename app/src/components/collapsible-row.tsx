import type { ReactNode } from 'react';
import * as React from 'react';
import { CollapsibleTrigger } from '@/components/collapsible';
import { ListItemText, rowFillClass, rowPressInsetClass } from '@/components/list-item';
import { Item, ItemActions } from '@/components/ui/item';
import { cn, HEADING_TITLE, HEADING_WRAP_FLOOR, hasSlot, type SlotNode } from '@/lib/utils';

type CollapsibleRowProps = {
  /**
   * Whether the row is open. The caller holds it: a list usually opens one row at a time, or opens
   * the one a link points at.
   */
  open: boolean;
  /** Told the state the reader asked for when the heading is pressed; set `open` from it. */
  onOpenChange: (open: boolean) => void;
  /** The row's name, and the button that opens it. A string is drawn in the row's title style. */
  title: ReactNode;
  /** Whatever the row is wearing: a status, a kind, a state. Drawn before the title. */
  badgesSlot?: SlotNode | undefined;
  /**
   * The small grey facts at the heading's far end, as on `ListItem`: a name, a time, a count. A
   * string is drawn muted and extra small; an element is placed as it is. Inside the button.
   */
  meta?: ReactNode | undefined;
  /** Two clipped lines of what the thing said, drawn under the title whether open or not. */
  description?: ReactNode | undefined;
  /** Buttons, outside the collapsible: a row is opened by its heading and acted on by these. */
  actionSlot?: SlotNode | undefined;
  /** What the row opens onto. */
  contentSlot?: SlotNode | undefined;
  /** On the whole row, the heading and what it opens onto together. */
  className?: string | undefined;
  /** On the box that holds `contentSlot` while the row is open. */
  contentClassName?: string | undefined;
};

/**
 * One row in a list of things you can open: a run, a task, an archived record. It is a
 * `ListItem` that opens — the same `Item` parts at `size="sm"`, words and hover as the rows beside
 * it that do not — and the opening is `Collapsible`'s. Like `ListItem` it draws no surface: the
 * list, card or section around it owns the border.
 *
 * The whole heading is one `CollapsibleTrigger`, and `actionSlot` sits outside it, because a
 * control nested in a button is invalid HTML and cannot be pressed. Open is controlled, since a
 * row is often opened from somewhere else, such as a deep link.
 */
export function CollapsibleRow({
  open,
  onOpenChange,
  title,
  badgesSlot,
  meta,
  description,
  actionSlot,
  contentSlot,
  className,
  contentClassName,
}: CollapsibleRowProps) {
  const contentId = React.useId();
  const isOpen = open && hasSlot(contentSlot);

  const heading = (
    <div className="cube-rn-view min-w-0 flex-row flex-wrap items-center gap-2">
      {badgesSlot}
      <span
        data-slot="collapsible-row-title"
        className={cn(
          // Grows from a 6rem floor rather than from its full width, so it keeps the badges' line
          // and truncates there; sized to its text, it wrapped under them as soon as `meta` took
          // the row's far end.
          'cube-rn-text',
          'min-w-0 flex-1 basis-24',
          HEADING_TITLE,
          // `truncate` is the ellipsis on the web; on device it is `numberOfLines`, which is
          // what `line-clamp-1` becomes and what `truncate` does not.
          'truncate',
        )}
      >
        {title}
      </span>
    </div>
  );

  return (
    <div data-slot="collapsible-row" className={cn('cube-rn-view', 'min-w-0', className)}>
      <Item data-slot="collapsible-row-heading" size="sm" className={cn('min-w-0', rowFillClass(false, true))}>
        <CollapsibleTrigger
          data-slot="collapsible-row-trigger"
          // The rhythm's wrap floor, as `ListItem`'s middle has: below it the actions wrap. Out to
          // the row's edges, as that middle is, so the whole lit heading opens the row.
          className={cn(
            HEADING_WRAP_FLOOR,
            'rounded-md',
            rowPressInsetClass({ leading: false, action: Boolean(actionSlot) }),
          )}
          open={open}
          onClick={() => onOpenChange(!open)}
          // Only while it is open: the body is unmounted when closed, which is what keeps a list
          // of two hundred rows cheap.
          controls={isOpen ? contentId : undefined}
          contentSlot={<ListItemText title={heading} description={description} meta={meta} />}
        />
        {hasSlot(actionSlot) ? <ItemActions data-slot="collapsible-row-action">{actionSlot}</ItemActions> : null}
      </Item>

      {isOpen ? (
        <div
          data-slot="collapsible-row-content"
          id={contentId}
          // Under the heading at the row's own inset, so it reads as this row's and not the next.
          className={cn('cube-rn-view', 'min-w-0 gap-2 px-3 pb-2', contentClassName)}
        >
          {contentSlot}
        </div>
      ) : null}
    </div>
  );
}

/** @deprecated Use `CollapsibleRow`; this name goes in the next release. */
export const DisclosureRow = CollapsibleRow;
