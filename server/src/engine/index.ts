import { Engine } from '@mcp-zeromem/native';
import {
  type EmbedderChoice,
  type EmbedderProbe,
  type EmbedderSettings,
  type EmbedderSpec,
  type EmbedderSwitch,
  embedderProbeSchema,
  embedderSettingsSchema,
  embedderSwitchSchema,
  type GraphOptions,
  type GraphSnapshot,
  type Growth,
  type GrowthOptions,
  graphSnapshotSchema,
  growthSchema,
  type HierarchyOptions,
  type HierarchySnapshot,
  hierarchySnapshotSchema,
  type IngestOutcome,
  type IngestReport,
  ingestOutcomeSchema,
  ingestReportSchema,
  type Projection,
  type ProjectionOptions,
  projectionSchema,
  type QueryResult,
  type QueryTrace,
  queryResultSchema,
  queryTraceSchema,
  type RecallOptions,
  type SessionSummary,
  type Stats,
  type StoredTurn,
  sessionSummarySchema,
  statsSchema,
  storedTurnSchema,
  type TurnInput,
  type TurnWithEntities,
  turnWithEntitiesSchema,
} from '@mcp-zeromem/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { Metrics } from '../metrics.ts';

/**
 * The TypeScript face of the Rust engine.
 *
 * The native binding hands back plain objects whose shape is declared in a
 * hand-written `.d.ts`, which nothing checks at build time. Every result is
 * therefore run through the shared zod schema on the way out: a field renamed
 * on the Rust side fails here, loudly, at the first call, rather than
 * surfacing as `undefined` in a UI card three layers up.
 */
/** An OpenAI-compatible endpoint, as the seed for a fresh store or the target of a forced switch. */
export interface RemoteEmbedderOptions {
  /** Base URL up to `/v1`. */
  url: string;
  model: string;
  /** Learned from the first response when omitted. */
  dim?: number | null;
  query_prefix?: string;
  document_prefix?: string;
  timeout_ms?: number;
  max_chars?: number;
}

export interface EngineOptions {
  /**
   * What this process asks for. A store records its own embedder and is
   * followed whatever this says; `auto` (default) seeds a fresh store with
   * ONNX when it loads and the hash fallback, loudly, otherwise.
   */
  embedder?: EmbedderChoice;
  /** Open a store built by another embedder, dropping and remaking every vector. */
  allowEmbedderSwitch?: boolean;
  /** The endpoint `openai` refers to. */
  remoteEmbedder?: RemoteEmbedderOptions | null;
  /** Bearer token for a remote endpoint; overrides the key stored in the store. */
  embeddingApiKey?: string | null;
  /**
   * Whether this process talks to a remote endpoint itself. The HTTP server
   * does; a stdio session leaves embedding to the server's worker so a
   * conversation never waits on the network.
   */
  followRemote?: boolean;
}

export class ZeroMemEngine {
  readonly home: string;
  /** Recall latency and ingest counters for this process, for the health view. */
  readonly metrics = new Metrics();
  private readonly native: Engine;

  private constructor(native: Engine, openMs: number) {
    this.native = native;
    this.home = native.home;
    this.metrics.recordOpen(openMs);
  }

  /**
   * Open (creating if needed) the store under `home`. Synchronous, and slow
   * the first time with the ONNX embedder: the model is loaded here, and
   * downloaded first if the cache is empty.
   */
  static open(home: string, options: EngineOptions = {}): ZeroMemEngine {
    const start = performance.now();
    const remote = options.remoteEmbedder ?? undefined;
    const native = Engine.open(home, {
      embedder: options.embedder,
      allow_embedder_switch: options.allowEmbedderSwitch,
      remote: remote && {
        url: remote.url,
        model: remote.model,
        dim: remote.dim ?? undefined,
        query_prefix: remote.query_prefix,
        document_prefix: remote.document_prefix,
        timeout_ms: remote.timeout_ms,
        max_chars: remote.max_chars,
      },
      api_key: options.embeddingApiKey ?? undefined,
      follow_remote: options.followRemote,
    });
    return new ZeroMemEngine(native, performance.now() - start);
  }

  stats(): Promise<Stats> {
    return check(statsSchema, this.native.stats());
  }

  async ingestTurn(turn: TurnInput): Promise<IngestOutcome> {
    const outcome = await check(ingestOutcomeSchema, this.native.ingestTurn(turn));
    this.metrics.recordIngest(outcome.outcome === 'indexed' ? 1 : 0);
    return outcome;
  }

