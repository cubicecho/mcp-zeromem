import type { Health } from '@mcp-zeromem/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartCard } from '@/components/viz/chart-card';
import { ColumnChart } from '@/components/viz/column-chart';
import { LineChart, Sparkline } from '@/components/viz/line-chart';
import { formatCount, formatUptime } from '@/lib/format';
import { useHealth } from '@/lib/queries';

function formatMinute(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

function ms(value: number | null): string {
  return value === null ? '–' : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function Stat({ label, value, hint, spark }: { label: string; value: string; hint?: string; spark?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-2">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {spark}
      </CardContent>
    </Card>
  );
}

/**
 * What this server process has seen since it started: recall latency
 * percentiles and throughput per minute for the last hour, from the
 * in-memory counters behind `/api/viz/health`.
 */
export function HealthCharts() {
  const health = useHealth();
  if (health.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (health.error) {
    return <p className="text-sm text-destructive">Failed to load health series: {health.error.message}</p>;
  }
  const data: Health = health.data;
  const series = data.series;
  const minutes = series.map((m) => formatMinute(m.minute));
  const columns = [
    { key: 'minute', header: 'Minute', render: (m: Health['series'][number]) => formatMinute(m.minute) },
    {
      key: 'recalls',
      header: 'Recalls',
      align: 'right' as const,
      render: (m: Health['series'][number]) => formatCount(m.recalls),
    },
    {
      key: 'errors',
      header: 'Errors',
      align: 'right' as const,
      render: (m: Health['series'][number]) => formatCount(m.errors),
    },
    {
      key: 'ingested',
      header: 'Turns ingested',
      align: 'right' as const,
      render: (m: Health['series'][number]) => formatCount(m.ingested),
    },
    { key: 'p50', header: 'p50', align: 'right' as const, render: (m: Health['series'][number]) => ms(m.p50_ms) },
    { key: 'p95', header: 'p95', align: 'right' as const, render: (m: Health['series'][number]) => ms(m.p95_ms) },
  ];
  const anyActivity = series.some((m) => m.recalls > 0 || m.ingested > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Recall p50 / p95"
          value={`${ms(data.recall.p50_ms)} / ${ms(data.recall.p95_ms)}`}
          hint={`${formatCount(data.recall.count)} recalls · max ${ms(data.recall.max_ms)}`}
          spark={<Sparkline values={series.map((m) => m.p95_ms)} label="p95 per minute" />}
        />
        <Stat
          label="Recall errors"
          value={formatCount(data.recall.errors)}
          hint="since the process started"
          spark={<Sparkline values={series.map((m) => m.errors)} slot={8} label="errors per minute" />}
        />
        <Stat
          label="Ingested"
          value={formatCount(data.ingest.turns)}
          hint={`turns in ${formatCount(data.ingest.calls)} calls`}
          spark={<Sparkline values={series.map((m) => m.ingested)} slot={2} label="turns ingested per minute" />}
        />
        <Stat label="Cold open" value={ms(data.open_ms)} hint={`up ${formatUptime(data.uptime_seconds)}`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Recall latency"
          description="Per minute over the last hour; gaps are minutes with no recalls."
          rows={series}
          columns={columns}
          rowKey={(m) => String(m.minute)}
          loading={health.isFetching}
          empty={anyActivity ? undefined : 'No recalls yet this hour.'}
        >
          <LineChart
            x={minutes}
            series={[
              { key: 'p50', label: 'p50', slot: 1, values: series.map((m) => m.p50_ms) },
              { key: 'p95', label: 'p95', slot: 2, values: series.map((m) => m.p95_ms) },
            ]}
            formatValue={(v) => `${Math.round(v)} ms`}
            ariaLabel="Recall latency percentiles per minute"
          />
        </ChartCard>
        <ChartCard
          title="Throughput"
          description="Recalls served and turns ingested, per minute."
          rows={series}
          columns={columns}
          rowKey={(m) => String(m.minute)}
          loading={health.isFetching}
          empty={anyActivity ? undefined : 'Nothing served yet this hour.'}
        >
          <ColumnChart
            categories={minutes}
            series={[
              { key: 'recalls', label: 'Recalls', slot: 1, values: series.map((m) => m.recalls) },
              { key: 'ingested', label: 'Turns ingested', slot: 2, values: series.map((m) => m.ingested) },
              { key: 'errors', label: 'Errors', slot: 8, values: series.map((m) => m.errors) },
            ]}
            ariaLabel="Recalls, ingested turns and errors per minute"
          />
        </ChartCard>
      </div>
    </div>
  );
}
