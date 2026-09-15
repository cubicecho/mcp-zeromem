import { TableIcon, TrendingUpIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ActionButton } from '@/components/action-button';
import { CardLayout } from '@/components/card-layout';
import { StickyHeaderContentFooter } from '@/components/header-content-footer';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface TableColumn<Row> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  render: (row: Row) => ReactNode;
}

/**
 * The frame around every chart: a title, an optional right-hand control
 * slot, the chart, and a toggle to the same data as a table. The table view
 * is the accessible twin and the way to read exact values.
 */
export function ChartCard<Row>({
  title,
  description,
  controls,
  rows,
  columns,
  rowKey,
  loading = false,
  empty,
  children,
}: {
  title: string;
  description?: string;
  controls?: ReactNode;
  rows: Row[];
  columns: TableColumn<Row>[];
  rowKey: (row: Row) => string;
  /** A refetch is in flight: the previous render stays, dimmed. */
  loading?: boolean;
  /** Shown instead of the chart when there are no rows. */
  empty?: string;
  children: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <CardLayout
      title={title}
      description={description}
      action={
        <div className="flex items-center gap-1">
          {controls}
          <ActionButton
            variant="ghost"
            size="icon-sm"
            label={view === 'chart' ? 'Show as table' : 'Show as chart'}
            aria-pressed={view === 'table'}
            onClick={() => setView(view === 'chart' ? 'table' : 'chart')}
          >
            {view === 'chart' ? <TableIcon /> : <TrendingUpIcon />}
          </ActionButton>
        </div>
      }
      contentClassName={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}
      content={
        <div aria-busy={loading}>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{empty ?? 'Nothing to chart yet.'}</p>
          ) : view === 'chart' ? (
            children
          ) : (
            <StickyHeaderContentFooter
              className="h-auto max-h-80"
              contentClassName="overflow-x-auto rounded-md border"
              content={
                <Table sticky>
                  <TableHeader>
                    <TableRow>
                      {columns.map((column) => (
                        <TableHead key={column.key} className={column.align === 'right' ? 'text-right' : undefined}>
                          {column.header}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={rowKey(row)}>
                        {columns.map((column) => (
                          <TableCell
                            key={column.key}
                            className={column.align === 'right' ? 'text-right tabular-nums' : undefined}
                          >
                            {column.render(row)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              }
            />
          )}
        </div>
      }
    />
  );
}
