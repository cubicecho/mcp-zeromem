import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeftIcon, WaypointsIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TurnList } from '@/components/viz/turn-list';
import { formatCount, formatDateTime } from '@/lib/format';
import { useSessionTurnsWithEntities } from '@/lib/queries';
import { entityKindColor } from '@/lib/viz';

export const Route = createFileRoute('/sessions_/$sessionId')({
  component: SessionInspectorPage,
});

function SessionInspectorPage() {
  const { sessionId } = Route.useParams();
  return <SessionInspector sessionId={sessionId} />;
}

/**
 * One session, in order, with every entity mention marked. Picking an
 * entity highlights it through the session and offers the graph, where the
 * same entity can be followed into other sessions.
 */
export function SessionInspector({ sessionId }: { sessionId: string }) {
  const turns = useSessionTurnsWithEntities(sessionId);
  const [highlight, setHighlight] = useState<string | null>(null);

  const entities = useMemo(() => {
    const counts = new Map<string, { key: string; kind: 'name' | 'date' | 'quantity'; mentions: number }>();
    for (const turn of turns.data?.turns ?? []) {
      for (const mention of turn.entities) {
        const entry = counts.get(mention.key) ?? { key: mention.key, kind: mention.kind, mentions: 0 };
        entry.mentions += 1;
        counts.set(mention.key, entry);
      }
    }
    return [...counts.values()].sort((a, b) => b.mentions - a.mentions || a.key.localeCompare(b.key));
  }, [turns.data]);

  const first = turns.data?.turns[0];
  const last = turns.data?.turns.at(-1);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/sessions">
            <ArrowLeftIcon /> Sessions
          </Link>
        </Button>
        <div>
          <h1 className="font-mono text-xl font-semibold">{sessionId}</h1>
          {turns.data && first && last && (
            <p className="text-sm text-muted-foreground">
              {formatCount(turns.data.turns.length)} turns · {formatDateTime(first.ts)} → {formatDateTime(last.ts)}
            </p>
          )}
        </div>
      </div>

      {turns.isPending && <Skeleton className="h-40 w-full" />}
      {turns.error && <p className="text-sm text-destructive">{turns.error.message}</p>}

      {turns.data && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <div className="rounded-md border p-4">
            <TurnList
              turns={turns.data.turns}
              highlight={highlight ?? undefined}
              onEntityClick={(key) => setHighlight(key === highlight ? null : key)}
            />
          </div>
          <aside className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Entities in this session</h2>
            {entities.length === 0 && <p className="text-sm text-muted-foreground">None recognised.</p>}
            <ul className="flex flex-col gap-1">
              {entities.map((entity) => (
                <li key={entity.key} className="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    className={
                      entity.key === highlight
                        ? 'flex min-w-0 flex-1 items-center gap-2 rounded-md bg-accent px-2 py-1 text-left'
                        : 'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent'
                    }
                    onClick={() => setHighlight(entity.key === highlight ? null : entity.key)}
                    aria-pressed={entity.key === highlight}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-[2px]"
                      style={{ background: entityKindColor(entity.kind) }}
                    />
                    <span className="truncate">{entity.key}</span>
                    <Badge variant="outline" className="ml-auto tabular-nums">
                      {entity.mentions}
                    </Badge>
                  </button>
                  <Button variant="ghost" size="icon-sm" asChild aria-label={`Show ${entity.key} in the graph`}>
                    <Link to="/graph" search={{ focus: entity.key }}>
                      <WaypointsIcon />
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}
    </div>
  );
}
