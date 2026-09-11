import { createFileRoute } from '@tanstack/react-router';
import { EmbedderBanner } from '@/components/memory/embedder-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { HealthCharts } from '@/components/viz/health-charts';
import { useServerStatus } from '@/lib/queries';

export const Route = createFileRoute('/health')({
  component: HealthPage,
});

/** The process counters as charts, then the raw `/api/status` payload the Docker healthcheck sees. */
export function HealthPage() {
  const { data, isPending, error } = useServerStatus();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Health</h1>
        <p className="text-sm text-muted-foreground">
          What this server process has served since it started, and the status endpoint as the healthcheck sees it.
        </p>
      </div>
      <HealthCharts />
      {isPending && <Skeleton className="h-64 w-full" />}
      {error && <p className="text-sm text-destructive">Failed to load status: {error.message}</p>}
      {data && <EmbedderBanner stats={data.engine} />}
      {data && <h2 className="text-lg font-medium">Status payload</h2>}
      {data && (
        <pre className="overflow-x-auto rounded-md border bg-muted p-4 font-mono text-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
