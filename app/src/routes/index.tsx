import { createFileRoute } from '@tanstack/react-router';
import { EmbedderBanner } from '@/components/memory/embedder-banner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GrowthCharts } from '@/components/viz/growth-charts';
import { formatCount, formatUptime } from '@/lib/format';
import { useServerStatus } from '@/lib/queries';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const { data, isPending, error } = useServerStatus();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">What the memory store holds right now.</p>
      </div>

      {isPending && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      {error && <p className="text-sm text-destructive">Failed to load status: {error.message}</p>}

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
