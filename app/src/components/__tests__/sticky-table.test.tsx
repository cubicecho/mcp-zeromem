import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HeaderContentFooter } from '@/components/header-content-footer';
import { StickyTable } from '@/components/sticky-table';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function Sessions({ sticky }: { sticky: boolean }) {
  const Shell = sticky ? StickyTable : Table;
  return (
    <Shell>
      <TableHeader>
        <TableRow>
          <TableHead>Session</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 50 }, (_, i) => `session-${i}`).map((id) => (
          <TableRow key={id}>
            <TableCell>{id}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>total</TableCell>
        </TableRow>
      </TableFooter>
    </Shell>
  );
}

describe('StickyTable', () => {
  // jsdom does no layout, so these pin the contract that makes the header row
  // stick in a browser: the row is positioned sticky, and nothing between it
  // and the chassis body is a scroll container that would capture it.
  it('pins the header and footer rows and lets its container out of scrolling', () => {
    render(<Sessions sticky />);
    const table = screen.getByRole('table');
    const container = table.parentElement as HTMLElement;
    expect(container).toHaveAttribute('data-slot', 'table-container');
    expect(container.parentElement).toHaveAttribute('data-slot', 'sticky-table');
    expect(container.parentElement).toHaveClass('[&>[data-slot=table-container]]:overflow-visible');
    expect(table).toHaveClass('[&_thead]:sticky', '[&_thead]:top-0', '[&_tfoot]:sticky', '[&_tfoot]:bottom-0');
  });

  it('leaves a plain table scrolling sideways inside its own container', () => {
    render(<Sessions sticky={false} />);
    const table = screen.getByRole('table');
    expect(table.parentElement).toHaveClass('overflow-x-auto');
    expect(table.parentElement?.parentElement).not.toHaveAttribute('data-slot', 'sticky-table');
    expect(table).not.toHaveClass('[&_thead]:sticky');
  });

  it('sits in the scrolling body of a HeaderContentFooter, under chrome that stays put', () => {
    render(
      <HeaderContentFooter
        scroll
        className="h-auto max-h-96"
        contentClassName="overflow-x-auto"
        headerSlot={<h2>Latest recording</h2>}
        contentSlot={<Sessions sticky />}
        footerSlot={<p>50 sessions</p>}
      />,
    );
    const body = screen.getByRole('table').closest('[data-slot=header-content-footer-content]');
    expect(body).toHaveClass('overflow-y-auto', 'overflow-x-auto', 'min-h-0');
    expect(screen.getByRole('heading', { name: 'Latest recording' }).closest('[data-slot]')).toHaveAttribute(
      'data-slot',
      'header-content-footer-header',
    );
    expect(screen.getByText('50 sessions').closest('[data-slot]')).toHaveAttribute(
      'data-slot',
      'header-content-footer-footer',
    );
  });
});
