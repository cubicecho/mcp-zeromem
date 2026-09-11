import type { ReactNode, Ref } from 'react';

import { cn } from '@/lib/utils';

/**
 * The column a page's chrome and its content share.
 *
 * A header that caps itself while the table beneath it runs to the pane edge reads as two
 * screens stacked, and the mismatch is there at every width, not only past the cap: the header
 * carries its own inset and the table did not. One class, applied to every slot, is what keeps
 * the title above the first column rather than beside it.
 */
export const PAGE_COLUMN = 'mx-auto w-full max-w-(--breakpoint-2xl)';

/**
 * The reading column: a page of prose, a settings screen, a form.
 *
 * Narrower than {@link PAGE_COLUMN} because the constraint is a line length, not a viewport.
 * Both app shells that had grown a page component of their own defaulted to exactly this, and
 * then disagreed about what the *other* width was called — one said `max-w-5xl` and the other
 * `max-w-none`, both spelled `wide`. Naming the columns is what stops the third app inventing an
 * eleventh value: across these projects there are 51 capped page columns wearing 10 widths.
 */
export const PROSE_COLUMN = 'mx-auto w-full max-w-3xl';

const COLUMNS = {
  full: undefined,
  page: PAGE_COLUMN,
  prose: PROSE_COLUMN,
} as const;

type HeaderContentFooterProps = {
  /** The body. The only slot that grows. */
  content: ReactNode;
  /** Page title, toolbar, filters — whatever stays above the body. Absent, no row is drawn. */
  header?: ReactNode;
  /** Paging, totals, a save bar. Absent, no row is drawn. */
  footer?: ReactNode;
  /**
   * Whether the body scrolls inside the chassis rather than growing it.
   *
   * On, the header and footer stay put while the body moves, which needs the chassis to have a
   * height to divide — `h-full`, or a parent that gives it one. Off, the chassis is as tall as
   * what is in it and the page scrolls as a whole.
   */
  scroll?: boolean;
  /**
   * - `full` — slots fill whatever box the chassis was given. Print sheets, dialogs, and
   *   anything already inside its own column.
   * - `page` — slots share the capped, centred {@link PAGE_COLUMN}, inset to match the header.
   *   Every list page, every board.
   * - `prose` — the narrower {@link PROSE_COLUMN}. Settings, a detail page, a form.
   */
  width?: keyof typeof COLUMNS;
  /** The scrolling body, for a caller that has to reach it — restoring a scroll position. */
  contentRef?: Ref<HTMLDivElement>;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
};

/**
 * Header, body, footer, in a column.
 *
 * A flex column rather than three fixed grid rows, because the rows only line up when all three
 * slots are present: with `grid-rows-[min-content_1fr_min-content]` and no header, the body
 * auto-places into the min-content row and is squashed to its own text, and any `gap` on the
 * chassis is still spent on the slots that are not there. Flex gives the same shape — the body
 * takes the leftover, the chrome takes what it needs — and an absent slot costs nothing.
 *
 * `min-h-0` / `min-w-0` on the body is not decoration. A flex item's floor is its content, so
 * one wide child — a table, a long unbroken string — grows the chassis and pushes the chrome off
 * the screen instead of scrolling inside it, and `scroll` does nothing at all without the floor.
 */
export function HeaderContentFooter({
  content,
  header,
  footer,
  scroll = false,
  width = 'full',
  contentRef,
  className,
  headerClassName,
  contentClassName,
  footerClassName,
}: HeaderContentFooterProps) {
  // The header slot stays unpadded: a page header carries its own `px-4`, and the body matches
  // it so the two edges line up.
  const column = COLUMNS[width];
  const headerColumn = column;
  const bodyColumn = column && cn(column, 'px-4');

  return (
    <div data-slot="header-content-footer" className={cn('flex min-h-0 min-w-0 flex-col', className)}>
      {header ? (
        <div data-slot="header-content-footer-header" className={cn('min-w-0 shrink-0', headerColumn, headerClassName)}>
          {header}
        </div>
      ) : null}

      <div
        data-slot="header-content-footer-content"
        ref={contentRef}
        // A scrolling region a keyboard cannot reach is a region a keyboard user cannot read:
        // the mouse wheel moves it and nothing else does, which axe reports as
        // `scrollable-region-focusable`. A tab stop is the fix the rule asks for, and it costs
        // nothing when the body already holds focusable children — the caret goes to them next.
        tabIndex={scroll ? 0 : undefined}
        className={cn('relative min-h-0 min-w-0 flex-1', scroll && 'overflow-y-auto', bodyColumn, contentClassName)}
      >
        {content}
      </div>

      {footer ? (
        <div data-slot="header-content-footer-footer" className={cn('min-w-0 shrink-0', bodyColumn, footerClassName)}>
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The same chassis with the body scrolling and the chrome pinned — a list page, a pane inside a
 * split, anything whose header should not leave with the rows.
 *
 * It needs a height to divide, so it defaults to filling its parent.
 */
export function StickyHeaderContentFooter({ className, ...props }: Omit<HeaderContentFooterProps, 'scroll'>) {
  return <HeaderContentFooter scroll {...props} className={cn('h-full', className)} />;
}
