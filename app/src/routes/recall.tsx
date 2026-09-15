import type { RecallRequest } from '@mcp-zeromem/shared';
import { createFileRoute } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { FormField } from '@/components/form-field';
import { EvidenceList } from '@/components/memory/evidence-list';
import { TraceView } from '@/components/memory/trace-view';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRecall, useRecallTrace } from '@/lib/queries';

export const Route = createFileRoute('/recall')({
  component: RecallPage,
});

/**
 * The playground runs every query with `detail: full`: this is where a person
 * judges a ranking, and the route and the per-hit sources are the judgement's
 * raw material.
 */
export function RecallPage() {
  const [text, setText] = useState('');
  const [topK, setTopK] = useState(5);
  const [excludeSession, setExcludeSession] = useState('');
  const [submitted, setSubmitted] = useState<RecallRequest | null>(null);
  const [mode, setMode] = useState<'evidence' | 'trace'>('evidence');
  const result = useRecall(mode === 'evidence' ? submitted : null);
  const trace = useRecallTrace(mode === 'trace' ? submitted : null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    if (!query) {
      return;
    }
    setSubmitted({
      query,
      top_k: topK,
      detail: 'full',
      ...(excludeSession.trim() ? { exclude_session: excludeSession.trim() } : {}),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="px-0 pt-0"
        title="Recall"
        description="Ask memory a question and see what it returns, and why."
      />

      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Who owns the billing service on Heron?"
            aria-label="Query"
            autoFocus
          />
          <Button type="submit" disabled={result.isFetching}>
            <SearchIcon />
            Recall
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <FormField
            className="w-24"
            label="Top k"
            control={
              <Input
                type="number"
                min={1}
                max={50}
                value={topK}
                onChange={(event) => setTopK(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
              />
            }
          />
          <FormField
            className="w-64"
            label="Exclude session"
            control={
              <Input
                value={excludeSession}
                onChange={(event) => setExcludeSession(event.target.value)}
                placeholder="optional session id"
              />
            }
          />
        </div>
      </form>

      {submitted && (
        <Tabs value={mode} onValueChange={(value) => setMode(value as 'evidence' | 'trace')}>
          <TabsList>
            <TabsTrigger value="evidence">Evidence</TabsTrigger>
            <TabsTrigger value="trace">Trace</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {(result.isFetching || trace.isFetching) && <Skeleton className="h-32 w-full" />}
      {result.error && <QueryError what="the recall" error={result.error} onRetry={() => result.refetch()} />}
      {trace.error && <QueryError what="the trace" error={trace.error} onRetry={() => trace.refetch()} />}

      {mode === 'trace' && trace.data && !trace.isFetching && <TraceView trace={trace.data} />}

      {mode === 'evidence' && result.data && !result.isFetching && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {result.data.evidence.length} of {result.data.considered} candidates in {result.data.took_ms} ms
            </span>
            {result.data.route?.views.map((view) => (
              <Badge key={view.view} variant="outline" title={`weight ${view.weight}`}>
                {view.view} · {view.candidates}
              </Badge>
            ))}
            {result.data.route?.profile.entities.length ? (
              <span>Entities: {result.data.route.profile.entities.join(', ')}</span>
            ) : null}
            {result.data.route?.profile.temporal && <Badge variant="secondary">temporal</Badge>}
          </div>
          <EvidenceList evidence={result.data.evidence} />
        </div>
      )}
    </div>
  );
}
