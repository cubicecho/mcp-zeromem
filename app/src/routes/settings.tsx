import type { EmbedderKind, EmbedderProbe, EmbedderSettings, EmbedderSpec, ServerStatus } from '@mcp-zeromem/shared';
import { createFileRoute } from '@tanstack/react-router';
import { CheckIcon, PlugZapIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
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
import { ApiRequestError } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { useEmbedderSettings, useServerStatus, useSetEmbedder, useTestEmbedder } from '@/lib/queries';
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
 * The store's embedder, and the form that changes it. The choice is written
 * into the store, so the stdio server and the host's `zm` hooks follow it on
 * their next read; a switch drops every vector and the server's worker
 * re-embeds the corpus in the background, which the progress bar tracks.
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
          What the store is embedded with. A change here is recorded in the store itself, so every process that opens it
          follows.
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
    </div>
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
    <form onSubmit={runTest} className="flex flex-col gap-4">
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
              placeholder="http://localhost:11434/v1"
              value={form.url}
              onChange={(event) => update({ url: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="embedder-model">Model</Label>
            <Input
              id="embedder-model"
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
              autoComplete="off"
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
              placeholder="query: "
              value={form.queryPrefix}
              onChange={(event) => update({ queryPrefix: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="embedder-document-prefix">Document prefix</Label>
            <Input
              id="embedder-document-prefix"
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
