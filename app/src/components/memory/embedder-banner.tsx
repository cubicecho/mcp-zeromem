import type { Stats } from '@mcp-zeromem/shared';
import { Link } from '@tanstack/react-router';
import { AlertTriangleIcon, RefreshCwIcon } from 'lucide-react';
import { formatCount } from '@/lib/format';

/**
 * The things an operator must not miss about the dense view: the model did
 * not load and recall is running on the hash fallback, this process cannot
 * use the store's embedder at all, or the corpus is still being re-embedded
 * after a switch. The engine never degrades silently, and neither does the UI.
 */
export function EmbedderBanner({ stats }: { stats: Stats }) {
  const unavailable = stats.embedder !== null && !stats.embedder_active;
  const backlog = stats.embedding_backlog;
  const alert = stats.embedder_is_fallback || stats.embedder === null || unavailable;
  if (!alert && backlog === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-3">
      {alert && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-medium">{alertTitle(stats)}</p>
            <p className="text-muted-foreground">
              {stats.embedder_warning ??
                'Semantic recall is weaker than with a real model. Check the model cache and the server log.'}{' '}
              <Link to="/settings" className="underline underline-offset-4">
                Change the embedder
              </Link>
            </p>
          </div>
        </div>
      )}
      {backlog > 0 && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-sky-500/50 bg-sky-500/10 px-4 py-3 text-sm"
        >
          <RefreshCwIcon className="mt-0.5 size-4 shrink-0 animate-spin text-sky-600" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-medium">Re-embedding · {backlogLabel(stats)}</p>
            <p className="text-muted-foreground">
              Recall uses the lexical and entity views for turns that have no vector yet.{' '}
              <Link to="/settings" className="underline underline-offset-4">
                Watch progress
              </Link>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function alertTitle(stats: Stats): string {
  if (stats.embedder === null) {
    return 'No dense view: this store has no embedder yet.';
  }
  if (!stats.embedder_active) {
    return `This server cannot use the store's embedder (${stats.embedder}).`;
  }
  return `Fallback embedder in use (${stats.embedder}).`;
}

/** "1,234 of 5,000 turns" — the backlog against the whole store. */
export function backlogLabel(stats: Pick<Stats, 'embedding_backlog' | 'turns'>): string {
  const done = Math.max(0, stats.turns - stats.embedding_backlog);
  return `${formatCount(done)} of ${formatCount(stats.turns)} turns`;
}
