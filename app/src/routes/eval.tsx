import type { EvalHistory } from '@mcp-zeromem/shared';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChartCard } from '@/components/viz/chart-card';
import { Legend } from '@/components/viz/legend';
import { LineChart } from '@/components/viz/line-chart';
import { formatCount, formatDateTime, formatPercent } from '@/lib/format';
import { useEvalHistory } from '@/lib/queries';
import { SlotMap } from '@/lib/viz';

export const Route = createFileRoute('/eval')({
  component: EvalPage,
});

type Run = EvalHistory['runs'][number];
type Metric = 'recall_at_k' | 'mrr' | 'ndcg_at_k';

const METRICS: { key: Metric; label: (k: number) => string; blurb: string }[] = [
  {
    key: 'recall_at_k',
    label: (k) => `Recall@${k}`,
    blurb: 'Share of the relevant turns that made the top k, over the number that could have fit.',
  },
  { key: 'mrr', label: () => 'MRR', blurb: 'Mean reciprocal rank of the first relevant turn.' },
  {
    key: 'ndcg_at_k',
    label: (k) => `nDCG@${k}`,
    blurb: 'Graded: a turn stating the current value counts more than a superseded one.',
  },
];

/** One line per profile × embedder; the same key names the colour slot everywhere on the page. */
function seriesKey(run: Run): string {
  return `${run.profile} · ${run.embedder}`;
}

/** Group by recording so the same commit measured twice is two x positions, not one. */
function pointKey(run: Run): string {
  return `${run.recorded_at}|${run.commit}`;
}

function shortCommit(commit: string): string {
  return commit.length > 10 ? commit.slice(0, 10) : commit;
}

/**
 * The quality gate over time: every row of `docs/eval/history.jsonl`, one
 * line per profile × embedder, one x position per recording.
 */
export function EvalDashboard() {
  const history = useEvalHistory();
  const [profile, setProfile] = useState<string>('all');

  const runs = useMemo(() => history.data?.runs ?? [], [history.data]);
  const profiles = useMemo(() => [...new Set(runs.map((r) => r.profile))].sort(), [runs]);
  const shown = useMemo(() => (profile === 'all' ? runs : runs.filter((r) => r.profile === profile)), [runs, profile]);
  const keys = useMemo(() => [...new Set(shown.map(seriesKey))].sort(), [shown]);
  const colors = useMemo(() => new SlotMap(keys), [keys]);
  const points = useMemo(() => {
    const seen = new Map<string, Run>();
    for (const run of shown) {
      const key = pointKey(run);
      if (!seen.has(key)) {
        seen.set(key, run);
      }
    }
    return [...seen.values()].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  }, [shown]);
  const k = shown[0]?.k ?? 5;

  if (history.isPending) {
    return <Skeleton className="h-80 w-full" />;
  }
  if (history.error) {
    return <p className="text-sm text-destructive">Failed to load eval history: {history.error.message}</p>;
  }
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        <p>No eval runs recorded yet.</p>
        <p className="mt-2">
          Run <code className="rounded bg-muted px-1">scripts/record-eval.sh</code> to score the labeled queries and
          append a row to <code className="rounded bg-muted px-1">{history.data.source}</code>.
        </p>
      </div>
    );
  }

  const latestAt = points.at(-1)?.recorded_at;
  const latest = shown.filter((r) => r.recorded_at === latestAt);
  const x = points.map(pointKey);
  const formatX = (key: string) => shortCommit(key.split('|')[1] ?? key);
  const lookup = new Map(shown.map((r) => [`${seriesKey(r)}|${pointKey(r)}`, r]));
  const legend = colors.legend().map((l) => ({ ...l, label: l.key }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={profile} onValueChange={setProfile}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Corpus profile">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All profiles</SelectItem>
            {profiles.map((p) => (
              <SelectItem key={p} value={p}>
                {p} corpus
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Legend items={legend} other={colors.overflow > 0 ? `${colors.overflow} more` : undefined} shape="line" />
        <span className="ml-auto text-xs text-muted-foreground">
          {formatCount(points.length)} recordings · {history.data.source}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {METRICS.map((metric) => (
          <ChartCard
            key={metric.key}
            title={metric.label(k)}
            description={metric.blurb}
            rows={shown}
            columns={[
              { key: 'series', header: 'Series', render: (r: Run) => seriesKey(r) },
              { key: 'commit', header: 'Commit', render: (r: Run) => shortCommit(r.commit) },
              {
                key: 'value',
                header: metric.label(k),
                align: 'right' as const,
                render: (r: Run) => formatPercent(r[metric.key]),
              },
            ]}
            rowKey={(r) => `${seriesKey(r)}|${pointKey(r)}`}
            loading={history.isFetching}
          >
            <LineChart
              x={x}
              formatX={formatX}
              formatValue={(v) => formatPercent(v)}
              series={keys.map((key) => ({
                key,
                label: key,
                slot: colors.slot(key),
                values: x.map((p) => lookup.get(`${key}|${p}`)?.[metric.key] ?? null),
              }))}
              ariaLabel={`${metric.label(k)} per commit`}
            />
          </ChartCard>
        ))}
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-medium">Latest recording</h2>
          {latestAt && <span className="text-xs text-muted-foreground">{formatDateTime(Date.parse(latestAt))}</span>}
          {latest[0]?.label && <Badge variant="outline">{latest[0].label}</Badge>}
        </div>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Profile</TableHead>
                <TableHead>Embedder</TableHead>
                <TableHead>Commit</TableHead>
                <TableHead className="text-right">Queries</TableHead>
                <TableHead className="text-right">Recall@{k}</TableHead>
                <TableHead className="text-right">MRR</TableHead>
                <TableHead className="text-right">nDCG@{k}</TableHead>
                <TableHead className="text-right">Missed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latest.map((r) => (
                <TableRow key={`${seriesKey(r)}|${pointKey(r)}`}>
                  <TableCell>{r.profile}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block size-2.5 rounded-sm"
                        style={{ backgroundColor: colors.color(seriesKey(r)) }}
                        aria-hidden
                      />
                      {r.embedder}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{shortCommit(r.commit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(r.queries)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(r.recall_at_k)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(r.mrr)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(r.ndcg_at_k)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(r.missed)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          Missed is the number of labeled queries with no relevant turn in the top {k}. Rows come from{' '}
          <code className="rounded bg-muted px-1">scripts/record-eval.sh</code>, which runs the harness and appends one
          line per profile × embedder.
        </p>
      </section>
    </div>
  );
}

function EvalPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Eval</h1>
        <p className="text-sm text-muted-foreground">
          Retrieval quality on the labeled query set, per commit. This is the gate; the charts make it visible.
        </p>
      </div>
      <EvalDashboard />
    </div>
  );
}
