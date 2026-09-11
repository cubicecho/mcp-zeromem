import type { Point2D } from '@mcp-zeromem/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { SearchIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartCard } from '@/components/viz/chart-card';
import { Legend } from '@/components/viz/legend';
import { Scatter } from '@/components/viz/scatter';
import { formatCount, formatDateTime, formatPercent } from '@/lib/format';
import { useProjection, useServerStatus, useSessions } from '@/lib/queries';
import { excerpt, SlotMap } from '@/lib/viz';

const searchSchema = z.object({
  session: z.string().trim().min(1).optional().catch(undefined),
  limit: z.number().int().min(2).max(10_000).optional().catch(undefined),
  query: z.string().trim().min(1).optional().catch(undefined),
});
type Search = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/embeddings')({
  component: EmbeddingsPage,
  validateSearch: searchSchema,
});

function EmbeddingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/embeddings' });
  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });
  return <EmbeddingMap options={search} onChange={setSearch} />;
}

/**
 * The dense view's vectors on their two principal axes. A real embedder
 * clusters by topic; the hash fallback scatters, which is the quickest
 * way to see that the fallback is in use. A query lands as a diamond with
 * its nearest turns ringed.
 */
export function EmbeddingMap({ options, onChange }: { options: Search; onChange: (patch: Partial<Search>) => void }) {
  const projection = useProjection({
    limit: options.limit ?? 2000,
    ...(options.session ? { session: options.session } : {}),
    ...(options.query ? { query: options.query } : {}),
  });
  const sessions = useSessions({ limit: 500 });
  const status = useServerStatus();
  const [queryText, setQueryText] = useState(options.query ?? '');
  const [picked, setPicked] = useState<Point2D | null>(null);

  const points = projection.data?.points ?? [];
  const colors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of points) {
      counts.set(p.session_id, (counts.get(p.session_id) ?? 0) + 1);
    }
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
    return new SlotMap(ordered);
  }, [points]);

  const submitQuery = (event: FormEvent) => {
    event.preventDefault();
    onChange({ query: queryText.trim() || undefined });
  };

  const fallback = status.data?.engine.embedder_is_fallback ?? false;
  const backlog = status.data?.engine.embedding_backlog ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Embedding map</h1>
        <p className="text-sm text-muted-foreground">
          Turn vectors projected onto their two principal axes. Nearby points say similar things, as far as the embedder
          can tell.
        </p>
      </div>

      {fallback && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md border border-[var(--viz-warning)] bg-[var(--viz-warning)]/10 px-3 py-2 text-sm"
        >
          <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
          The store was embedded with the hash fallback, so this map shows word overlap rather than meaning: expect
          little structure.
        </p>
      )}
      {backlog > 0 && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md border border-[var(--viz-series-1)] bg-[var(--viz-series-1)]/10 px-3 py-2 text-sm"
        >
          <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
          {formatCount(backlog)} turns are still being re-embedded; the map settles as their vectors arrive.{' '}
          <Link to="/settings" className="underline underline-offset-4">
            Progress
          </Link>
        </p>
      )}

      <form onSubmit={submitQuery} className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <Label htmlFor="embed-query">Drop a query onto the map</Label>
          <div className="flex gap-2">
            <Input
              id="embed-query"
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              placeholder="who owns the billing service?"
            />
            <Button type="submit" variant="secondary">
              <SearchIcon /> Place
            </Button>
            {options.query && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Clear query"
                onClick={() => {
                  setQueryText('');
                  onChange({ query: undefined });
                }}
              >
                <XIcon />
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="embed-session">Session</Label>
          <Select
            value={options.session ?? 'all'}
            onValueChange={(v) => onChange({ session: v === 'all' ? undefined : v })}
          >
            <SelectTrigger id="embed-session" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sessions</SelectItem>
              {sessions.data?.sessions.map((s) => (
                <SelectItem key={s.session_id} value={s.session_id}>
                  {s.session_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="embed-limit">Points</Label>
          <Select value={String(options.limit ?? 2000)} onValueChange={(v) => onChange({ limit: Number(v) })}>
            <SelectTrigger id="embed-limit" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[500, 1000, 2000, 5000, 10000].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </form>

      {projection.isPending && <Skeleton className="h-[480px] w-full" />}
      {projection.error && <p className="text-sm text-destructive">Failed to project: {projection.error.message}</p>}

      {projection.data && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <ChartCard
            title="Turns on the projection plane"
            description={`${formatCount(points.length)} of ${formatCount(projection.data.total)} vectors · ${projection.data.embedder} · axes carry ${formatPercent(projection.data.basis.variance_explained[0])} and ${formatPercent(projection.data.basis.variance_explained[1])} of the variance`}
            rows={points}
            columns={[
              { key: 'id', header: 'Turn', render: (p) => <span className="font-mono text-xs">#{p.turn_id}</span> },
              {
                key: 'session',
                header: 'Session',
                render: (p) => <span className="font-mono text-xs">{p.session_id}</span>,
              },
              { key: 'speaker', header: 'Speaker', render: (p) => p.speaker },
              { key: 'x', header: 'x', align: 'right', render: (p) => p.x.toFixed(3) },
              { key: 'y', header: 'y', align: 'right', render: (p) => p.y.toFixed(3) },
              { key: 'text', header: 'Text', render: (p) => excerpt(p.text, 80) },
            ]}
            rowKey={(p) => String(p.turn_id)}
            loading={projection.isFetching}
            empty="No vectors to project. The store has no dense view, or fewer than two embedded turns."
          >
            <div className="flex flex-col gap-2">
              <Legend
                items={colors.legend().map((item) => ({ key: item.key, label: item.key, color: item.color }))}
                other={colors.overflow > 0 ? `${colors.overflow} more sessions` : undefined}
              />
              <Scatter points={points} query={projection.data.query} colors={colors} onPick={setPicked} />
            </div>
          </ChartCard>
          <aside className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto rounded-md border p-4">
            {projection.data.query && (
              <div>
                <h2 className="text-sm font-medium">Nearest to the query</h2>
                <p className="mb-2 text-xs text-muted-foreground">“{projection.data.query.text}”</p>
                <ol className="flex flex-col gap-2">
                  {projection.data.query.neighbours.map((id) => {
                    const p = points.find((point) => point.turn_id === id);
                    return (
                      <li key={id} className="text-xs">
                        <span className="font-mono">#{id}</span>
                        {p ? (
                          <>
                            {' '}
                            <span className="text-muted-foreground">{p.session_id}</span>
                            <p>{excerpt(p.text)}</p>
                          </>
                        ) : (
                          <span className="text-muted-foreground"> (not in the sampled points)</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
            <div>
              <h2 className="text-sm font-medium">Picked turn</h2>
              {!picked && <p className="text-xs text-muted-foreground">Click a point.</p>}
              {picked && (
                <div className="text-sm">
                  <p className="text-xs text-muted-foreground">
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: picked.session_id }}
                      className="font-mono underline"
                    >
                      {picked.session_id}
                    </Link>{' '}
                    · {picked.speaker} · {formatDateTime(picked.ts)}
                  </p>
                  <p className="whitespace-pre-wrap">{picked.text}</p>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
