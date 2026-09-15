import type { HierarchySession } from '@mcp-zeromem/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ScanSearchIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { ActionButton } from '@/components/action-button';
import { OptionSelect } from '@/components/option-select';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartCard } from '@/components/viz/chart-card';
import { Legend } from '@/components/viz/legend';
import { EPISODE_COLOR, Timeline, type TimeRange, WINDOW_COLOR } from '@/components/viz/timeline';
import { TurnList } from '@/components/viz/turn-list';
import { formatCount, formatDateTime } from '@/lib/format';
import { useHierarchy, useSessionTurnsWithEntities } from '@/lib/queries';

const searchSchema = z.object({
  since: z.number().int().optional().catch(undefined),
  until: z.number().int().optional().catch(undefined),
  limit: z.number().int().min(1).max(500).optional().catch(undefined),
  session: z.string().trim().min(1).optional().catch(undefined),
});

export const Route = createFileRoute('/timeline')({
  component: TimelinePage,
  validateSearch: searchSchema,
});

type Search = z.infer<typeof searchSchema>;

const SESSION_LIMIT_OPTIONS = [20, 50, 100, 200, 500].map((n) => ({ value: String(n), label: `${n} sessions` }));

function TimelinePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/timeline' });
  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });
  return <TimelineExplorer options={search} onChange={setSearch} />;
}

/**
 * The temporal hierarchy: how the engine cut each session into windows and
 * episodes. Brushing a range lists the turns under it for the selected
 * session; zooming narrows the query to that range.
 */
export function TimelineExplorer({
  options,
  onChange,
}: {
  options: Search;
  onChange: (patch: Partial<Search>) => void;
}) {
  const snapshot = useHierarchy({
    limit: options.limit ?? 50,
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
    ...(options.session ? { session: options.session } : {}),
  });
  const [brush, setBrush] = useState<TimeRange | null>(null);
  const [selected, setSelected] = useState<string | null>(options.session ?? null);

  const sessions = snapshot.data?.sessions ?? [];
  const extent = useMemo<TimeRange | null>(() => {
    if (sessions.length === 0) {
      return null;
    }
    const since = options.since ?? Math.min(...sessions.map((s) => s.first_ts));
    const until = options.until ?? Math.max(...sessions.map((s) => s.last_ts));
    const pad = Math.max(60_000, (until - since) * 0.02);
    return { since: since - pad, until: until + pad };
  }, [sessions, options.since, options.until]);

  const selectedSession = sessions.find((s) => s.session_id === selected) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="px-0 pt-0"
        title="Timeline"
        description="Each session as a lane. The light bands are the windows the engine cut it into; the darker segments are the episodes inside them. Drag to brush a range, click a lane to pick a session."
        content={
          <div className="flex flex-wrap items-center gap-3">
            <OptionSelect
              className="w-36"
              aria-label="Sessions shown"
              options={SESSION_LIMIT_OPTIONS}
              value={String(options.limit ?? 50)}
              onValueChange={(v) => onChange({ limit: Number(v) })}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={brush === null}
              onClick={() => {
                if (brush) {
                  onChange({ since: Math.floor(brush.since), until: Math.ceil(brush.until) });
                  setBrush(null);
                }
              }}
            >
              <ZoomInIcon /> Zoom to brush
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={options.since === undefined && options.until === undefined && !options.session}
              onClick={() => {
                onChange({ since: undefined, until: undefined, session: undefined });
                setBrush(null);
              }}
            >
              <ZoomOutIcon /> Reset
            </Button>
            {(options.since !== undefined || options.until !== undefined) && (
              <span className="text-xs text-muted-foreground">
                {options.since !== undefined ? formatDateTime(options.since) : '…'} →{' '}
                {options.until !== undefined ? formatDateTime(options.until) : '…'}
              </span>
            )}
          </div>
        }
      />

      {snapshot.isPending && <Skeleton className="h-64 w-full" />}
      {snapshot.error && <QueryError what="the timeline" error={snapshot.error} onRetry={() => snapshot.refetch()} />}

      {snapshot.data && extent && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <ChartCard
            title="Sessions, windows, episodes"
            description={`${formatCount(sessions.length)} of ${formatCount(snapshot.data.total_sessions)} sessions in range`}
            rows={sessions}
            columns={[
              {
                key: 'session',
                header: 'Session',
                render: (s) => <span className="font-mono text-xs">{s.session_id}</span>,
              },
              { key: 'turns', header: 'Turns', align: 'right', render: (s) => formatCount(s.turns) },
              { key: 'windows', header: 'Windows', align: 'right', render: (s) => formatCount(s.windows.length) },
              { key: 'episodes', header: 'Episodes', align: 'right', render: (s) => formatCount(s.episodes.length) },
              { key: 'first', header: 'First', render: (s) => formatDateTime(s.first_ts) },
              { key: 'last', header: 'Last', render: (s) => formatDateTime(s.last_ts) },
            ]}
            rowKey={(s) => s.session_id}
            loading={snapshot.isFetching}
            empty="No sessions in this range."
          >
            <div className="flex flex-col gap-2">
              <Legend
                items={[
                  { key: 'window', label: 'Window', color: WINDOW_COLOR },
                  { key: 'episode', label: 'Episode', color: EPISODE_COLOR },
                ]}
              />
              <div className="max-h-[70vh] overflow-y-auto">
                <Timeline
                  sessions={sessions}
                  range={extent}
                  brush={brush}
                  onBrush={setBrush}
                  selected={selected}
                  onSelect={setSelected}
                />
              </div>
            </div>
          </ChartCard>
          <BrushPanel session={selectedSession} brush={brush} />
        </div>
      )}
      {snapshot.data && !extent && <p className="text-sm text-muted-foreground">No sessions yet.</p>}
    </div>
  );
}

