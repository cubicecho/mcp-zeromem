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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          What the store is embedded with, and what it holds. A change here is recorded in the store itself, so every
          process that opens it follows.
        </p>
      </div>

      {settings.isPending && <Skeleton className="h-64 w-full" />}
      {settings.error && (
        <p className="text-sm text-destructive">Failed to load the embedder settings: {settings.error.message}</p>
      )}
      {settings.data && (
        <Card>
          <CardHeader>
            <CardTitle>Embedder</CardTitle>
            <CardDescription>The model behind the dense view, and how to reach it.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
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
          </CardContent>
        </Card>
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
  const [confirming, setConfirming] = useState(false);
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
      onSettled: () => setConfirming(false),
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Vectors missing or stale? Re-embed every turn with <span className="font-mono">{name}</span>. It is tested
        first, so an embedder that still fails leaves the vectors alone.
      </p>
      <Button
        type="button"
        variant="outline"
        className="shrink-0"
        disabled={reembed.isPending || turns === 0}
        onClick={() => setConfirming(true)}
      >
        <RefreshCwIcon aria-hidden />
        {reembed.isPending ? 'Re-embedding…' : 'Re-embed all turns'}
      </Button>
      <AlertDialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-embed every turn with {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This drops {formatCount(vectors)} vectors and re-embeds {formatCount(turns)} turns in the background.
              Recall uses the lexical and entity views for turns not yet re-embedded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reembed.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirm();
              }}
              disabled={reembed.isPending}
            >
              {reembed.isPending ? 'Re-embedding…' : 'Re-embed'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const [confirming, setConfirming] = useState<'embeddings' | 'memory' | null>(null);
  const [typed, setTyped] = useState('');
  const clear = useClearStore();
  const { turns, sessions, embeddings, entities } = status.engine;

  const close = () => {
    setConfirming(null);
    setTyped('');
  };
  const confirm = () => {
    if (!confirming) {
      return;
    }
    clear.mutate(confirming, {
      onSuccess: (report) => {
        toast.success(
          confirming === 'embeddings'
            ? `Cleared ${formatCount(report.vectors_removed)} vectors; ${formatCount(report.turns_to_embed)} turns queued for re-embedding.`
            : `Cleared ${formatCount(report.turns_removed)} turns from ${formatCount(report.sessions_removed)} sessions.`,
        );
      },
      onError: toastApiError,
      onSettled: close,
    });
  };
  const memoryLocked = confirming === 'memory' && typed.trim().toLowerCase() !== CLEAR_WORD;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stored data</CardTitle>
        <CardDescription>
          {formatCount(turns)} turns in {formatCount(sessions)} sessions, {formatCount(entities)} entities and{' '}
          {formatCount(embeddings)} vectors.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {readOnly ? (
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
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={clear.isPending || embeddings === 0}
                onClick={() => setConfirming('embeddings')}
              >
                <EraserIcon aria-hidden />
                Clear vectors
              </Button>
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
                onClick={() => setConfirming('memory')}
              >
                <Trash2Icon aria-hidden />
                Clear all memory
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === 'memory' ? 'Clear all memory?' : `Clear ${formatCount(embeddings)} vectors?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === 'memory'
                ? `This deletes ${formatCount(turns)} turns from ${formatCount(sessions)} sessions, with their entities, summaries and vectors, for every process using this store. It cannot be undone.`
                : `The ${formatCount(turns)} turns stay and are re-embedded in the background. Recall uses the lexical and entity views until they are.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirming === 'memory' && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="clear-confirm">
                Type <span className="font-mono">{CLEAR_WORD}</span> to confirm
              </Label>
              <Input
                id="clear-confirm"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clear.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirming === 'memory' ? 'destructive' : 'default'}
              onClick={(event) => {
                event.preventDefault();
                confirm();
              }}
              disabled={clear.isPending || memoryLocked}
            >
              {clear.isPending ? 'Clearing…' : confirming === 'memory' ? 'Clear memory' : 'Clear vectors'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
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
  const [confirming, setConfirming] = useState(false);
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
      onSettled: () => setConfirming(false),
    });
  };

  const vectors = status?.engine.embeddings ?? 0;
  const turns = status?.engine.turns ?? 0;
  const spec = toSpec(form);
  const sameModel = settings.spec !== null && sameEmbedder(settings.spec, spec);

  return (
    <form onSubmit={runTest} autoComplete="off" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="embedder-kind">Kind</Label>
        <Select value={form.kind} onValueChange={(kind) => update({ kind: kind as EmbedderKind })}>
          <SelectTrigger id="embedder-kind" className="w-full max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="onnx" disabled={!settings.onnx_available}>
              {KIND_LABELS.onnx}
              {settings.onnx_available ? '' : ' — not in this build'}
            </SelectItem>
            <SelectItem value="hash">{KIND_LABELS.hash}</SelectItem>
            <SelectItem value="openai">{KIND_LABELS.openai}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {form.kind === 'onnx' && 'BGE-small-en-v1.5 running in the server; downloaded once into the model cache.'}
          {form.kind === 'hash' && 'Deterministic word hashing. Word overlap, not meaning; for tests and CI.'}
          {form.kind === 'openai' &&
            'Any server speaking POST /v1/embeddings: Ollama, llama.cpp, vLLM, an NPU box, or the hosted API.'}
        </p>
      </div>

      {remote && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="embedder-url">Base URL</Label>
            <Input
              id="embedder-url"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://localhost:11434/v1"
              value={form.url}
              onChange={(event) => update({ url: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="embedder-model">Model</Label>
            <Input
              id="embedder-model"
              autoComplete="off"
              spellCheck={false}
              placeholder="nomic-embed-text"
              value={form.model}
              onChange={(event) => update({ model: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="embedder-key">API key</Label>
            <Input
              id="embedder-key"
              type="password"
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
              placeholder={settings.spec?.kind === 'openai' && settings.api_key_source !== 'none' ? '(unchanged)' : ''}
              value={form.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {settings.api_key_source === 'env'
                ? 'The key from ZEROMEM_EMBEDDING_API_KEY is in use and overrides whatever is saved here.'
                : 'Saved in the store as entered. Leave blank to keep the stored key.'}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="embedder-timeout">Timeout (ms)</Label>
            <Input
              id="embedder-timeout"
              type="number"
              min={1}
              value={form.timeoutMs}
              onChange={(event) => update({ timeoutMs: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="embedder-query-prefix">Query prefix</Label>
            <Input
              id="embedder-query-prefix"
              autoComplete="off"
              spellCheck={false}
              placeholder="query: "
              value={form.queryPrefix}
              onChange={(event) => update({ queryPrefix: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="embedder-document-prefix">Document prefix</Label>
            <Input
              id="embedder-document-prefix"
              autoComplete="off"
              spellCheck={false}
              placeholder="passage: "
              value={form.documentPrefix}
              onChange={(event) => update({ documentPrefix: event.target.value })}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={incomplete || test.isPending}>
          <PlugZapIcon aria-hidden />
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <Button type="button" disabled={incomplete || apply.isPending} onClick={() => setConfirming(true)}>
          {apply.isPending ? 'Applying…' : 'Apply'}
        </Button>
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

      <AlertDialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {sameModel ? 'Save embedder settings?' : `Switch the embedder to ${describe(spec)}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {sameModel
                ? 'The model is unchanged, so the vectors are kept; only the endpoint settings are updated.'
                : `This drops ${formatCount(vectors)} vectors and re-embeds ${formatCount(turns)} turns with ${describe(spec)}. Recall uses the lexical and entity views for turns not yet re-embedded.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={apply.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmApply();
              }}
              disabled={apply.isPending}
            >
              {apply.isPending ? 'Applying…' : sameModel ? 'Save' : 'Switch'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    <Card>
      <CardHeader>
        <CardTitle>Curator</CardTitle>
        <CardDescription>
          An agent that hides duplicates and noise, marks superseded facts, merges entity names and writes notes, on a
          schedule. It reaches the store over /mcp with the curator token and the{' '}
          <span className="font-mono">zeromem_curate</span> prompt; every action it takes can be undone on the Curation
          page.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {settings.isPending && <Skeleton className="h-40 w-full" />}
        {settings.error && (
          <p className="text-sm text-destructive">Failed to load the curator settings: {settings.error.message}</p>
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
      </CardContent>
    </Card>
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
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Token</h3>
        {settings.token_set ? (
          <Badge variant="outline">{fromEnv ? 'set by MCP_ZEROMEM_CURATOR_TOKEN' : 'set'}</Badge>
        ) : (
          <Badge variant="secondary">not set</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {fromEnv
          ? 'The environment sets the token, which overrides one stored here; change it there.'
          : 'A bearer token for /mcp that adds the curator tools and prompt. It opens nothing under /api. The token is shown once, when it is generated.'}
      </p>
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
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="curator-token">Or use your own</Label>
              <Input
                id="curator-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={`At least ${CURATOR_LIMITS.tokenMinLength} characters`}
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
            </div>
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
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Copy the token"
              onClick={() => {
                void navigator.clipboard?.writeText(shown ?? '').then(() => toast.success('Copied.'));
              }}
            >
              <CopyIcon />
            </Button>
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setShown(null)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CuratorLimits({ settings, readOnly }: { settings: CuratorSettings; readOnly: boolean }) {
  const update = useUpdateCuratorSettings();
  const [perCall, setPerCall] = useState(String(settings.max_per_call));
  const [perRun, setPerRun] = useState(String(settings.max_per_run));
  const [minAgeHours, setMinAgeHours] = useState(String(settings.min_age_ms / HOUR_MS));
  const [exposeToAll, setExposeToAll] = useState(settings.expose_to_all);

  const perCallN = Number(perCall);
  const perRunN = Number(perRun);
  const minAgeN = Number(minAgeHours);
  const valid =
    Number.isInteger(perCallN) &&
    perCallN >= 1 &&
    perCallN <= CURATOR_LIMITS.maxPerCall &&
    Number.isInteger(perRunN) &&
    perRunN >= 1 &&
    perRunN <= CURATOR_LIMITS.maxPerRun &&
    Number.isFinite(minAgeN) &&
    minAgeN >= 0;
  const dirty =
    perCallN !== settings.max_per_call ||
    perRunN !== settings.max_per_run ||
    Math.round(minAgeN * HOUR_MS) !== settings.min_age_ms ||
    exposeToAll !== settings.expose_to_all;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        max_per_call: perCallN,
        max_per_run: perRunN,
        min_age_ms: Math.round(minAgeN * HOUR_MS),
        expose_to_all: exposeToAll,
      },
      { onSuccess: () => toast.success('Curator settings saved.'), onError: toastApiError },
    );
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <h3 className="text-sm font-medium">Limits</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="curator-per-call">Actions per call</Label>
          <Input
            id="curator-per-call"
            type="number"
            min={1}
            max={CURATOR_LIMITS.maxPerCall}
            disabled={readOnly}
            value={perCall}
            onChange={(event) => setPerCall(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="curator-per-run">Actions per run</Label>
          <Input
            id="curator-per-run"
            type="number"
            min={1}
            max={CURATOR_LIMITS.maxPerRun}
            disabled={readOnly}
            value={perRun}
            onChange={(event) => setPerRun(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="curator-min-age">Minimum turn age (hours)</Label>
          <Input
            id="curator-min-age"
            type="number"
            min={0}
            step="any"
            disabled={readOnly}
            value={minAgeHours}
            onChange={(event) => setMinAgeHours(event.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The minimum age keeps a live conversation from being curated under the person having it. Actions beyond a limit
        are refused and reported to the curator.
      </p>
      <div className="flex items-start gap-3">
        <Switch
          id="curator-expose"
          checked={exposeToAll}
          disabled={readOnly}
          onCheckedChange={setExposeToAll}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="curator-expose">Serve the curator tools to every client</Label>
          <p className="text-xs text-muted-foreground">
            Every client that can reach /mcp gets the curator tools and prompt, not only the curator token. The stdio
            server follows this too. Use it when a single trusted agent both remembers and curates.
          </p>
        </div>
      </div>
      {exposeToAll && !settings.expose_to_all && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
          Every agent will see five more tools, and can hide or supersede turns.
        </p>
      )}
      {readOnly ? (
        <p className="text-sm text-muted-foreground">
          This server is read-only (ZEROMEM_READ_ONLY), so the curator settings cannot be changed from here.
        </p>
      ) : (
        <div>
          <Button type="submit" disabled={!valid || !dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </form>
  );
}
