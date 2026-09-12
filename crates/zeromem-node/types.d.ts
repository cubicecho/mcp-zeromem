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
  /** Advances on every curation change. */
  curation_seq: number;
  /** Turns hidden by curation. */
  hidden: number;
  /** Curator notes. */
  notes: number;
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

/** What clearing the vectors or the whole memory removed. */
export interface ClearReport {
  turns_removed: number;
  sessions_removed: number;
  vectors_removed: number;
  /** Every turn after clearing the vectors; none after clearing the memory. */
  turns_to_embed: number;
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

/** One conversation in order: a whole session, or a window around one turn. */
export interface SessionWindow {
  session_id: string;
  turns: StoredTurn[];
  /** The anchor, when `around_turn` asked for one. */
  around_turn?: number;
  /** Turns in the whole session. */
  total: number;
  /** Where the first returned turn sits in the session, in time order. */
  offset: number;
  /** The answer is not the whole session; page on with `offset`. */
  truncated: boolean;
}

export type TurnKind = 'turn' | 'note';

export interface StoredTurn {
  id: number;
  uuid: string;
  session_id: string;
  speaker: string;
  text: string;
  ts: number;
  /** `note` for a curator's note; left out for an ordinary turn. */
  kind?: TurnKind;
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
  /** The newer turn that restates this one; its score was halved. */
  superseded_by?: number;
  /** Hidden by curation; only with `include_hidden`. */
  hidden?: boolean;
  /** For a note: the source turns collapsed under it. */
  covers?: number[];
  /** Same-session turns just before this one, oldest first; only with `context`. */
  before?: StoredTurn[];
  /** Same-session turns just after this one, oldest first; only with `context`. */
  after?: StoredTurn[];
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

export type EntityKind = 'name' | 'date' | 'quantity' | 'path' | 'symbol' | 'env';

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

export interface TurnWithEntities extends StoredTurn, TurnCuration {
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

// --- curation ---------------------------------------------------------------

export interface CuratorConfig {
  /** Most actions one apply call may carry. */
  max_per_call: number;
  /** Most actions one run may apply in total. */
  max_per_run: number;
  /** Turns younger than this are never touched. */
  min_age_ms: number;
  /** Bearer token that grants the curator scope; null when none is stored. */
  token: string | null;
  /** Give every MCP client the curator tools. */
  expose_to_all: boolean;
}

export type CurationOp =
  | { op: 'hide'; turn_ids: number[] }
  | { op: 'unhide'; turn_ids: number[] }
  | { op: 'supersede'; turn_ids: number[]; by: number }
  | { op: 'alias'; alias: string; canonical: string }
  | { op: 'unalias'; alias: string }
  | { op: 'block'; entity: string }
  | { op: 'unblock'; entity: string }
  | { op: 'note'; session_id: string; text: string; source_ids: number[] }
  | { op: 'run_end'; summary?: string; cursor?: number | null };

/** An op and why; `reason` is required for everything but `run_end`. */
export type CurationAction = CurationOp & { reason?: string };

export interface ActionResult {
  index: number;
  op: string;
  ok: boolean;
  action_id?: number;
  note_id?: number;
  error?: string;
}

export interface ApplyReport {
  run_id: string;
  dry_run: boolean;
  results: ActionResult[];
  applied: number;
  rejected: number;
}

export interface UndoReport {
  /** Action ids undone, in the order they were undone. */
  undone: number[];
}

/** Curation facts about a turn, each left out when empty. */
export interface TurnCuration {
  hidden?: boolean;
  superseded_by?: number;
  /** Turns this one supersedes. */
  supersedes?: number[];
  /** Notes that stand for this turn. */
  covered_by?: number[];
  /** For a note, the turns it stands for. */
  sources?: number[];
}

export interface CuratedTurn extends StoredTurn, TurnCuration {
  entities: Mention[];
}

export interface RunSummary {
  run_id: string;
  actor: string;
  started_at: number;
  ended_at: number;
  actions: number;
  undone: number;
  /** Live actions per op. */
  ops: Record<string, number>;
  summary: string | null;
  finished: boolean;
}

export interface CurationRuns {
  runs: RunSummary[];
  total: number;
  /** Where the next run's finders start. */
  cursor: number;
  curation_seq: number;
}

export interface TargetTurn {
  uuid: string;
  /** Null once the turn is gone. */
  id: number | null;
  session_id: string | null;
  text: string | null;
}

export interface ActionRow {
  id: number;
  run_id: string;
  actor: string;
  ts: number;
  op: string;
  payload: Record<string, unknown>;
  reason: string;
  undone_at: number | null;
  undone_by: string | null;
  targets: TargetTurn[];
}

export interface CurationActions {
  actions: ActionRow[];
  total: number;
}

export interface AliasEntry {
  alias: string;
  canonical: string;
  action_id: number | null;
}

export interface BlockEntry {
  entity: string;
  action_id: number | null;
}

export interface CurationAliases {
  aliases: AliasEntry[];
  blocklist: BlockEntry[];
}

export type CandidateKind = 'duplicates' | 'noise' | 'aliases' | 'supersession' | 'consolidation';

export interface CandidateTurn {
  id: number;
  session_id: string;
  speaker: string;
  ts: number;
  /** Clipped; `curationTurns` has the rest. */
  text: string;
}

export interface Candidate {
  kind: CandidateKind;
  /** How sure the finder is, in [0, 1]. Not a verdict. */
  score: number;
  turns: CandidateTurn[];
  entities?: string[];
  reason: string;
  /** What applying it would look like; a note's text is left empty. */
  suggested: CurationOp;
}

export interface CandidatePage {
  kind: CandidateKind;
  since_turn_id: number;
  candidates: Candidate[];
  /** Pass as `since_turn_id` to continue. */
  scanned_through: number;
  more: boolean;
}
