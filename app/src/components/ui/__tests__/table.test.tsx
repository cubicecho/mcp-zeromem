import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StickyHeaderContentFooter } from '@/components/header-content-footer';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '../table';

function Sessions({ sticky }: { sticky: boolean }) {
  return (
    <Table sticky={sticky}>
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
    </Table>
  );
}

describe('Table', () => {
  // jsdom does no layout, so these pin the contract that makes the header row
  // stick in a browser: the row is positioned sticky, and nothing between it
  // and the chassis body is a scroll container that would capture it.
  it('pins the header and footer rows and leaves the scrolling to its ancestor when sticky', () => {
    render(<Sessions sticky />);
    const table = screen.getByRole('table');
    const wrapper = table.parentElement as HTMLElement;
    expect(wrapper).toHaveAttribute('data-sticky', 'true');
    expect(wrapper).not.toHaveClass('overflow-x-auto');
    expect(table).toHaveClass('[&_thead]:sticky', '[&_thead]:top-0', '[&_tfoot]:sticky', '[&_tfoot]:bottom-0');
  });

  it('scrolls a plain table sideways inside its own wrapper', () => {
    render(<Sessions sticky={false} />);
    const table = screen.getByRole('table');
    expect(table.parentElement).not.toHaveAttribute('data-sticky');
    expect(table.parentElement).toHaveClass('overflow-x-auto');
    expect(table).not.toHaveClass('[&_thead]:sticky');
  });

  it('sits in the scrolling body of a StickyHeaderContentFooter, under chrome that stays put', () => {
    render(
      <StickyHeaderContentFooter
        className="h-auto max-h-96"
        contentClassName="overflow-x-auto"
        header={<h2>Latest recording</h2>}
        content={<Sessions sticky />}
        footer={<p>50 sessions</p>}
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
