import type { QueryTrace, ViewKind } from '@mcp-zeromem/shared';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { EvidenceList } from '@/components/memory/evidence-list';
import { Badge } from '@/components/ui/badge';
import { Legend } from '@/components/viz/legend';
import { Swatch } from '@/components/viz/tooltip';
import { formatDateTime } from '@/lib/format';
import { excerpt, seriesColor } from '@/lib/viz';

/** Each retrieval view keeps one palette slot on every page that shows it. */
export const VIEW_SLOT: Record<ViewKind, number> = { lexical: 1, entity: 2, dense: 3, recent: 4 };
export const VIEW_LABEL: Record<ViewKind, string> = {
  lexical: 'Lexical (BM25)',
  entity: 'Entity graph',
  dense: 'Dense (vectors)',
  recent: 'Recency',
};

export function viewColor(view: ViewKind): string {
  return seriesColor(VIEW_SLOT[view]);
}

type Fate = 'kept' | 'dropped' | 'lost';

/**
 * One recall, left to right: what the profiler saw in the query, which
 * views were routed and what each proposed with its raw score, how fusion
 * ordered them, and what calibration kept or dropped, with the reason.
 * Hovering a candidate anywhere follows it through every stage.
 */
export function TraceView({ trace }: { trace: QueryTrace }) {
  const [followed, setFollowed] = useState<number | null>(null);

  const { fate, text, reason } = useMemo(() => {
    const kept = new Set(trace.evidence.map((e) => e.turn.id));
    const dropped = new Map(trace.dropped.map((d) => [d.id, d.reason]));
    const text = new Map(trace.evidence.map((e) => [e.turn.id, e.turn.text]));
    const fate = (id: number): Fate => (kept.has(id) ? 'kept' : dropped.has(id) ? 'dropped' : 'lost');
    return { fate, text, reason: dropped };
  }, [trace]);

  const rowClass = (id: number, f: Fate) =>
    [
      'flex items-center gap-2 rounded-sm px-1 py-0.5 text-xs',
      f === 'kept' ? 'text-foreground' : 'text-muted-foreground',
      f === 'dropped' ? 'line-through decoration-muted-foreground/60' : '',
      followed === id ? 'bg-accent' : '',
    ].join(' ');

  const legend = trace.views.map((v) => ({ key: v.view, label: VIEW_LABEL[v.view], color: viewColor(v.view) }));

  return (
    <div className="flex flex-col gap-3">
      <Legend items={legend} />
      <div className="overflow-x-auto">
        <div className="grid min-w-[960px] grid-cols-[180px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
          <Stage title="1 · Profile">
            <dl className="flex flex-col gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Tokens</dt>
                <dd className="flex flex-wrap gap-1">
                  {trace.profile.tokens.length === 0 && <span className="text-muted-foreground">none</span>}
                  {trace.profile.tokens.map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Entities</dt>
                <dd className="flex flex-wrap gap-1">
                  {trace.profile.entities.length === 0 && <span className="text-muted-foreground">none</span>}
                  {trace.profile.entities.map((e) => (
                    <Badge key={e} variant="secondary" asChild>
                      <Link to="/graph" search={{ focus: e }}>
                        {e}
                      </Link>
                    </Badge>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Shape</dt>
                <dd className="flex flex-wrap gap-1">
                  <Badge variant={trace.profile.question ? 'default' : 'outline'}>question</Badge>
                  <Badge variant={trace.profile.temporal ? 'default' : 'outline'}>temporal</Badge>
                </dd>
              </div>
            </dl>
          </Stage>

          <Stage title={`2 · Views (${trace.views.length} routed)`}>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${Math.max(1, trace.views.length)}, minmax(0, 1fr))` }}
            >
              {trace.views.map((view) => {
                const max = Math.max(1e-9, ...view.candidates.map(([, s]) => s));
                return (
                  <div key={view.view} className="min-w-0">
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                      <Swatch color={viewColor(view.view)} />
                      {VIEW_LABEL[view.view]}
                      <span className="ml-auto font-normal text-muted-foreground">×{view.weight.toFixed(2)}</span>
                    </p>
                    <ol className="flex flex-col">
                      {view.candidates.map(([id, score]) => {
                        const f = fate(id);
                        return (
                          <li key={id}>
                            <button
                              type="button"
                              className={`${rowClass(id, f)} w-full text-left`}
                              onMouseEnter={() => setFollowed(id)}
                              onMouseLeave={() => setFollowed(null)}
                              onFocus={() => setFollowed(id)}
                              onBlur={() => setFollowed(null)}
                              title={text.get(id) ? excerpt(text.get(id) ?? '') : `turn #${id}`}
                            >
                              <span className="w-12 shrink-0 font-mono">#{id}</span>
                              <span className="h-1 flex-1 rounded-full bg-muted">
                                <span
                                  className="block h-1 rounded-full"
                                  style={{
                                    width: `${Math.max(2, (score / max) * 100)}%`,
                                    background: viewColor(view.view),
                                    opacity: f === 'kept' ? 1 : 0.35,
                                  }}
                                />
                              </span>
                              <span className="w-12 shrink-0 text-right tabular-nums">{score.toFixed(3)}</span>
                            </button>
                          </li>
                        );
                      })}
                      {view.candidates.length === 0 && <li className="text-xs text-muted-foreground">no candidates</li>}
                    </ol>
                  </div>
                );
              })}
            </div>
          </Stage>

          <Stage title={`3 · Fused (${trace.fused.length})`}>
            <ol className="flex flex-col">
              {trace.fused.map((f, index) => {
                const outcome = fate(f.id);
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      className={`${rowClass(f.id, outcome)} w-full text-left`}
                      onMouseEnter={() => setFollowed(f.id)}
                      onMouseLeave={() => setFollowed(null)}
                      onFocus={() => setFollowed(f.id)}
                      onBlur={() => setFollowed(null)}
                      title={`${formatDateTime(f.ts)}${outcome === 'dropped' ? ` · dropped: ${reason.get(f.id)}` : ''}`}
                    >
                      <span className="w-5 shrink-0 text-muted-foreground">{index + 1}</span>
                      <span className="w-12 shrink-0 font-mono">#{f.id}</span>
                      <span className="flex shrink-0 gap-0.5">
                        {f.sources.map((s) => (
                          <Swatch key={s} color={viewColor(s)} />
                        ))}
                      </span>
                      <span className="ml-auto tabular-nums">{f.score.toFixed(3)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {trace.dropped.length > 0 && (
              <div className="mt-3 border-t pt-2">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Dropped by calibration</p>
                <ul className="flex flex-col gap-0.5">
                  {trace.dropped.map((d) => (
                    <li
                      key={d.id}
                      className={`flex gap-2 rounded-sm px-1 text-xs text-muted-foreground ${followed === d.id ? 'bg-accent' : ''}`}
                      onMouseEnter={() => setFollowed(d.id)}
                      onMouseLeave={() => setFollowed(null)}
                    >
                      <span className="w-12 shrink-0 font-mono">#{d.id}</span>
                      <span className="tabular-nums">{d.score.toFixed(3)}</span>
                      <span className="truncate">{d.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Stage>

          <Stage title={`4 · Evidence (${trace.evidence.length}) · ${trace.took_ms} ms`}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: clearing a hover highlight, not an action */}
            <div
              onMouseLeave={() => setFollowed(null)}
              className={followed !== null && !trace.evidence.some((e) => e.turn.id === followed) ? 'opacity-60' : ''}
            >
              <EvidenceList evidence={trace.evidence} />
            </div>
          </Stage>
        </div>
      </div>
    </div>
  );
}

function Stage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
