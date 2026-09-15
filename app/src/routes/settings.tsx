import {
  CURATOR_LIMITS,
  type CuratorSettings,
  type EmbedderKind,
  type EmbedderProbe,
  type EmbedderSettings,
  type EmbedderSpec,
  type ServerStatus,
} from '@mcp-zeromem/shared';
import { createFileRoute } from '@tanstack/react-router';
import {
  CheckIcon,
  CopyIcon,
  EraserIcon,
  KeyRoundIcon,
  PlugZapIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { NumberField, SwitchField, useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { FormField } from '@/components/form-field';
import { OptionSelect } from '@/components/option-select';
import { PageHeader } from '@/components/page-header';
import { PasswordInput } from '@/components/password-input';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiRequestError } from '@/lib/api';
import { formatCount, formatDateTime, formatRelativeTime } from '@/lib/format';
import {
  useClearStore,
  useCuratorSettings,
  useEmbedderSettings,
  useGenerateCuratorToken,
  useReembed,
  useServerStatus,
  useSetEmbedder,
  useTestEmbedder,
  useUpdateCuratorSettings,
} from '@/lib/queries';
import { toastApiError } from '@/lib/toast';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

const KIND_LABELS: Record<EmbedderKind, string> = {
  onnx: 'Built-in BGE-small (ONNX)',
  hash: 'Hash fallback',
  openai: 'OpenAI-compatible endpoint',
};

/**
 * The store's embedder, the form that changes it, and the ways to start
 * over: re-embed every turn with the current embedder, clear the vectors, or
 * clear the whole memory. Every change is written into the store, so the
 * stdio server and the host's `zm` hooks follow it on their next read; the
 * server's worker re-embeds in the background, which the progress bar tracks.
 */
export function SettingsPage() {
  const settings = useEmbedderSettings();
  const status = useServerStatus();
  const readOnly = status.data?.readOnly ?? false;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="px-0 pt-0"
        title="Settings"
        description="What the store is embedded with, and what it holds. A change here is recorded in the store itself, so every process that opens it follows."
      />

      {settings.isPending && <Skeleton className="h-64 w-full" />}
      {settings.error && (
        <QueryError what="the embedder settings" error={settings.error} onRetry={() => settings.refetch()} />
      )}
      {settings.data && (
        <CardLayout
          title="Embedder"
          description="The model behind the dense view, and how to reach it."
          contentClassName="flex flex-col gap-6"
          content={
            <>
              <CurrentEmbedder settings={settings.data} status={status.data} />
              {!readOnly && settings.data.embedder !== null && (
                <ReembedAction settings={settings.data} status={status.data} />
              )}
              {readOnly ? (
                <p className="text-sm text-muted-foreground">
                  This server is read-only (ZEROMEM_READ_ONLY), so the embedder cannot be changed from here.
                </p>
              ) : (
                <EmbedderForm key={settings.data.embedder ?? 'none'} settings={settings.data} status={status.data} />
              )}
            </>
          }
        />
      )}

      <Curator readOnly={readOnly} />

      {status.data && <StoredData status={status.data} readOnly={readOnly} />}
    </div>
  );
}

/**
 * Re-embed with the embedder the store already names — the way out when a
 * switch stalled half way, or the model behind an endpoint was replaced. The
 * server probes the embedder first; if it still fails, nothing is dropped.
 */
