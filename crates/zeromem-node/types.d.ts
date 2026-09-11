/** Result shapes returned by the engine as plain objects (serde output of zeromem-core types). */
export interface Stats {
  home: string;
  turns: number;
  sessions: number;
  entities: number;
  edges: number;
  windows: number;
  episodes: number;
  embeddings: number;
  /** Turns with no vector under the store's embedder. */
  embedding_backlog: number;
  /** The store's embedder name (`bge-small-en-v1.5`, `hash-384`, `openai:<model>@<dim>`). */
  embedder: string | null;
  embedder_kind: EmbedderKind | null;
  embedder_dim: number | null;
  /** Whether this process can embed with the store's embedder. */
  embedder_active: boolean;
  embedder_is_fallback: boolean;
  embedder_warning: string | null;
  generation: number;
  schema_version: number;
}

export type EmbedderKind = 'onnx' | 'hash' | 'openai';

export interface RemoteEmbedderSpec {
  kind: 'openai';
  /** Base URL up to `/v1`. */
  url: string;
  model: string;
  /** Learned from the first response when null. */
  dim?: number | null;
  /** Never returned by the engine; only accepted. */
  api_key?: string | null;
  query_prefix?: string;
  document_prefix?: string;
  timeout_ms?: number;
  max_chars?: number;
}

export type EmbedderSpec = { kind: 'onnx' } | { kind: 'hash' } | RemoteEmbedderSpec;

export type ApiKeySource = 'env' | 'store' | 'none';

export interface EmbedderSettings {
  /** The recorded spec with its key redacted; null on a store no process has seeded. */
  spec: EmbedderSpec | null;
  embedder: string | null;
  embedder_kind: EmbedderKind | null;
  embedder_dim: number | null;
  /** Whether this process can embed with the store's embedder. */
  active: boolean;
  embedder_is_fallback: boolean;
  embedder_warning: string | null;
  embedding_backlog: number;
  api_key_source: ApiKeySource;
  onnx_available: boolean;
}

export interface EmbedderSwitch {
  embedder: string;
  embedder_dim: number;
  turns_to_embed: number;
  /** True when the spec named the same model and the vectors were kept. */
  vectors_kept: boolean;
}

export interface EmbedderProbe {
  embedder: string;
  embedder_kind: EmbedderKind;
  embedder_dim: number;
  latency_ms: number;
}

export type IngestOutcome = { outcome: 'indexed'; id: number } | { outcome: 'duplicate'; id: number };

export interface IngestReport {
  indexed: number;
  duplicates: number;
  rejected: number;
}

export interface SessionSummary {
  session_id: string;
  turns: number;
  first_ts: number;
  last_ts: number;
}

export interface StoredTurn {
  id: number;
  uuid: string;
  session_id: string;
  speaker: string;
  text: string;
  ts: number;
}

export type ViewKind = 'lexical' | 'entity' | 'dense' | 'recent';
export type Role = 'primary' | 'supporting';

export interface Profile {
  text: string;
  tokens: string[];
  entities: string[];
  temporal: boolean;
  question: boolean;
}

export interface ViewSummary {
  view: ViewKind;
  weight: number;
  candidates: number;
}

export interface Route {
  profile: Profile;
  views: ViewSummary[];
}

export interface Evidence {
  turn: StoredTurn;
  score: number;
  confidence: number;
  role: Role;
  /** Present under `detail: 'full'`. */
  sources?: ViewKind[];
  /** Present under `detail: 'full'`. */
  entities?: string[];
}

export interface QueryResult {
  query: string;
  /** Present under `detail: 'full'`. */
  route?: Route;
  evidence: Evidence[];
  considered: number;
  took_ms: number;
}

export interface ViewTrace {
  view: ViewKind;
  weight: number;
  candidates: [number, number][];
}

export interface Fused {
  id: number;
  score: number;
  sources: ViewKind[];
  ts: number;
  uuid: string;
}

export interface Dropped {
  id: number;
  score: number;
  reason: string;
}

export interface QueryTrace {
  query: string;
  profile: Profile;
  views: ViewTrace[];
  fused: Fused[];
  dropped: Dropped[];
  evidence: Evidence[];
  took_ms: number;
}

// --- visualisation reads -------------------------------------------------------

export type EntityKind = 'name' | 'date' | 'quantity';

export interface GraphNode {
  entity: string;
  kind: EntityKind;
  turns: number;
  /** Edges touching this entity in the whole graph, not only the snapshot. */
  degree: number;
  first_ts: number;
  last_ts: number;
}

export interface GraphEdge {
  a: string;
  b: string;
  turns: number;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_entities: number;
  total_edges: number;
  truncated: boolean;
  generation: number;
}

export interface HierarchySegment {
  start_ts: number;
  end_ts: number;
  first_turn_id: number;
  last_turn_id: number;
  turns: number;
  entities: string[];
}

export interface HierarchySession {
  session_id: string;
  turns: number;
  first_ts: number;
  last_ts: number;
  windows: HierarchySegment[];
  episodes: HierarchySegment[];
}

export interface HierarchySnapshot {
  sessions: HierarchySession[];
  total_sessions: number;
  generation: number;
}

export interface Mention {
  key: string;
  kind: EntityKind;
  surface: string;
  start: number;
  end: number;
}

export interface TurnWithEntities extends StoredTurn {
  entities: Mention[];
}

export interface Point2D {
  turn_id: number;
  session_id: string;
  speaker: string;
  ts: number;
  text: string;
  x: number;
  y: number;
}

export interface Basis {
  mean: number[];
  axes: [number[], number[]];
  variance_explained: [number, number];
}

export interface QueryPoint {
  text: string;
  x: number;
  y: number;
  neighbours: number[];
}

export interface Projection {
  points: Point2D[];
  basis: Basis;
  query: QueryPoint | null;
  embedder: string;
  total: number;
  generation: number;
}

export interface GrowthDay {
  day: string;
  turns: number;
  sessions: number;
  cumulative_turns: number;
}

export interface Growth {
  days: GrowthDay[];
  generation: number;
}
