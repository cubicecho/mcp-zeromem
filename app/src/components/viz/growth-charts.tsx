import { useMemo, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartCard } from '@/components/viz/chart-card';
import { ColumnChart } from '@/components/viz/column-chart';
import { LineChart } from '@/components/viz/line-chart';
import { formatCount } from '@/lib/format';
import { useGrowth } from '@/lib/queries';

const RANGES = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '365', label: 'Last year', days: 365 },
  { key: 'all', label: 'All time', days: null },
] as const;

const DAY_MS = 86_400_000;

function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)),
  );
}

/**
 * How the store has grown: turns per day (and the sessions active that
 * day) as columns, the running total as an area. Two charts because the
 * two measures do not share a scale.
 */
export function GrowthCharts() {
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('90');
  const days = RANGES.find((r) => r.key === range)?.days ?? null;
  const since = useMemo(() => {
    if (days === null) {
      return undefined;
    }
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    return start.getTime() - (days - 1) * DAY_MS;
  }, [days]);
  const growth = useGrowth(since !== undefined ? { since } : {});

  const rows = growth.data?.days ?? [];
  const control = (
    <Select value={range} onValueChange={(v) => setRange(v as typeof range)}>
      <SelectTrigger className="h-8 w-36 text-xs" aria-label="Growth range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGES.map((r) => (
          <SelectItem key={r.key} value={r.key}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const columns = [
    { key: 'day', header: 'Day', render: (d: (typeof rows)[number]) => d.day },
    {
      key: 'turns',
      header: 'Turns',
      align: 'right' as const,
      render: (d: (typeof rows)[number]) => formatCount(d.turns),
    },
    {
      key: 'sessions',
      header: 'Sessions',
      align: 'right' as const,
      render: (d: (typeof rows)[number]) => formatCount(d.sessions),
    },
    {
      key: 'cumulative',
      header: 'Total turns',
      align: 'right' as const,
      render: (d: (typeof rows)[number]) => formatCount(d.cumulative_turns),
    },
  ];

  if (growth.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (growth.error) {
    return <p className="text-sm text-destructive">Failed to load growth: {growth.error.message}</p>;
  }
  const x = rows.map((d) => d.day);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Turns per day"
        description="Turns by the day they were said, and the sessions active that day."
        controls={control}
        rows={rows}
        columns={columns}
        rowKey={(d) => d.day}
        loading={growth.isFetching}
        empty="No turns in this range."
      >
        <ColumnChart
          categories={x.map(formatDay)}
          series={[
            { key: 'turns', label: 'Turns', slot: 1, values: rows.map((d) => d.turns) },
            { key: 'sessions', label: 'Sessions active', slot: 2, values: rows.map((d) => d.sessions) },
          ]}
          ariaLabel="Turns and active sessions per day"
        />
      </ChartCard>
      <ChartCard
        title="Turns in the store"
        description="Running total, including everything before the range."
        rows={rows}
        columns={columns}
        rowKey={(d) => d.day}
        loading={growth.isFetching}
        empty="No turns in this range."
      >
        <LineChart
          x={x}
          formatX={formatDay}
          series={[
            { key: 'total', label: 'Total turns', slot: 1, area: true, values: rows.map((d) => d.cumulative_turns) },
          ]}
          ariaLabel="Cumulative turns over time"
        />
      </ChartCard>
    </div>
  );
}