function ReembedAction({ settings, status }: { settings: EmbedderSettings; status: ServerStatus | undefined }) {
  const reembed = useReembed();
  const vectors = status?.engine.embeddings ?? 0;
  const turns = status?.engine.turns ?? 0;
  const name = settings.embedder ?? '';

  const confirm = () => {
    reembed.mutate(undefined, {
      onSuccess: (report) => {
        toast.success(`Re-embedding with ${report.embedder}; ${formatCount(report.turns_to_embed)} turns queued.`);
      },
      onError: toastApiError,
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Vectors missing or stale? Re-embed every turn with <span className="font-mono">{name}</span>. It is tested
        first, so an embedder that still fails leaves the vectors alone.
      </p>
      <ConfirmButton
        variant="outline"
        className="shrink-0"
        label="Re-embed all turns"
        disabled={reembed.isPending || turns === 0}
        title={`Re-embed every turn with ${name}?`}
        description={`This drops ${formatCount(vectors)} vectors and re-embeds ${formatCount(turns)} turns in the background. Recall uses the lexical and entity views for turns not yet re-embedded.`}
        confirmLabel="Re-embed"
        onConfirm={confirm}
      >
        <RefreshCwIcon aria-hidden />
        {reembed.isPending ? 'Re-embedding…' : 'Re-embed all turns'}
      </ConfirmButton>
    </div>
  );
}

/** The word typed to confirm clearing the whole memory. */
const CLEAR_WORD = 'clear';

/**
 * What the store holds, and clearing it: the vectors alone (the worker
 * re-embeds them, no probe needed), or every turn and session. The embedder
 * settings survive both.
 */
function StoredData({ status, readOnly }: { status: ServerStatus; readOnly: boolean }) {
  const [confirmingMemory, setConfirmingMemory] = useState(false);
  const [typed, setTyped] = useState('');
  const clear = useClearStore();
  const { turns, sessions, embeddings, entities } = status.engine;

  const close = () => {
    setConfirmingMemory(false);
    setTyped('');
  };
  const clearVectors = () =>
    clear.mutate('embeddings', {
      onSuccess: (report) => {
        toast.success(
          `Cleared ${formatCount(report.vectors_removed)} vectors; ${formatCount(report.turns_to_embed)} turns queued for re-embedding.`,
        );
      },
      onError: toastApiError,
    });
  const clearMemory = () =>
    clear.mutate('memory', {
      onSuccess: (report) => {
        toast.success(
          `Cleared ${formatCount(report.turns_removed)} turns from ${formatCount(report.sessions_removed)} sessions.`,
        );
      },
      onError: toastApiError,
      onSettled: close,
    });
  const memoryLocked = typed.trim().toLowerCase() !== CLEAR_WORD;

  return (
    <CardLayout
      title="Stored data"
      description={`${formatCount(turns)} turns in ${formatCount(sessions)} sessions, ${formatCount(entities)} entities and ${formatCount(embeddings)} vectors.`}
      contentClassName="flex flex-col gap-4"
      content={
        readOnly ? (
          <p className="text-sm text-muted-foreground">
            This server is read-only (ZEROMEM_READ_ONLY), so nothing can be cleared from here.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Drop every vector and keep the turns. The server re-embeds them in the background with the current
                embedder, which is not tested first.
              </p>
              <ConfirmButton
                variant="outline"
                className="shrink-0"
                label="Clear vectors"
                disabled={clear.isPending || embeddings === 0}
                title={`Clear ${formatCount(embeddings)} vectors?`}
                description={`The ${formatCount(turns)} turns stay and are re-embedded in the background. Recall uses the lexical and entity views until they are.`}
                confirmLabel="Clear vectors"
                onConfirm={clearVectors}
              >
                <EraserIcon aria-hidden />
                Clear vectors
              </ConfirmButton>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Forget every turn and session, and everything derived from them. The embedder settings are kept. This
                cannot be undone.
              </p>
              <Button
                type="button"
                variant="destructive"
                className="shrink-0"
                disabled={clear.isPending || turns === 0}
                onClick={() => setConfirmingMemory(true)}
              >
                <Trash2Icon aria-hidden />
                Clear all memory
              </Button>
            </div>
            {/* Not a ConfirmButton: the confirm stays locked until the word is typed. */}
            <AlertDialog open={confirmingMemory} onOpenChange={(open) => !open && close()}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear all memory?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This deletes {formatCount(turns)} turns from {formatCount(sessions)} sessions, with their entities,
                    summaries and vectors, for every process using this store. It cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <FormField
                  label={
                    <>
                      Type <span className="font-mono">{CLEAR_WORD}</span> to confirm
                    </>
                  }
                  control={
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      value={typed}
                      onChange={(event) => setTyped(event.target.value)}
                    />
                  }
                />
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={clear.isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={(event) => {
                      event.preventDefault();
                      clearMemory();
                    }}
                    disabled={clear.isPending || memoryLocked}
                  >
                    {clear.isPending ? 'Clearing…' : 'Clear memory'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )
      }
    />
  );
}

function CurrentEmbedder({ settings, status }: { settings: EmbedderSettings; status: ServerStatus | undefined }) {
  const turns = status?.engine.turns ?? 0;
  const backlog = settings.embedding_backlog;
  const done = Math.max(0, turns - backlog);
  const percent = turns > 0 ? Math.round((done / turns) * 100) : 100;
  const spec = settings.spec;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Current</span>
        <span className="font-mono">{settings.embedder ?? 'none'}</span>
        {settings.embedder_kind && <Badge variant="secondary">{KIND_LABELS[settings.embedder_kind]}</Badge>}
        {settings.embedder_dim !== null && <Badge variant="outline">{settings.embedder_dim} dims</Badge>}
        {settings.embedder_is_fallback && <Badge variant="outline">fallback</Badge>}
        {!settings.active && settings.embedder !== null && <Badge variant="destructive">unavailable here</Badge>}
      </div>
      {spec?.kind === 'openai' && (
        <p className="font-mono text-xs text-muted-foreground">
          {spec.url} · {spec.model} · key: {settings.api_key_source}
        </p>
      )}
      {settings.embedder_warning && (
        <p role="alert" className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {settings.embedder_warning}
        </p>
      )}
      {backlog > 0 && (
        <div className="flex flex-col gap-1" role="status">
          <p className="flex items-center gap-2 text-sm">
            <RefreshCwIcon className="size-4 animate-spin" aria-hidden />
            Re-embedding · {formatCount(done)} of {formatCount(turns)} turns
          </p>
          <div
            role="progressbar"
            aria-label="Re-embedding progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-[var(--viz-series-1)] transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

interface FormState {
  kind: EmbedderKind;
  url: string;
  model: string;
  apiKey: string;
  queryPrefix: string;
  documentPrefix: string;
  timeoutMs: string;
}

function fromSpec(spec: EmbedderSpec | null): FormState {
  const remote = spec?.kind === 'openai' ? spec : null;
  return {
    kind: spec?.kind ?? 'onnx',
    url: remote?.url ?? '',
    model: remote?.model ?? '',
    apiKey: '',
    queryPrefix: remote?.query_prefix ?? '',
    documentPrefix: remote?.document_prefix ?? '',
    timeoutMs: String(remote?.timeout_ms ?? 5000),
  };
}

function toSpec(form: FormState): EmbedderSpec {
  if (form.kind !== 'openai') {
    return { kind: form.kind };
  }
  const timeout = Number(form.timeoutMs);
  return {
    kind: 'openai',
    url: form.url.trim(),
    model: form.model.trim(),
    ...(form.apiKey.trim() ? { api_key: form.apiKey.trim() } : {}),
    query_prefix: form.queryPrefix,
    document_prefix: form.documentPrefix,
    timeout_ms: Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout) : 5000,
    max_chars: 8000,
  };
}

/** What the confirmation names: the model for a built-in, the endpoint and model for a remote one. */
function describe(spec: EmbedderSpec): string {
  return spec.kind === 'openai' ? `${spec.model} at ${spec.url}` : KIND_LABELS[spec.kind];
}

function EmbedderForm({ settings, status }: { settings: EmbedderSettings; status: ServerStatus | undefined }) {
  const [form, setForm] = useState<FormState>(() => fromSpec(settings.spec));
  const [probe, setProbe] = useState<EmbedderProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const test = useTestEmbedder();
  const apply = useSetEmbedder();
  const update = (patch: Partial<FormState>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setProbe(null);
    setProbeError(null);
  };

  const remote = form.kind === 'openai';
  const incomplete = remote && (form.url.trim() === '' || form.model.trim() === '');
  // A key left blank keeps the one already stored for a remote endpoint.
  const keepStoredKey = remote && form.apiKey.trim() === '' && settings.spec?.kind === 'openai';
  const request = () => ({ spec: toSpec(form), keep_stored_key: keepStoredKey });

  const runTest = (event: FormEvent) => {
    event.preventDefault();
    setProbe(null);
    setProbeError(null);
    test.mutate(request(), {
      onSuccess: setProbe,
      onError: (error) => {
        setProbeError(error instanceof ApiRequestError ? (error.detail ?? error.message) : error.message);
      },
    });
  };

  const confirmApply = () => {
    apply.mutate(request(), {
      onSuccess: (report) => {
        toast.success(
          report.vectors_kept
            ? `Embedder settings saved; ${report.embedder} keeps its vectors.`
            : `Switched to ${report.embedder}; ${formatCount(report.turns_to_embed)} turns queued for re-embedding.`,
        );
      },
      onError: toastApiError,
    });
  };

  const vectors = status?.engine.embeddings ?? 0;
  const turns = status?.engine.turns ?? 0;
  const spec = toSpec(form);
  const sameModel = settings.spec !== null && sameEmbedder(settings.spec, spec);
  // OptionSelect has no disabled option, so a build without ONNX leaves it out unless the store already uses it.
  const kindOptions = (['onnx', 'hash', 'openai'] as const)
    .filter((kind) => kind !== 'onnx' || settings.onnx_available || form.kind === 'onnx')
    .map((kind) => ({
      value: kind,
      label:
        kind === 'onnx' && !settings.onnx_available ? `${KIND_LABELS.onnx} — not in this build` : KIND_LABELS[kind],
    }));

  return (
    <form onSubmit={runTest} autoComplete="off" className="flex flex-col gap-4">
      <FormField
        className="max-w-sm"
        label="Kind"
        description={
          form.kind === 'onnx'
            ? 'BGE-small-en-v1.5 running in the server; downloaded once into the model cache.'
            : form.kind === 'hash'
              ? 'Deterministic word hashing. Word overlap, not meaning; for tests and CI.'
              : 'Any server speaking POST /v1/embeddings: Ollama, llama.cpp, vLLM, an NPU box, or the hosted API.'
        }
        control={(props) => (
          <OptionSelect
            {...props}
            options={kindOptions}
            value={form.kind}
            onValueChange={(kind) => update({ kind: kind as EmbedderKind })}
          />
        )}
      />

      {remote && (
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            label="Base URL"
            control={
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="http://localhost:11434/v1"
                value={form.url}
                onChange={(event) => update({ url: event.target.value })}
              />
            }
          />
          <FormField
            label="Model"
            control={
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="nomic-embed-text"
                value={form.model}
                onChange={(event) => update({ model: event.target.value })}
              />
            }
          />
          <FormField
            label="API key"
            description={
              settings.api_key_source === 'env'
                ? 'The key from ZEROMEM_EMBEDDING_API_KEY is in use and overrides whatever is saved here.'
                : 'Saved in the store as entered. Leave blank to keep the stored key.'
            }
            control={
              <PasswordInput
                showLabel="Show API key"
                hideLabel="Hide API key"
                // A text field followed by a password field looks like a login
                // form to browsers, which then fill the model as a username and
                // ignore autocomplete="off". `new-password` is the one value
                // they honour; the data-* attributes tell password managers to
                // stay out too.
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                spellCheck={false}
                placeholder={
                  settings.spec?.kind === 'openai' && settings.api_key_source !== 'none' ? '(unchanged)' : ''
                }
                value={form.apiKey}
                onChange={(event) => update({ apiKey: event.target.value })}
              />
            }
          />
          <FormField
            label="Timeout (ms)"
            control={
              <Input
                type="number"
                min={1}
                value={form.timeoutMs}
                onChange={(event) => update({ timeoutMs: event.target.value })}
              />
            }
          />
          <FormField
            label="Query prefix"
            control={
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="query: "
                value={form.queryPrefix}
                onChange={(event) => update({ queryPrefix: event.target.value })}
              />
            }
          />
          <FormField
            label="Document prefix"
            control={
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="passage: "
                value={form.documentPrefix}
                onChange={(event) => update({ documentPrefix: event.target.value })}
              />
            }
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={incomplete || test.isPending}>
          <PlugZapIcon aria-hidden />
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <ConfirmButton
          label="Apply"
          tooltip={false}
          disabled={incomplete || apply.isPending}
          title={sameModel ? 'Save embedder settings?' : `Switch the embedder to ${describe(spec)}?`}
          description={
            sameModel
              ? 'The model is unchanged, so the vectors are kept; only the endpoint settings are updated.'
              : `This drops ${formatCount(vectors)} vectors and re-embeds ${formatCount(turns)} turns with ${describe(spec)}. Recall uses the lexical and entity views for turns not yet re-embedded.`
          }
          confirmLabel={sameModel ? 'Save' : 'Switch'}
          onConfirm={confirmApply}
        >
          {apply.isPending ? 'Applying…' : 'Apply'}
        </ConfirmButton>
        {probe && (
          <p role="status" className="flex items-center gap-1 text-sm">
            <CheckIcon className="size-4 text-[var(--viz-good)]" aria-hidden />
            <span className="font-mono">{probe.embedder}</span> · {probe.embedder_dim} dims · {probe.latency_ms} ms
          </p>
        )}
        {probeError && (
          <p role="alert" className="text-sm text-destructive">
            {probeError}
          </p>
        )}
      </div>
    </form>
  );
}

/** Same model as the store's: a built-in of the same kind, or the same endpoint and model. */
function sameEmbedder(a: EmbedderSpec, b: EmbedderSpec): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind !== 'openai' || b.kind !== 'openai') {
    return true;
  }
  return a.url.replace(/\/+$/, '') === b.url.replace(/\/+$/, '') && a.model === b.model;
}

const HOUR_MS = 3_600_000;

/**
 * The curator: an outside agent that tidies the memory over /mcp. Its token
 * opens the curator tools and the `zeromem_curate` prompt; the limits bound
 * what one run can do; "every client" serves the curator tools to anyone who
 * can reach /mcp, for a setup with a single trusted agent.
 */
function Curator({ readOnly }: { readOnly: boolean }) {
  const settings = useCuratorSettings();
  return (
    <CardLayout
      title="Curator"
      description={
        <>
          An agent that hides duplicates and noise, marks superseded facts, merges entity names and writes notes, on a
          schedule. It reaches the store over /mcp with the curator token and the{' '}
          <span className="font-mono">zeromem_curate</span> prompt; every action it takes can be undone on the Curation
          page.
        </>
      }
      contentClassName="flex flex-col gap-6"
      content={
        <>
          {settings.isPending && <Skeleton className="h-40 w-full" />}
          {settings.error && (
            <QueryError what="the curator settings" error={settings.error} onRetry={() => settings.refetch()} />
          )}
          {settings.data && (
            <>
              <p className="text-sm text-muted-foreground">
                {settings.data.last_run_at === null ? (
                  'No run yet.'
                ) : (
                  <>
                    Last run ended{' '}
                    <span title={formatDateTime(settings.data.last_run_at)}>
                      {formatRelativeTime(settings.data.last_run_at)}
                    </span>
                    ; the next one starts after turn <span className="font-mono">#{settings.data.cursor}</span>.
                  </>
                )}
              </p>
              <CuratorToken settings={settings.data} readOnly={readOnly} />
              <CuratorLimits
                key={`${settings.data.max_per_call}-${settings.data.max_per_run}-${settings.data.min_age_ms}-${settings.data.expose_to_all}`}
                settings={settings.data}
                readOnly={readOnly}
              />
            </>
          )}
        </>
      }
    />
  );
}

function CuratorToken({ settings, readOnly }: { settings: CuratorSettings; readOnly: boolean }) {
  const generate = useGenerateCuratorToken();
  const update = useUpdateCuratorSettings();
  const [shown, setShown] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const fromEnv = settings.token_source === 'env';
  const busy = generate.isPending || update.isPending;
  const limits = {
    max_per_call: settings.max_per_call,
    max_per_run: settings.max_per_run,
    min_age_ms: settings.min_age_ms,
    expose_to_all: settings.expose_to_all,
  };

  const onGenerate = () => generate.mutate(undefined, { onSuccess: (r) => setShown(r.token), onError: toastApiError });
  const onClear = () =>
    update.mutate(
      { ...limits, token: null },
      { onSuccess: () => toast.success('Curator token cleared.'), onError: toastApiError },
    );
  const onSave = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      { ...limits, token: custom.trim() },
      {
        onSuccess: () => {
          setCustom('');
          toast.success('Curator token saved.');
        },
        onError: toastApiError,
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="Token"
        action={
          settings.token_set ? (
            <Badge variant="outline">{fromEnv ? 'set by MCP_ZEROMEM_CURATOR_TOKEN' : 'set'}</Badge>
          ) : (
            <Badge variant="secondary">not set</Badge>
          )
        }
        description={
          fromEnv
            ? 'The environment sets the token, which overrides one stored here; change it there.'
            : 'A bearer token for /mcp that adds the curator tools and prompt. It opens nothing under /api. The token is shown once, when it is generated.'
        }
      />
      {!readOnly && !fromEnv && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onGenerate}>
              <KeyRoundIcon aria-hidden />
              {settings.token_set ? 'Generate a new token' : 'Generate a token'}
            </Button>
            {settings.token_set && (
              <Button type="button" variant="ghost" disabled={busy} onClick={onClear}>
                Clear token
              </Button>
            )}
          </div>
          <form className="flex flex-col gap-1 sm:flex-row sm:items-end sm:gap-2" onSubmit={onSave}>
            <FormField
              className="flex-1"
              label="Or use your own"
              control={
                <PasswordInput
                  showLabel="Show token"
                  hideLabel="Hide token"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`At least ${CURATOR_LIMITS.tokenMinLength} characters`}
                  value={custom}
                  onChange={(event) => setCustom(event.target.value)}
                />
              }
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || custom.trim().length < CURATOR_LIMITS.tokenMinLength}
            >
              Save token
            </Button>
          </form>
        </>
      )}

      <AlertDialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>The curator token</AlertDialogTitle>
            <AlertDialogDescription>
              Copy it now: it is not shown again. Give it to the curator's MCP client as its bearer token. Any earlier
              token stops working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={shown ?? ''} className="font-mono" aria-label="Curator token" />
            <ActionButton
              variant="outline"
              size="icon"
              label="Copy the token"
              onClick={() => {
                void navigator.clipboard?.writeText(shown ?? '').then(() => toast.success('Copied.'));
              }}
            >
              <CopyIcon />
            </ActionButton>
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setShown(null)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface LimitValues {
  perCall: number | null;
  perRun: number | null;
  minAgeHours: number | null;
  exposeToAll: boolean;
}

function inRange(max: number) {
  return ({ value }: { value: number | null }) =>
    value === null || !Number.isInteger(value) || value < 1 || value > max
      ? `A whole number from 1 to ${formatCount(max)}.`
      : undefined;
}

function CuratorLimits({ settings, readOnly }: { settings: CuratorSettings; readOnly: boolean }) {
  const update = useUpdateCuratorSettings();
  const defaultValues: LimitValues = {
    perCall: settings.max_per_call,
    perRun: settings.max_per_run,
    minAgeHours: settings.min_age_ms / HOUR_MS,
    exposeToAll: settings.expose_to_all,
  };
  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) =>
      update
        .mutateAsync(
          {
            max_per_call: value.perCall ?? settings.max_per_call,
            max_per_run: value.perRun ?? settings.max_per_run,
            min_age_ms: Math.round((value.minAgeHours ?? 0) * HOUR_MS),
            expose_to_all: value.exposeToAll,
          },
          { onSuccess: () => toast.success('Curator settings saved.'), onError: toastApiError },
        )
        .catch(() => {}),
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <Section
        title="Limits"
        description="The minimum age keeps a live conversation from being curated under the person having it. Actions beyond a limit are refused and reported to the curator."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField
          form={form}
          name="perCall"
          label="Actions per call"
          min={1}
          max={CURATOR_LIMITS.maxPerCall}
          disabled={readOnly}
          validators={{ onChange: inRange(CURATOR_LIMITS.maxPerCall) }}
        />
        <NumberField
          form={form}
          name="perRun"
          label="Actions per run"
          min={1}
          max={CURATOR_LIMITS.maxPerRun}
          disabled={readOnly}
          validators={{ onChange: inRange(CURATOR_LIMITS.maxPerRun) }}
        />
        <NumberField
          form={form}
          name="minAgeHours"
          label="Minimum turn age (hours)"
          min={0}
          step="any"
          disabled={readOnly}
          validators={{
            onChange: ({ value }) => (value === null || value < 0 ? 'Zero or more hours.' : undefined),
          }}
        />
      </div>
      <SwitchField
        form={form}
        name="exposeToAll"
        label="Serve the curator tools to every client"
        description="Every client that can reach /mcp gets the curator tools and prompt, not only the curator token. The stdio server follows this too. Use it when a single trusted agent both remembers and curates."
        disabled={readOnly}
      />
      <form.Subscribe selector={(state) => state.values.exposeToAll}>
        {(exposeToAll) =>
          exposeToAll &&
          !settings.expose_to_all && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
              Every agent will see five more tools, and can hide or supersede turns.
            </p>
          )
        }
      </form.Subscribe>
      {readOnly ? (
        <p className="text-sm text-muted-foreground">
          This server is read-only (ZEROMEM_READ_ONLY), so the curator settings cannot be changed from here.
        </p>
      ) : (
        <div>
          <form.AppForm>
            <form.Subscribe selector={(state) => state.isDefaultValue}>
              {(unchanged) => <form.SubmitButton disabled={unchanged || update.isPending} />}
            </form.Subscribe>
          </form.AppForm>
        </div>
      )}
    </form>
  );
}
