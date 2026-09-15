import { type EntityKind, entityKindSchema, type GraphOptions } from '@mcp-zeromem/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { CrosshairIcon, XIcon } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { z } from 'zod';
import { ActionButton } from '@/components/action-button';
import { FormField } from '@/components/form-field';
import { EvidenceList } from '@/components/memory/evidence-list';
import { OptionSelect } from '@/components/option-select';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartCard } from '@/components/viz/chart-card';
import { ForceGraph } from '@/components/viz/force-graph';
import { Legend } from '@/components/viz/legend';
import { formatCount } from '@/lib/format';
import { useGraph, useRecall } from '@/lib/queries';
import { entityKindColor } from '@/lib/viz';

const searchSchema = z.object({
  focus: z.string().trim().min(1).optional().catch(undefined),
  hops: z.number().int().min(0).max(3).optional().catch(undefined),
  kind: z.enum(entityKindSchema.options).optional().catch(undefined),
  limit: z.number().int().min(1).max(2000).optional().catch(undefined),
  min_weight: z.number().int().min(1).optional().catch(undefined),
});

export const Route = createFileRoute('/graph')({
  component: GraphPage,
  validateSearch: searchSchema,
});

const KIND_LABEL: Record<EntityKind, string> = {
  name: 'Names',
  date: 'Dates',
  quantity: 'Quantities',
  path: 'Paths',
  symbol: 'Symbols',
  env: 'Env vars',
};

const KIND_LEGEND = entityKindSchema.options.map((kind) => ({
  key: kind,
  label: KIND_LABEL[kind],
  color: entityKindColor(kind),
}));

const numberOptions = (values: number[]) => values.map((n) => ({ value: String(n), label: String(n) }));
const HOP_OPTIONS = numberOptions([0, 1, 2, 3]);
const NODE_OPTIONS = numberOptions([50, 100, 200, 500, 1000, 2000]);
const WEIGHT_OPTIONS = numberOptions([1, 2, 3, 5, 10]);
const KIND_OPTIONS = [
  { value: 'all', label: 'All kinds' },
  ...entityKindSchema.options.map((kind) => ({ value: kind, label: KIND_LABEL[kind] })),
];

function GraphPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/graph' });
  const setSearch = (patch: Partial<typeof search>) =>
    navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });
  return <GraphExplorer options={search} onChange={setSearch} />;
}

/**
 * The entity graph: the most connected entities by default, or one entity
 * and its neighbourhood when focused. Selecting a node shows what it is
 * linked to and the turns recall finds for it, which is where odd NER
 * output shows up first.
 */
export function GraphExplorer({
  options,
  onChange,
}: {
  options: GraphOptions;
  onChange: (patch: Partial<GraphOptions>) => void;
}) {
  const snapshot = useGraph(options);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusText, setFocusText] = useState(options.focus ?? '');

  const submitFocus = (event: FormEvent) => {
    event.preventDefault();
    const focus = focusText.trim();
    onChange({ focus: focus || undefined, hops: focus ? (options.hops ?? 1) : undefined });
  };

  const nodes = snapshot.data?.nodes ?? [];
  const rows = useMemo(() => [...nodes].sort((a, b) => b.degree - a.degree), [nodes]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="px-0 pt-0"
        title="Entity graph"
        description="Entities the store recognised, joined where they were mentioned together. Size is how connected an entity is; width is how often two were mentioned together."
        content={
          <form onSubmit={submitFocus} className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-56 flex-1 items-end gap-2">
              <FormField
                className="flex-1"
                label="Focus entity"
                control={
                  <Input
                    value={focusText}
                    onChange={(event) => setFocusText(event.target.value)}
                    placeholder="maya okafor"
                  />
                }
              />
              <Button type="submit" variant="secondary">
                <CrosshairIcon /> Focus
              </Button>
              {options.focus && (
                <ActionButton
                  variant="ghost"
                  size="icon"
                  label="Clear focus"
                  onClick={() => {
                    setFocusText('');
                    onChange({ focus: undefined, hops: undefined });
                  }}
                >
                  <XIcon />
                </ActionButton>
              )}
            </div>
            {options.focus && (
              <FormField
                className="w-20"
                label="Hops"
                control={(props) => (
                  <OptionSelect
                    {...props}
                    options={HOP_OPTIONS}
                    value={String(options.hops ?? 1)}
                    onValueChange={(v) => onChange({ hops: Number(v) })}
                  />
                )}
              />
            )}
            <FormField
              className="w-32"
              label="Kind"
              control={(props) => (
                <OptionSelect
                  {...props}
                  options={KIND_OPTIONS}
                  value={options.kind ?? 'all'}
                  onValueChange={(v) => onChange({ kind: v === 'all' ? undefined : (v as EntityKind) })}
                />
              )}
            />
            <FormField
              className="w-24"
              label="Nodes"
              control={(props) => (
                <OptionSelect
                  {...props}
                  options={NODE_OPTIONS}
                  value={String(options.limit ?? 200)}
                  onValueChange={(v) => onChange({ limit: Number(v) })}
                />
              )}
            />
            <FormField
              className="w-20"
              label="Min. co-mentions"
              control={(props) => (
                <OptionSelect
                  {...props}
                  options={WEIGHT_OPTIONS}
                  value={String(options.min_weight ?? 1)}
                  onValueChange={(v) => onChange({ min_weight: Number(v) })}
                />
              )}
            />
          </form>
        }
      />

      {snapshot.isPending && <Skeleton className="h-[520px] w-full" />}
      {snapshot.error && <QueryError what="the graph" error={snapshot.error} onRetry={() => snapshot.refetch()} />}

      {snapshot.data && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <ChartCard
            title={options.focus ? `Around “${options.focus}”` : 'Most connected entities'}
            description={`${formatCount(snapshot.data.nodes.length)} of ${formatCount(snapshot.data.total_entities)} entities · ${formatCount(snapshot.data.edges.length)} of ${formatCount(snapshot.data.total_edges)} edges${snapshot.data.truncated ? ' · cut at the node cap' : ''}`}
            rows={rows}
            columns={[
              { key: 'entity', header: 'Entity', render: (n) => n.entity },
              { key: 'kind', header: 'Kind', render: (n) => n.kind },
              { key: 'turns', header: 'Turns', align: 'right', render: (n) => formatCount(n.turns) },
              { key: 'degree', header: 'Connections', align: 'right', render: (n) => formatCount(n.degree) },
            ]}
            rowKey={(n) => n.entity}
            loading={snapshot.isFetching}
            empty={
              options.focus
                ? `No entity called “${options.focus}”. Keys are lower-cased, as in the session inspector.`
                : 'No entities recognised yet.'
            }
          >
            <div className="flex flex-col gap-2">
              <Legend items={KIND_LEGEND} />
              <ForceGraph snapshot={snapshot.data} selected={selected} onSelect={setSelected} />
            </div>
          </ChartCard>
          <NodePanel
            entity={selected}
            snapshot={snapshot.data}
            onFocus={(entity) => {
              setFocusText(entity);
              onChange({ focus: entity, hops: options.hops ?? 1 });
            }}
            onSelect={setSelected}
          />
        </div>
      )}
    </div>
  );
}

