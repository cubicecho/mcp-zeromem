import type { SessionSummary } from '@mcp-zeromem/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ScanSearchIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { ActionButton } from '@/components/action-button';
import { ConfirmButton } from '@/components/confirm-button';
import { StickyHeaderContentFooter } from '@/components/header-content-footer';
import { PageHeader } from '@/components/page-header';
import { QueryError, QueryState } from '@/components/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCount, formatDateTime, formatRelativeTime } from '@/lib/format';
import { useForgetSession, useServerStatus, useSessions, useSessionTurns } from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

export const Route = createFileRoute('/sessions')({
  component: SessionsPage,
});

export function SessionsPage() {
  const sessions = useSessions({ limit: 500 });
  const status = useServerStatus();
  const [selected, setSelected] = useState<string | null>(null);
  const forget = useForgetSession();
  const readOnly = status.data?.readOnly ?? false;

  const confirmForget = (session: SessionSummary) => {
    const id = session.session_id;
    forget.mutate(id, {
      onSuccess: () => {
        if (selected === id) {
          setSelected(null);
        }
      },
      onError: toastApiError,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="px-0 pt-0"
        title="Sessions"
        description="Every conversation in the store, most recent first."
      />

      <QueryState
        query={sessions}
        what="sessions"
        count={sessions.data?.sessions.length ?? 0}
        empty={
          <p className="text-sm text-muted-foreground">
            No sessions yet. Remember something over MCP or run `zm ingest`.
          </p>
        }
      />

      {sessions.data && sessions.data.sessions.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <StickyHeaderContentFooter
            className="h-auto max-h-[70vh] self-start"
            contentClassName="overflow-x-auto rounded-md border"
            content={
              <Table sticky>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    <TableHead className="text-right">Turns</TableHead>
                    <TableHead>First</TableHead>
                    <TableHead>Last</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.data.sessions.map((session) => (
                    <TableRow
                      key={session.session_id}
                      data-state={selected === session.session_id ? 'selected' : undefined}
                      className="cursor-pointer"
                      onClick={() => setSelected(session.session_id)}
                    >
                      <TableCell className="font-mono text-xs">{session.session_id}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(session.turns)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(session.first_ts)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground" title={formatDateTime(session.last_ts)}>
                        {formatRelativeTime(session.last_ts)}
                      </TableCell>
                      {/* Clicks on these buttons, and in the confirm dialog React bubbles back through this
                          cell from its portal, must not select the row. */}
                      <TableCell className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                        <ActionButton
                          variant="ghost"
                          size="icon-sm"
                          asChild
                          label={`Inspect session ${session.session_id}`}
                        >
                          <Link to="/sessions/$sessionId" params={{ sessionId: session.session_id }}>
                            <ScanSearchIcon />
                          </Link>
                        </ActionButton>
                        {!readOnly && (
                          <ConfirmButton
                            variant="ghost"
                            size="icon-sm"
                            label={`Forget session ${session.session_id}`}
                            disabled={forget.isPending}
                            title={`Forget session ${session.session_id}?`}
                            description={`This permanently deletes ${formatCount(session.turns)} turns and rebuilds the indexes without them. There is no undo.`}
                            confirmLabel="Forget"
                            onConfirm={() => confirmForget(session)}
                          >
                            <Trash2Icon />
                          </ConfirmButton>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            }
          />
          <SessionInspector sessionId={selected} />
        </div>
      )}
    </div>
  );
}

function SessionInspector({ sessionId }: { sessionId: string | null }) {
  const turns = useSessionTurns(sessionId);
  if (sessionId === null) {
    return (
      <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        Select a session to read its turns.
      </div>
    );
  }
  return (
    <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto rounded-md border p-4">
      <h2 className="font-mono text-sm">{sessionId}</h2>
      {turns.isPending && <Skeleton className="h-24 w-full" />}
      {turns.error && <QueryError what="the turns" error={turns.error} onRetry={() => turns.refetch()} />}
      {turns.data?.turns.map((turn) => (
        <div key={turn.uuid} className="text-sm">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{turn.speaker}</span> · {formatDateTime(turn.ts)}
          </p>
          <p className="whitespace-pre-wrap">{turn.text}</p>
        </div>
      ))}
    </div>
  );
}