function BrushPanel({ session, brush }: { session: HierarchySession | null; brush: TimeRange | null }) {
  const turns = useSessionTurnsWithEntities(session?.session_id ?? null);
  const inRange = useMemo(() => {
    const all = turns.data?.turns ?? [];
    return brush ? all.filter((t) => t.ts >= brush.since && t.ts <= brush.until) : all;
  }, [turns.data, brush]);

  if (!session) {
    return (
      <aside className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        Click a lane to read that session's turns; brush a range to narrow them.
      </aside>
    );
  }
  const segments = brush
    ? session.episodes.filter((e) => e.end_ts >= brush.since && e.start_ts <= brush.until)
    : session.episodes;
  return (
    <aside className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto rounded-md border p-4">
      <div>
        <h2 className="flex items-center gap-2 font-mono text-sm font-semibold">
          {session.session_id}
          <ActionButton variant="ghost" size="icon-sm" asChild label="Open in the session inspector">
            <Link to="/sessions/$sessionId" params={{ sessionId: session.session_id }}>
              <ScanSearchIcon />
            </Link>
          </ActionButton>
        </h2>
        <p className="text-xs text-muted-foreground">
          {brush
            ? `${formatDateTime(brush.since)} → ${formatDateTime(brush.until)} · ${formatCount(inRange.length)} turns`
            : `${formatCount(session.turns)} turns · ${formatCount(session.windows.length)} windows · ${formatCount(session.episodes.length)} episodes`}
        </p>
      </div>
      {segments.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-medium">Episodes {brush ? 'in range' : ''}</h3>
          <ul className="flex flex-col gap-1 text-xs">
            {segments.map((e) => (
              <li key={e.first_turn_id} className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="mt-1 size-2 shrink-0 rounded-[2px]"
                  style={{ background: EPISODE_COLOR }}
                />
                <span>
                  {formatDateTime(e.start_ts)} · {formatCount(e.turns)} turns
                  {e.entities.length > 0 && (
                    <span className="text-muted-foreground"> · {e.entities.slice(0, 4).join(', ')}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-sm font-medium">Turns</h3>
        {turns.isPending && <Skeleton className="h-20 w-full" />}
        {turns.error && <QueryError what="the turns" error={turns.error} onRetry={() => turns.refetch()} />}
        {turns.data && <TurnList turns={inRange} />}
      </div>
    </aside>
  );
}
