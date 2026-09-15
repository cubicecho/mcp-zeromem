import type { ActionRow, RunSummary } from '@mcp-zeromem/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Undo2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { ConfirmButton } from '@/components/confirm-button';
import { StickyHeaderContentFooter } from '@/components/header-content-footer';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCount, formatDateTime, formatRelativeTime } from '@/lib/format';
import {
  useCurationActions,
  useCurationAliases,
  useCurationRuns,
  useServerStatus,
  useUndoCuration,
} from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

export const Route = createFileRoute('/curation')({
  component: CurationPage,
});

/** How long a target turn's text runs before it is clipped in the log. */
const CLIP = 160;

/**
 * What the curator did, run by run, and the way back. The curator is an
 * outside agent on the /mcp curator surface; nothing it does deletes a turn,
 * so every action here can be undone, one at a time or a whole run at once.
 */
export function CurationPage() {
  const status = useServerStatus();
  const readOnly = status.data?.readOnly ?? false;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="px-0 pt-0"
        title="Curation"
        description="Hidden duplicates and noise, superseded facts, entity aliases and consolidated notes, each with the curator's reason. Nothing is deleted: undo an action and recall is as it was."
      />
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="entities">Aliases and blocklist</TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="pt-4">
          <Runs readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="entities" className="pt-4">
          <Entities readOnly={readOnly} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Runs({ readOnly }: { readOnly: boolean }) {
  const runs = useCurationRuns({ limit: 200 });
  const [selected, setSelected] = useState<string | null>(null);

  if (runs.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (runs.error) {
    return <QueryError what="the curation runs" error={runs.error} onRetry={() => runs.refetch()} />;
  }
  if (runs.data.runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No curation runs yet. Give an MCP client the curator token (see{' '}
        <Link to="/settings" className="underline underline-offset-2">
          Settings
        </Link>
        ) and the <span className="font-mono">zeromem_curate</span> prompt, on a schedule.
      </p>
    );
  }

  const current = runs.data.runs.find((run) => run.run_id === selected) ?? null;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <StickyHeaderContentFooter
        className="h-auto max-h-[70vh] self-start"
        contentClassName="overflow-x-auto rounded-md border"
        content={
          <Table sticky>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead className="text-right">Actions</TableHead>
                <TableHead>Ops</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.runs.map((run) => (
                <TableRow
                  key={run.run_id}
                  data-state={selected === run.run_id ? 'selected' : undefined}
                  className="cursor-pointer"
                  onClick={() => setSelected(run.run_id)}
                >
                  <TableCell>
                    <div className="font-mono text-xs">{run.run_id}</div>
                    <div className="text-xs text-muted-foreground">{run.actor}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={formatDateTime(run.ended_at)}>
                    {formatRelativeTime(run.ended_at)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(run.actions)}
                    {run.undone > 0 && (
                      <div className="text-xs text-muted-foreground">{formatCount(run.undone)} undone</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <OpCounts run={run} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
      />
      {current ? (
        <RunDetail run={current} readOnly={readOnly} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Pick a run to see its actions. The finders resume after turn{' '}
          <span className="font-mono">#{runs.data.cursor}</span>.
        </p>
      )}
    </div>
  );
}

function OpCounts({ run }: { run: RunSummary }) {
  const ops = Object.entries(run.ops).filter(([op]) => op !== 'run_end');
  return (
    <div className="flex flex-wrap gap-1">
      {ops.map(([op, n]) => (
        <Badge key={op} variant="outline" className="tabular-nums">
          {op} {formatCount(n)}
        </Badge>
      ))}
      {!run.finished && <Badge variant="secondary">unfinished</Badge>}
    </div>
  );
}

function RunDetail({ run, readOnly }: { run: RunSummary; readOnly: boolean }) {
  const actions = useCurationActions(run.run_id);
  const undo = useUndoCuration();
  const live = run.actions - run.undone;

  const undoAction = (row: ActionRow) =>
    undo.mutate(
      { action_id: row.id },
      { onSuccess: () => toast.success(`Undid ${row.op} #${row.id}.`), onError: toastApiError },
    );
  const undoRun = () =>
    undo.mutate(
      { run_id: run.run_id },
      {
        onSuccess: (report) => toast.success(`Undid ${formatCount(report.undone.length)} actions of ${run.run_id}.`),
        onError: toastApiError,
      },
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-mono text-sm font-semibold">{run.run_id}</h2>
          <p className="text-xs text-muted-foreground">
            {run.actor} · {formatDateTime(run.started_at)} → {formatDateTime(run.ended_at)}
          </p>
          {run.summary && <p className="mt-1 text-sm">{run.summary}</p>}
        </div>
        {!readOnly && (
          <ConfirmButton
            variant="outline"
            className="shrink-0"
            label="Undo run"
            disabled={undo.isPending || live === 0}
            title={`Undo ${formatCount(live)} actions?`}
            description={`Every action of ${run.run_id} that is still in force is reversed, newest first. Hidden turns come back into recall, aliases and blocks are lifted and the run's notes are removed.`}
            confirmLabel="Undo run"
            onConfirm={undoRun}
          >
            <Undo2Icon aria-hidden />
            Undo run
          </ConfirmButton>
        )}
      </div>

      {actions.isPending && <Skeleton className="h-32 w-full" />}
      {actions.error && <QueryError what="the run's actions" error={actions.error} onRetry={() => actions.refetch()} />}
      {actions.data && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">#</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.data.actions.map((row) => (
                <TableRow key={row.id} className={row.undone_at !== null ? 'opacity-60' : undefined}>
                  <TableCell className="align-top font-mono text-xs">{row.id}</TableCell>
                  <TableCell className="align-top">
                    <ActionDescription row={row} />
                  </TableCell>
                  <TableCell className="align-top text-sm">{row.reason || '—'}</TableCell>
                  <TableCell className="align-top text-right">
                    {row.undone_at !== null ? (
                      <Badge variant="secondary" title={`by ${row.undone_by ?? 'unknown'}`}>
                        undone {formatRelativeTime(row.undone_at)}
                      </Badge>
                    ) : (
                      !readOnly &&
                      row.op !== 'run_end' && (
                        <ActionButton
                          variant="ghost"
                          size="sm"
                          label={`Undo action ${row.id}`}
                          disabled={undo.isPending}
                          onClick={() => undoAction(row)}
                        >
                          <Undo2Icon aria-hidden />
                          Undo
                        </ActionButton>
                      )
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** One line for what the action did, then the turns it touched (text clipped; gone if the session was forgotten). */
function ActionDescription({ row }: { row: ActionRow }) {
  const field = (key: string) => {
    const value = row.payload[key];
    return typeof value === 'string' ? value : '';
  };
  let headline: string;
  switch (row.op) {
    case 'alias':
    case 'unalias':
      headline = `${row.op} “${field('alias')}” → “${field('canonical')}”`;
      break;
    case 'block':
    case 'unblock':
      headline = `${row.op} “${field('entity')}”`;
      break;
    case 'note':
      headline = `note in ${field('session_id')}, standing for ${formatCount(row.targets.length)} turns`;
      break;
    case 'run_end':
      headline = `run end${field('summary') ? `: ${field('summary')}` : ''}`;
      break;
    default:
      headline = `${row.op} ${formatCount(row.targets.length)} turn${row.targets.length === 1 ? '' : 's'}`;
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{headline}</span>
      {row.targets.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {row.targets.map((target) => (
            <li key={target.uuid} className="text-xs text-muted-foreground">
              {target.id === null ? (
                <span className="italic">a turn no longer in the store</span>
              ) : (
                <>
                  <span className="font-mono">#{target.id}</span>{' '}
                  {target.session_id && (
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: target.session_id }}
                      className="font-mono underline-offset-2 hover:underline"
                    >
                      {target.session_id}
                    </Link>
                  )}{' '}
                  {clip(target.text ?? '')}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text;
}

function Entities({ readOnly }: { readOnly: boolean }) {
  const entities = useCurationAliases();
  const undo = useUndoCuration();

  if (entities.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (entities.error) {
    return <QueryError what="the aliases" error={entities.error} onRetry={() => entities.refetch()} />;
  }

  const remove = (actionId: number | null, label: string) => {
    if (actionId === null) {
      return;
    }
    undo.mutate(
      { action_id: actionId },
      { onSuccess: () => toast.success(`Removed ${label}.`), onError: toastApiError },
    );
  };
  const removeButton = (actionId: number | null, label: string) =>
    !readOnly && (
      <ActionButton
        variant="ghost"
        size="sm"
        label={`Remove ${label}`}
        disabled={undo.isPending || actionId === null}
        onClick={() => remove(actionId, label)}
      >
        <Undo2Icon aria-hidden />
        Remove
      </ActionButton>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section
        title="Aliases"
        description="Each alias is folded into its canonical name in the entity index, as if the text had used it."
        content={
          entities.data.aliases.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Alias</TableHead>
                    <TableHead>Canonical</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entities.data.aliases.map((entry) => (
                    <TableRow key={entry.alias}>
                      <TableCell>{entry.alias}</TableCell>
                      <TableCell>
                        <Link
                          to="/graph"
                          search={{ focus: entry.canonical }}
                          className="underline-offset-2 hover:underline"
                        >
                          {entry.canonical}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        {removeButton(entry.action_id, `the alias ${entry.alias}`)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      />
      <Section
        title="Blocklist"
        description="Names the extractor picked up that are not entities."
        content={
          entities.data.blocklist.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entity</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entities.data.blocklist.map((entry) => (
                    <TableRow key={entry.entity}>
                      <TableCell>{entry.entity}</TableCell>
                      <TableCell className="text-right">
                        {removeButton(entry.action_id, `the block on ${entry.entity}`)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      />
    </div>
  );
}
