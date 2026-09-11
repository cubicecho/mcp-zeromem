import type { Evidence } from '@mcp-zeromem/shared';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, formatPercent } from '@/lib/format';

/** Recall evidence, best first: the turn, who said it and when, and how sure the engine is. */
export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing in memory bears on that.</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {evidence.map((item, index) => (
        <li key={item.turn.uuid} className="rounded-md border bg-card p-4 text-card-foreground">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">#{index + 1}</span>
            <Badge variant={item.role === 'primary' ? 'default' : 'secondary'}>{item.role}</Badge>
            <span title="confidence relative to the best hit">{formatPercent(item.confidence)}</span>
            <span className="font-mono" title="fused score">
              {item.score.toFixed(3)}
            </span>
            {item.sources?.map((source) => (
              <Badge key={source} variant="outline">
                {source}
              </Badge>
            ))}
            <span className="ml-auto">
              {item.turn.session_id} · {item.turn.speaker} · {formatDateTime(item.turn.ts)}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm">{item.turn.text}</p>
          {item.entities && item.entities.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">Entities: {item.entities.join(', ')}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
