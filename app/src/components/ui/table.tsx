'use client';

import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Pins the header row to the top of the nearest scrolling ancestor and the
 * footer row to its bottom. Collapsed borders do not travel with a sticky row,
 * so the rule under the header (and over the footer) is an inset shadow on the
 * cells instead, and the cells get an opaque background so rows do not show
 * through.
 */
const STICKY_TABLE = [
  '[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead_tr]:border-0',
  '[&_thead_th]:bg-muted [&_thead_th]:shadow-[inset_0_-1px_0_var(--color-border)]',
  '[&_tfoot]:sticky [&_tfoot]:bottom-0 [&_tfoot]:z-10 [&_tfoot]:border-t-0',
  '[&_tfoot_td]:bg-muted [&_tfoot_td]:shadow-[inset_0_1px_0_var(--color-border)]',
].join(' ');

function Table({
  className,
  sticky = false,
  ...props
}: React.ComponentProps<'table'> & {
  /**
   * Keep the header row (and footer row) in view while the rows scroll.
   *
   * A sticky row sticks within its nearest scrolling ancestor, so the table's
   * own wrapper stops being one: put the table in the scrolling body of a
   * `StickyHeaderContentFooter` (`@/components/header-content-footer`), give
   * that a height to divide, and let the body scroll both ways.
   */
  sticky?: boolean;
}) {
  return (
    <div
      data-slot="table-container"
      data-sticky={sticky || undefined}
      className={cn('relative w-full', !sticky && 'overflow-x-auto')}
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', sticky && STICKY_TABLE, className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption data-slot="table-caption" className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
