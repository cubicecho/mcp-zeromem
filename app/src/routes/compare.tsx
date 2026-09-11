import type { Evidence, QueryResult, RecallRequest } from '@mcp-zeromem/shared';
import { createFileRoute } from '@tanstack/react-router';
import { GitCompareIcon, PinIcon, PinOffIcon } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { EvidenceList } from '@/components/memory/evidence-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCount, formatPercent } from '@/lib/format';
import { useRecall, useServerStatus } from '@/lib/queries';
import { excerpt, seriesColor } from '@/lib/viz';

export const Route = createFileRoute('/compare')({
  component: ComparePage,
});

interface SideSettings {
  top_k: number;
  session: string;
  exclude_session: string;
}

const DEFAULT_SIDE: SideSettings = { top_k: 5, session: '', exclude_session: '' };

interface Held {
  result: QueryResult;
  generation: number | null;
  request: RecallRequest;
}

function toRequest(query: string, side: SideSettings): RecallRequest {
  return {
    query,
    top_k: side.top_k,
    detail: 'full',
    ...(side.session.trim() ? { session: side.session.trim() } : {}),
    ...(side.exclude_session.trim() ? { exclude_session: side.exclude_session.trim() } : {}),
  };
}

interface DiffRow {
  uuid: string;
  evidence: Evidence;
  rankA: number | null;
  rankB: number | null;
  scoreA: number | null;
  scoreB: number | null;
}

function diff(a: QueryResult, b: QueryResult): DiffRow[] {
  const rows = new Map<string, DiffRow>();
  a.evidence.forEach((e, i) => {
    rows.set(e.turn.uuid, { uuid: e.turn.uuid, evidence: e, rankA: i + 1, rankB: null, scoreA: e.score, scoreB: null });
  });
  b.evidence.forEach((e, i) => {
    const row = rows.get(e.turn.uuid);
    if (row) {
      row.rankB = i + 1;
      row.scoreB = e.score;
    } else {
      rows.set(e.turn.uuid, {
        uuid: e.turn.uuid,
        evidence: e,
        rankA: null,
        rankB: i + 1,
        scoreA: null,
        scoreB: e.score,
      });
    }
  });
  return [...rows.values()].sort((x, y) => (x.rankA ?? x.rankB ?? 0) - (y.rankA ?? y.rankB ?? 0));
}

/**
 * The same query under two settings, or against two generations of the
 * store: pin the left side, change something (ingest, forget, a retrieval
 * change and a restart) and run again. The diff is by turn, with the rank
 * and score each side gave it.
 */
