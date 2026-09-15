import { createFileRoute } from '@tanstack/react-router';
import { CardLayout } from '@/components/card-layout';
import { EmbedderBanner } from '@/components/memory/embedder-banner';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { GrowthCharts } from '@/components/viz/growth-charts';
import { formatCount, formatUptime } from '@/lib/format';
import { useServerStatus } from '@/lib/queries';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <CardLayout
      title={label}
      headerClassName="text-sm text-muted-foreground"
      content={
        <>
          <p className="text-3xl font-semibold tabular-nums">{value}</p>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </>
      }
    />
  );
}

export function OverviewPage() {
  const status = useServerStatus();
  const { data, isPending, error } = status;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader className="px-0 pt-0" title="Overview" description="What the memory store holds right now." />

      {isPending && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      {error && <QueryError what="the server status" error={error} onRetry={() => status.refetch()} />}

      {data && <EmbedderBanner stats={data.engine} />}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Turns" value={formatCount(data.engine.turns)} />
            <StatCard label="Sessions" value={formatCount(data.engine.sessions)} />
            <StatCard
              label="Entities"
              value={formatCount(data.engine.entities)}
              hint={`${formatCount(data.engine.edges)} co-occurrence edges`}
            />
            <StatCard
              label="Timeline"
              value={formatCount(data.engine.windows)}
              hint={`windows · ${formatCount(data.engine.episodes)} episodes`}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Embeddings"
              value={formatCount(data.engine.embeddings)}
              hint={data.engine.embedder ?? 'no embedder'}
            />
            <StatCard
              label="Generation"
              value={String(data.engine.generation)}
              hint={`schema v${data.engine.schema_version}`}
            />
            <StatCard
              label="Uptime"
              value={formatUptime(data.uptimeSeconds)}
              hint={`v${data.version}${data.readOnly ? ' · read-only' : ''}`}
            />
            <StatCard label="Auth" value={data.authEnabled ? 'token' : 'open'} hint="bearer token on /mcp and /api" />
          </div>
        </>
      )}

      {data && <GrowthCharts />}

      {data && <p className="text-xs text-muted-foreground">Store: {data.engine.home}</p>}
    </div>
  );
}
