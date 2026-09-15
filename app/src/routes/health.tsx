import { createFileRoute } from '@tanstack/react-router';
import { EmbedderBanner } from '@/components/memory/embedder-banner';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Skeleton } from '@/components/ui/skeleton';
import { HealthCharts } from '@/components/viz/health-charts';
import { useServerStatus } from '@/lib/queries';

export const Route = createFileRoute('/health')({
  component: HealthPage,
});

/** The process counters as charts, then the raw `/api/status` payload the Docker healthcheck sees. */
export function HealthPage() {
  const status = useServerStatus();
  const { data, isPending, error } = status;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="px-0 pt-0"
        title="Health"
        description="What this server process has served since it started, and the status endpoint as the healthcheck sees it."
      />
      <HealthCharts />
      {isPending && <Skeleton className="h-64 w-full" />}
      {error && <QueryError what="the server status" error={error} onRetry={() => status.refetch()} />}
      {data && <EmbedderBanner stats={data.engine} />}
      {data && (
        <Section
          title="Status payload"
          content={
            <pre className="overflow-x-auto rounded-md border bg-muted p-4 font-mono text-xs">
              {JSON.stringify(data, null, 2)}
            </pre>
          }
        />
      )}
    </div>
  );
}