function NodePanel({
  entity,
  snapshot,
  onFocus,
  onSelect,
}: {
  entity: string | null;
  snapshot: {
    nodes: Array<{ entity: string; kind: EntityKind; turns: number; degree: number }>;
    edges: Array<{ a: string; b: string; turns: number }>;
  };
  onFocus: (entity: string) => void;
  onSelect: (entity: string) => void;
}) {
  const node = snapshot.nodes.find((n) => n.entity === entity) ?? null;
  const neighbours = useMemo(() => {
    if (!entity) {
      return [];
    }
    return snapshot.edges
      .filter((e) => e.a === entity || e.b === entity)
      .map((e) => ({ entity: e.a === entity ? e.b : e.a, turns: e.turns }))
      .sort((a, b) => b.turns - a.turns);
  }, [entity, snapshot.edges]);
  const turns = useRecall(entity ? { query: entity, top_k: 10, detail: 'full' } : null);

  if (!node) {
    return (
      <aside className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        Click an entity to see what it is linked to and the turns that mention it.
      </aside>
    );
  }
  return (
    <aside className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto rounded-md border p-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span aria-hidden className="size-3 rounded-[2px]" style={{ background: entityKindColor(node.kind) }} />
          {node.entity}
          <Badge variant="outline">{node.kind}</Badge>
        </h2>
        <p className="text-xs text-muted-foreground">
          {formatCount(node.turns)} turns · {formatCount(node.degree)} connections in the whole graph
        </p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => onFocus(node.entity)}>
          <CrosshairIcon /> Focus here
        </Button>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium">Mentioned with</h3>
        {neighbours.length === 0 && <p className="text-xs text-muted-foreground">Nothing in this snapshot.</p>}
        <ul className="flex flex-wrap gap-1">
          {neighbours.slice(0, 40).map((n) => (
            <li key={n.entity}>
              <button
                type="button"
                className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent"
                onClick={() => onSelect(n.entity)}
                title={`${n.turns} shared turns`}
              >
                {n.entity} <span className="text-muted-foreground tabular-nums">×{n.turns}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium">Turns recall finds for it</h3>
        {turns.isPending && <Skeleton className="h-20 w-full" />}
        {turns.error && <QueryError what="the turns" error={turns.error} onRetry={() => turns.refetch()} />}
        {turns.data && <EvidenceList evidence={turns.data.evidence} />}
        {turns.data?.evidence[0] && (
          <p className="mt-2 text-xs">
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: turns.data.evidence[0].turn.session_id }}
              className="underline"
            >
              Open session {turns.data.evidence[0].turn.session_id}
            </Link>
          </p>
        )}
      </div>
    </aside>
  );
}