export function ComparePage() {
  const status = useServerStatus();
  const [query, setQuery] = useState('');
  const [sideA, setSideA] = useState<SideSettings>(DEFAULT_SIDE);
  const [sideB, setSideB] = useState<SideSettings>({ ...DEFAULT_SIDE, top_k: 10 });
  const [requestA, setRequestA] = useState<RecallRequest | null>(null);
  const [requestB, setRequestB] = useState<RecallRequest | null>(null);
  const [pinned, setPinned] = useState<Held | null>(null);

  const liveA = useRecall(pinned ? null : requestA);
  const liveB = useRecall(requestB);
  const generation = status.data?.engine.generation ?? null;

  const resultA: Held | null =
    pinned ?? (liveA.data && requestA ? { result: liveA.data, generation, request: requestA } : null);
  const resultB: Held | null = liveB.data && requestB ? { result: liveB.data, generation, request: requestB } : null;

  const run = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) {
      return;
    }
    if (!pinned) {
      setRequestA(toRequest(text, sideA));
    }
    setRequestB(toRequest(text, sideB));
  };

  const rows = useMemo(() => (resultA && resultB ? diff(resultA.result, resultB.result) : []), [resultA, resultB]);
  const shared = rows.filter((r) => r.rankA !== null && r.rankB !== null).length;
  const moved = rows.filter((r) => r.rankA !== null && r.rankB !== null && r.rankA !== r.rankB).length;
  const onlyA = rows.filter((r) => r.rankB === null).length;
  const onlyB = rows.filter((r) => r.rankA === null).length;
  const overlap =
    resultA && resultB
      ? shared / Math.max(1, Math.max(resultA.result.evidence.length, resultB.result.evidence.length))
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Compare</h1>
        <p className="text-sm text-muted-foreground">
          One query, two answers. Vary the settings, or pin the left side and run again after the store has changed.
        </p>
      </div>

      <form onSubmit={run} className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Who owns the billing service on Heron?"
            aria-label="Query"
            autoFocus
          />
          <Button type="submit" disabled={liveA.isFetching || liveB.isFetching}>
            <GitCompareIcon /> Run both
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <SidePanel
            label="A"
            slot={1}
            settings={sideA}
            onChange={setSideA}
            disabled={pinned !== null}
            action={
              resultA ? (
                <Button
                  type="button"
                  size="sm"
                  variant={pinned ? 'secondary' : 'outline'}
                  onClick={() => setPinned(pinned ? null : resultA)}
                  aria-pressed={pinned !== null}
                >
                  {pinned ? <PinOffIcon /> : <PinIcon />}
                  {pinned ? 'Unpin' : 'Pin this result'}
                </Button>
              ) : null
            }
            held={resultA}
          />
          <SidePanel label="B" slot={2} settings={sideB} onChange={setSideB} held={resultB} />
        </div>
      </form>

      {(liveA.isFetching || liveB.isFetching) && <Skeleton className="h-32 w-full" />}
      {liveA.error && <p className="text-sm text-destructive">A failed: {liveA.error.message}</p>}
      {liveB.error && <p className="text-sm text-destructive">B failed: {liveB.error.message}</p>}

      {resultA && resultB && !liveA.isFetching && !liveB.isFetching && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">{formatPercent(overlap)} overlap</Badge>
            <span className="text-muted-foreground">
              {formatCount(shared)} shared ({formatCount(moved)} moved) · {formatCount(onlyA)} only in A ·{' '}
              {formatCount(onlyB)} only in B
            </span>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Turn</TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1">
                      <span aria-hidden className="size-2 rounded-[2px]" style={{ background: seriesColor(1) }} /> A
                      rank
                    </span>
                  </TableHead>
                  <TableHead className="text-right">A score</TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1">
                      <span aria-hidden className="size-2 rounded-[2px]" style={{ background: seriesColor(2) }} /> B
                      rank
                    </span>
                  </TableHead>
                  <TableHead className="text-right">B score</TableHead>
                  <TableHead>Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.uuid}>
                    <TableCell>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">#{row.evidence.turn.id}</span> · {row.evidence.turn.session_id} ·{' '}
                        {row.evidence.turn.speaker}
                      </p>
                      <p className="text-sm">{excerpt(row.evidence.turn.text, 120)}</p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.rankA ?? '–'}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.scoreA?.toFixed(3) ?? '–'}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.rankB ?? '–'}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.scoreB?.toFixed(3) ?? '–'}</TableCell>
                    <TableCell>
                      {row.rankA === null ? (
                        <Badge variant="outline">only B</Badge>
                      ) : row.rankB === null ? (
                        <Badge variant="outline">only A</Badge>
                      ) : row.rankA === row.rankB ? (
                        <span className="text-xs text-muted-foreground">same</span>
                      ) : (
                        <Badge variant="secondary">
                          {row.rankA > row.rankB ? `up ${row.rankA - row.rankB}` : `down ${row.rankB - row.rankA}`}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">Full evidence, side by side</summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <EvidenceList evidence={resultA.result.evidence} />
              <EvidenceList evidence={resultB.result.evidence} />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function SidePanel({
  label,
  slot,
  settings,
  onChange,
  disabled = false,
  action,
  held,
}: {
  label: string;
  slot: number;
  settings: SideSettings;
  onChange: (next: SideSettings) => void;
  disabled?: boolean;
  action?: React.ReactNode;
  held: Held | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <fieldset className="flex flex-col gap-3 rounded-md border p-4" disabled={disabled}>
        <legend className="flex items-center gap-2 px-1 text-sm font-medium">
          <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: seriesColor(slot) }} />
          Side {label}
          {held && (
            <span className="font-normal text-muted-foreground">
              · {formatCount(held.result.evidence.length)} hits · {held.result.took_ms} ms
              {held.generation !== null ? ` · generation ${held.generation}` : ''}
            </span>
          )}
        </legend>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`top-k-${label}`}>Top k</Label>
            <Input
              id={`top-k-${label}`}
              type="number"
              min={1}
              max={50}
              value={settings.top_k}
              onChange={(event) =>
                onChange({ ...settings, top_k: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })
              }
              className="w-20"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`session-${label}`}>Only session</Label>
            <Input
              id={`session-${label}`}
              value={settings.session}
              onChange={(event) => onChange({ ...settings, session: event.target.value })}
              placeholder="optional"
              className="w-44"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`exclude-${label}`}>Exclude session</Label>
            <Input
              id={`exclude-${label}`}
              value={settings.exclude_session}
              onChange={(event) => onChange({ ...settings, exclude_session: event.target.value })}
              placeholder="optional"
              className="w-44"
            />
          </div>
        </div>
      </fieldset>
      {action && <div>{action}</div>}
    </div>
  );
}
