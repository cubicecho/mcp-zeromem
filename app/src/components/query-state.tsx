import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Item, ItemContent } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** What a list page needs off its query, and nothing more. */
type QueryLike = {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => unknown;
};

/**
 * The three things a list of rows can be before it is a list of rows.
 *
 * Every list page in every one of these apps opens the same way — the request failed, or it has
 * not landed, or it landed empty, or draw the rows — and every one of them writes that ladder
 * out again. The rung that goes wrong is the last one, because it has two correct spellings:
 *
 * ```tsx
 * data?.roles.length === 0                        // read straight off the query
 * shown.length === 0 && !isPending && !isError    // already defaulted to []
 * ```
 *
 * Six pages in one app, in both spellings, and neither is a bug — which is exactly why nobody
 * ever consolidated them. Here the three rungs are exclusive by construction, and the page says
 * what it is about to draw rather than the guard working it out again.
 *
 * It returns `null` once there are rows, so a page reads as the ladder and then the list:
 *
 * ```tsx
 * <QueryState query={roles} what="your roles" count={shown.length} empty={<Empty … />} />
 * {shown.map(…)}
 * ```
 *
 * `query` is taken structurally rather than as a TanStack `UseQueryResult` — the same line
 * `FormField` holds against form libraries. A shell that names one data library is a shell the
 * next app cannot install.
 */
export function QueryState({
  query,
  what,
  count,
  empty,
  rows = 3,
  className,
}: {
  query: QueryLike;
  /** What could not be fetched, in the reader's words: "your agents", "the archive". */
  what: string;
  /**
   * How many rows the page is about to draw.
   *
   * Passed rather than derived, because the rows a page draws are usually a filtered or paged
   * view of what came back: an empty *result* and an empty *view* are different states, and only
   * the page knows which one it is showing.
   */
  count: number;
  /** What to say when there are none — an `Empty`, with whatever invites the first one. */
  empty?: ReactNode;
  /** How many skeleton rows stand in for the list while it loads. */
  rows?: number;
  className?: string;
}) {
  if (query.isError)
    return <QueryError error={query.error} onRetry={() => query.refetch()} what={what} className={className} />;
  if (query.isPending) return <RowSkeleton rows={rows} className={className} />;
  if (count === 0) return <>{empty}</>;
  return null;
}

/**
 * A request that failed, said out loud.
 *
 * Its own export because a page that draws one object rather than a list needs this rung and
 * neither of the others. It is also the rung most often left out entirely: with retries off, a
 * failed query stays failed, and a page that renders a failure as an absence tells somebody
 * whose server has gone away that they have no data — which is an invitation to rebuild
 * something that is fine.
 */
export function QueryError({
  error,
  onRetry,
  what,
  className,
}: {
  error: Error | null;
  onRetry: () => void;
  what: string;
  className?: string;
}) {
  return (
    <Card
      data-slot="query-error"
      // No tinted ground behind it. The version this was lifted from washed the card with
      // `bg-destructive/5`, which drops both the red heading and the grey message under 4.5:1
      // against their own background — 4.36 and 4.33, caught by the story's axe run. The border
      // and the icon say "this failed" without moving the ground the words sit on.
      className={cn('gap-2 border-destructive/50 p-4', className)}
    >
      <div className="flex items-center gap-2 font-medium text-destructive text-sm">
        <TriangleAlert className="size-4" aria-hidden />
        Could not load {what}
      </div>
      <p className="text-muted-foreground text-sm">{error?.message || 'The server did not answer.'}</p>
      <div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" aria-hidden />
          Try again
        </Button>
      </div>
    </Card>
  );
}

/**
 * What a list shows before its first answer.
 *
 * Drawn as the row it stands in for — an outlined `Item`, which is what these lists are lists of
 * — so the page does not change shape underneath the reader when the answer lands.
 *
 * The whole set is `aria-hidden` behind one `role="status"` saying "Loading", because three
 * cards' worth of placeholder text is three cards' worth of nothing to a screen reader. Only ever
 * on `isPending`: a cache-and-network client keeps rendering what it had while it refetches, and
 * putting this behind `isFetching` flashes a skeleton over a perfectly good list.
 */
export function RowSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <Item
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders, in a list with no identity
          key={index}
          data-slot="row-skeleton"
          variant="outline"
          aria-hidden
          className={className}
        >
          <ItemContent>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </ItemContent>
        </Item>
      ))}
      <span className="sr-only" role="status">
        Loading
      </span>
    </>
  );
}
