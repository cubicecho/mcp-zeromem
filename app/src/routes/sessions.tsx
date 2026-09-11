import type { SessionSummary } from '@mcp-zeromem/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ScanSearchIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
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
  const [toForget, setToForget] = useState<SessionSummary | null>(null);
  const forget = useForgetSession();
  const readOnly = status.data?.readOnly ?? false;

  const confirmForget = () => {
    if (!toForget) {
      return;
    }
    const id = toForget.session_id;
    forget.mutate(id, {
      onSuccess: () => {
        if (selected === id) {
          setSelected(null);
        }
      },
      onError: toastApiError,
      onSettled: () => setToForget(null),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Sessions</h1>
        <p className="text-sm text-muted-foreground">Every conversation in the store, most recent first.</p>
      </div>

      {sessions.isPending && <Skeleton className="h-40 w-full" />}
      {sessions.error && <p className="text-sm text-destructive">Failed to load sessions: {sessions.error.message}</p>}

      {sessions.data && sessions.data.sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No sessions yet. Remember something over MCP or run `zm ingest`.
        </p>
      )}

      {sessions.data && sessions.data.sessions.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="rounded-md border">
            <Table>
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
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(session.first_ts)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={formatDateTime(session.last_ts)}>
                      {formatRelativeTime(session.last_ts)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        asChild
                        aria-label={`Inspect session ${session.session_id}`}
                      >
                        <Link
                          to="/sessions/$sessionId"
                          params={{ sessionId: session.session_id }}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <ScanSearchIcon />
                        </Link>
                      </Button>
                      {!readOnly && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Forget session ${session.session_id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setToForget(session);
                          }}
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <SessionInspector sessionId={selected} />
        </div>
      )}

      <AlertDialog open={toForget !== null} onOpenChange={(open) => !open && setToForget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget session {toForget?.session_id}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes {toForget ? formatCount(toForget.turns) : ''} turns and rebuilds the indexes
              without them. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forget.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmForget();
              }}
              disabled={forget.isPending}
            >
              {forget.isPending ? 'Forgetting…' : 'Forget'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
      {turns.error && <p className="text-sm text-destructive">{turns.error.message}</p>}
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