  async ingestMany(turns: TurnInput[]): Promise<IngestReport> {
    const report = await check(ingestReportSchema, this.native.ingestMany(turns));
    this.metrics.recordIngest(report.indexed);
    return report;
  }

  listSessions(page?: { limit?: number; offset?: number }): Promise<SessionSummary[]> {
    return check(sessionSummarySchema.array(), this.native.listSessions(page));
  }

  sessionTurns(sessionId: string, page?: { limit?: number; offset?: number }): Promise<StoredTurn[]> {
    return check(storedTurnSchema.array(), this.native.sessionTurns(sessionId, page));
  }

  /** Remove every turn of a session; resolves to the number removed. */
  deleteSession(sessionId: string): Promise<number> {
    return this.native.deleteSession(sessionId);
  }

  /** Pick up turns written by other processes; resolves to the number newly visible. */
  refresh(): Promise<number> {
    return this.native.refresh();
  }

  /** Recall: the evidence bearing on `query`, best first. */
  query(query: string, options: RecallOptions = {}): Promise<QueryResult> {
    return this.metrics.timeRecall(() => check(queryResultSchema, this.native.query(query, options)));
  }

  /** The same recall with every stage kept, for the trace view. */
  queryTrace(query: string, options: RecallOptions = {}): Promise<QueryTrace> {
    return this.metrics.timeRecall(() => check(queryTraceSchema, this.native.queryTrace(query, options)));
  }

  /** Recompute every derived index from the turns; embeddings are kept. */
  rebuild(): Promise<void> {
    return this.native.rebuild();
  }

  // --- the embedder -----------------------------------------------------------

  /** The store's embedder with its key redacted, whether this process can use it, and the backlog. */
  embedderSettings(): Promise<EmbedderSettings> {
    return check(embedderSettingsSchema, this.native.embedderSettings());
  }

  /**
   * Build `spec` and run one text through it; the store is untouched.
   * Rejects when the endpoint fails. `keepStoredKey` fills a remote spec's
   * missing key from the store, as {@link setEmbedder} would.
   */
  probeEmbedder(spec: EmbedderSpec, keepStoredKey = false): Promise<EmbedderProbe> {
    return check(embedderProbeSchema, this.native.probeEmbedder(spec, keepStoredKey));
  }

  /**
   * Change the store's embedder. Probed first, so a bad endpoint leaves the
   * store as it was; on success vectors of another model are dropped and the
   * turns wait in the backlog for {@link embedBacklog}.
   */
  setEmbedder(spec: EmbedderSpec, keepStoredKey = false): Promise<EmbedderSwitch> {
    return check(embedderSwitchSchema, this.native.setEmbedder(spec, keepStoredKey));
  }

  /** Turns with no vector under the store's embedder. */
  embeddingBacklog(): Promise<number> {
    return this.native.embeddingBacklog();
  }

  /** Embed up to `limit` turns from the backlog; resolves to how many remain. Rejects when the embedder fails. */
  embedBacklog(limit = 256): Promise<number> {
    return this.native.embedBacklog(limit);
  }

  // --- reads for the visualisations; every one is capped on the Rust side ---

  /** The entity graph: the most-mentioned entities, or a neighbourhood around `focus`. */
  graphSnapshot(options: GraphOptions = {}): Promise<GraphSnapshot> {
    return check(graphSnapshotSchema, this.native.graphSnapshot(options));
  }

  /** Sessions with their windows and episodes, paged and range-filtered. */
  hierarchy(options: HierarchyOptions = {}): Promise<HierarchySnapshot> {
    return check(hierarchySnapshotSchema, this.native.hierarchy(options));
  }

  /** A session's turns in order, each with its entity spans. */
  sessionTurnsWithEntities(sessionId: string, page?: { limit?: number; offset?: number }): Promise<TurnWithEntities[]> {
    return check(turnWithEntitiesSchema.array(), this.native.sessionTurnsWithEntities(sessionId, page));
  }

  /** A 2-D PCA of a stable sample of turn vectors, with an optional query overlay. */
  projection(options: ProjectionOptions = {}): Promise<Projection> {
    return check(projectionSchema, this.native.projection(options));
  }

  /** Turns and active sessions per UTC day. */
  growth(options: GrowthOptions = {}): Promise<Growth> {
    return check(growthSchema, this.native.growth(options));
  }
}

async function check<T>(schema: ZodType<T, ZodTypeDef, unknown>, result: Promise<unknown>): Promise<T> {
  const value = await result;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`native engine returned an unexpected shape: ${parsed.error.message}`, { cause: parsed.error });
  }
  return parsed.data;
}
