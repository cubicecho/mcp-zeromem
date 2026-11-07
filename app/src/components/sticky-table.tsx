import type { ComponentProps } from 'react';
import { Table } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Pins the header row to the top of the nearest scrolling ancestor and the footer row to its
 * bottom. Collapsed borders do not travel with a sticky row, so the rule under the header (and
 * over the footer) is an inset shadow on the cells instead, and the cells get an opaque
 * background so rows do not show through.
 */
const STICKY_ROWS = [
  '[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead_tr]:border-0',
  '[&_thead_th]:bg-muted [&_thead_th]:shadow-[inset_0_-1px_0_var(--color-border)]',
  '[&_tfoot]:sticky [&_tfoot]:bottom-0 [&_tfoot]:z-10 [&_tfoot]:border-t-0',
  '[&_tfoot_td]:bg-muted [&_tfoot_td]:shadow-[inset_0_1px_0_var(--color-border)]',
].join(' ');

/**
 * cubeui's `Table` with its header row (and footer row) kept in view while the rows scroll.
 *
 * A sticky row sticks within its nearest scrolling ancestor, and `Table`'s own container is
 * `overflow-x-auto`, which makes it one. So the container is let out (`overflow-visible`), and the
 * table goes in the scrolling body of `<HeaderContentFooter scroll />` with a height to divide and
 * a body that scrolls both ways (`contentClassName="overflow-x-auto"`).
 */
export function StickyTable({ className, ...props }: ComponentProps<typeof Table>) {
  return (
    <div data-slot="sticky-table" className="[&>[data-slot=table-container]]:overflow-visible">
      <Table className={cn(STICKY_ROWS, className)} {...props} />
    </div>
  );
}
