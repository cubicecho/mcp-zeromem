import { z } from 'zod';

/**
 * Shapes the engine returns, as the server and the UI both see them. These
 * mirror the serde output of `zeromem-core::types` — snake_case on the wire,
 * because that is what the Rust side emits and translating field names in two
 * places is a bug factory. The server validates native results against these
 * before trusting them, so a drift between the crate and this file fails
 * loudly rather than rendering `undefined`.
 */

const count = z.number().int().nonnegative();

export const embedderKindSchema = z.enum(['onnx', 'hash', 'openai']);
export type EmbedderKind = z.infer<typeof embedderKindSchema>;

export const statsSchema = z.object({
  home: z.string(),
  turns: count,
  sessions: count,
  entities: count,
  edges: count,
  windows: count,
  episodes: count,
  embeddings: count,
  /** Turns with no vector under the store's embedder; drained by the server's worker. */
  embedding_backlog: count,
  /** The store's embedder name; null when no process has seeded one. */
  embedder: z.string().nullable(),
  embedder_kind: embedderKindSchema.nullable(),
  embedder_dim: z.number().int().positive().nullable(),
  /** Whether this process can embed with the store's embedder. */
  embedder_active: z.boolean(),
  /** True when the hash fallback is embedding instead of the ONNX model. */
  embedder_is_fallback: z.boolean(),
  /** Why the fallback was taken, or why this process cannot embed. */
  embedder_warning: z.string().nullable(),
  generation: count,
  schema_version: z.number().int().positive(),
  /** Advances on every curation change; the UI refetches on it. */
  curation_seq: count,
  /** Turns hidden by curation. */
  hidden: count,
  /** Notes written by the curator. */
  notes: count,
});
export type Stats = z.infer<typeof statsSchema>;

/**
 * Which embedder a process asks for. A store records its own embedder and is
 * followed whatever this says: the choice seeds a fresh store, or forces a
 * switch under `ZEROMEM_ALLOW_EMBEDDER_SWITCH`.
 */
export const embedderChoiceSchema = z.enum(['auto', 'onnx', 'hash', 'openai', 'none']);
export type EmbedderChoice = z.infer<typeof embedderChoiceSchema>;

/** An OpenAI-compatible `/v1/embeddings` endpoint. */
export const remoteEmbedderSpecSchema = z.object({
  kind: z.literal('openai'),
  /** Base URL up to `/v1`, e.g. `http://npu-box:8080/v1`. */
  url: z.string().trim().url(),
  model: z.string().trim().min(1),
  /** Vector length; learned from the first response when null. */
  dim: z.number().int().positive().nullable().optional(),
  /** Accepted on the way in; never returned. */
  api_key: z.string().nullable().optional(),
  query_prefix: z.string().default(''),
  document_prefix: z.string().default(''),
  timeout_ms: z.number().int().positive().default(5000),
  max_chars: z.number().int().positive().default(8000),
});
export type RemoteEmbedderSpec = z.infer<typeof remoteEmbedderSpecSchema>;

/** What the store records about its embedder, and what the UI sends to change it. */
export const embedderSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('onnx') }),
  z.object({ kind: z.literal('hash') }),
  remoteEmbedderSpecSchema,
]);
export type EmbedderSpec = z.infer<typeof embedderSpecSchema>;

export const apiKeySourceSchema = z.enum(['env', 'store', 'none']);
export type ApiKeySource = z.infer<typeof apiKeySourceSchema>;

/** `GET /api/settings/embedder` and the engine's own report. */
export const embedderSettingsSchema = z.object({
  /** The recorded spec with its key redacted; null on a store no process has seeded. */
  spec: embedderSpecSchema.nullable(),
  embedder: z.string().nullable(),
  embedder_kind: embedderKindSchema.nullable(),
  embedder_dim: z.number().int().positive().nullable(),
  /** Whether this process can embed with the store's embedder. */
  active: z.boolean(),
  embedder_is_fallback: z.boolean(),
  embedder_warning: z.string().nullable(),
  embedding_backlog: count,
  /** Where the bearer token for a remote endpoint comes from; `env` overrides `store`. */
  api_key_source: apiKeySourceSchema,
  /** Whether this build can load the ONNX model at all. */
  onnx_available: z.boolean(),
});
export type EmbedderSettings = z.infer<typeof embedderSettingsSchema>;

/** `POST /api/settings/embedder/test` — one text through a freshly built embedder. */
export const embedderProbeSchema = z.object({
  embedder: z.string(),
  embedder_kind: embedderKindSchema,
  embedder_dim: z.number().int().positive(),
  latency_ms: count,
});
export type EmbedderProbe = z.infer<typeof embedderProbeSchema>;

/** `PUT /api/settings/embedder` — the switch as applied. */
export const embedderSwitchSchema = z.object({
  embedder: z.string(),
  embedder_dim: z.number().int().positive(),
  /** Turns waiting to be re-embedded; drained by the worker. */
  turns_to_embed: count,
  /** True when the spec named the same model and the vectors were kept. */
  vectors_kept: z.boolean(),
});
export type EmbedderSwitch = z.infer<typeof embedderSwitchSchema>;

/** `POST /api/settings/clear` — what was removed, and what is left to re-embed. */
export const clearReportSchema = z.object({
  turns_removed: count,
  sessions_removed: count,
  vectors_removed: count,
  /** Every turn after clearing the vectors; none after clearing the memory. */
  turns_to_embed: count,
});
export type ClearReport = z.infer<typeof clearReportSchema>;

export const sessionSummarySchema = z.object({
  session_id: z.string(),
  turns: z.number().int().nonnegative(),
  first_ts: z.number().int(),
  last_ts: z.number().int(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** `note` is a curator's consolidated note; an ordinary turn leaves the field out. */
export const turnKindSchema = z.enum(['turn', 'note']);
export type TurnKind = z.infer<typeof turnKindSchema>;

export const storedTurnSchema = z.object({
  id: z.number().int(),
  uuid: z.string(),
  session_id: z.string(),
  speaker: z.string(),
  text: z.string(),
  ts: z.number().int(),
  kind: turnKindSchema.optional(),
});
export type StoredTurn = z.infer<typeof storedTurnSchema>;

/** Most turns one window may carry; the engine clamps to the same number. */
export const SESSION_WINDOW_MAX_TURNS = 200;

/**
 * What a client may ask of a session read: a whole session (`session_id`, paged
 * by `limit`/`offset`), or a window centred on one turn (`around_turn`, with
 * `before`/`after` turns either side). One or the other is required.
 */
export const sessionWindowOptionsSchema = z.object({
  session_id: z.string().min(1).optional(),
  /** Centre the window on this turn id; its session is used when `session_id` is absent. */
  around_turn: z.number().int().optional(),
  before: z.number().int().min(0).max(SESSION_WINDOW_MAX_TURNS).optional(),
  after: z.number().int().min(0).max(SESSION_WINDOW_MAX_TURNS).optional(),
  limit: z.number().int().min(1).max(SESSION_WINDOW_MAX_TURNS).optional(),
  offset: z.number().int().min(0).optional(),
});
export type SessionWindowOptions = z.infer<typeof sessionWindowOptionsSchema>;

/** One conversation in order, capped and reporting `total`/`truncated` like every other capped read. */
export const sessionWindowSchema = z.object({
  session_id: z.string(),
  turns: z.array(storedTurnSchema),
  /** The anchor, when `around_turn` asked for one. */
  around_turn: z.number().int().optional(),
  /** Turns in the whole session. */
  total: count,
  /** Where the first returned turn sits in the session, in time order. */
  offset: count,
  /** The answer is not the whole session; page on with `offset`. */
  truncated: z.boolean(),
});
export type SessionWindow = z.infer<typeof sessionWindowSchema>;

/** What curation says about one turn; every field is left out when empty. */
export const turnCurationSchema = z.object({
  hidden: z.boolean().optional(),
  /** The newer turn that restates this one. */
  superseded_by: z.number().int().optional(),
  /** Turns this one supersedes. */
  supersedes: z.array(z.number().int()).optional(),
  /** Notes that stand for this turn. */
  covered_by: z.array(z.number().int()).optional(),
  /** For a note, the turns it stands for. */
  sources: z.array(z.number().int()).optional(),
});
export type TurnCuration = z.infer<typeof turnCurationSchema>;

export const ingestOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('indexed'), id: z.number().int() }),
  z.object({ outcome: z.literal('duplicate'), id: z.number().int() }),
]);
export type IngestOutcome = z.infer<typeof ingestOutcomeSchema>;

export const ingestReportSchema = z.object({
  indexed: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
export type IngestReport = z.infer<typeof ingestReportSchema>;

/** A turn as a client submits it. */
export const turnInputSchema = z.object({
  session_id: z.string().min(1),
  speaker: z.string().min(1),
  text: z.string().min(1),
  ts: z.number().int().optional(),
  uuid: z.string().min(1).optional(),
});
export type TurnInput = z.infer<typeof turnInputSchema>;

// --- recall -----------------------------------------------------------------

export const viewKindSchema = z.enum(['lexical', 'entity', 'dense', 'recent']);
export type ViewKind = z.infer<typeof viewKindSchema>;

export const roleSchema = z.enum(['primary', 'supporting']);
export type Role = z.infer<typeof roleSchema>;

export const detailSchema = z.enum(['compact', 'full']);
export type Detail = z.infer<typeof detailSchema>;

/** Most neighbours recall will attach per side, per hit; the engine clamps to the same number. */
export const MAX_CONTEXT = 10;

/** What a client may ask of recall; the same shape the CLI's `zm query` accepts. */
export const recallOptionsSchema = z.object({
  top_k: z.number().int().min(1).max(50).optional(),
  exclude_session: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  since: z.number().int().optional(),
  until: z.number().int().optional(),
  detail: detailSchema.optional(),
  /** Include turns curation hid; they come back flagged `hidden`. */
  include_hidden: z.boolean().optional(),
  /**
   * Attach this many same-session turns either side of each hit, as
   * `before`/`after`. They are context, never candidates: the ranked evidence
   * list is identical with and without them.
   */
  context: z.number().int().min(0).max(MAX_CONTEXT).optional(),
});
export type RecallOptions = z.infer<typeof recallOptionsSchema>;

export const profileSchema = z.object({
  text: z.string(),
  tokens: z.array(z.string()),
  entities: z.array(z.string()),
  temporal: z.boolean(),
  question: z.boolean(),
});
export type Profile = z.infer<typeof profileSchema>;

export const viewSummarySchema = z.object({
  view: viewKindSchema,
  weight: z.number(),
  candidates: count,
});
export type ViewSummary = z.infer<typeof viewSummarySchema>;

export const routeSchema = z.object({
  profile: profileSchema,
  views: z.array(viewSummarySchema),
});
export type Route = z.infer<typeof routeSchema>;

export const evidenceSchema = z.object({
  turn: storedTurnSchema,
  score: z.number(),
  confidence: z.number(),
  role: roleSchema,
  sources: z.array(viewKindSchema).optional(),
  entities: z.array(z.string()).optional(),
  /** The newer turn that restates this one; its score was halved. */
  superseded_by: z.number().int().optional(),
  /** Hidden by curation; only with `include_hidden`. */
  hidden: z.boolean().optional(),
  /** For a note, the source turns collapsed under it. */
  covers: z.array(z.number().int()).optional(),
  /** Same-session turns just before this one, oldest first; only under `context`. */
  before: z.array(storedTurnSchema).optional(),
  /** Same-session turns just after this one, oldest first; only under `context`. */
  after: z.array(storedTurnSchema).optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const queryResultSchema = z.object({
  query: z.string(),
  route: routeSchema.optional(),
  evidence: z.array(evidenceSchema),
  considered: count,
  took_ms: count,
});
export type QueryResult = z.infer<typeof queryResultSchema>;

export const viewTraceSchema = z.object({
  view: viewKindSchema,
  weight: z.number(),
  candidates: z.array(z.tuple([z.number().int(), z.number()])),
});
export type ViewTrace = z.infer<typeof viewTraceSchema>;

export const fusedSchema = z.object({
  id: z.number().int(),
  score: z.number(),
  sources: z.array(viewKindSchema),
  ts: z.number().int(),
  uuid: z.string(),
});
export type Fused = z.infer<typeof fusedSchema>;

export const droppedSchema = z.object({
  id: z.number().int(),
  score: z.number(),
  reason: z.string(),
});
export type Dropped = z.infer<typeof droppedSchema>;

/** Every stage of one recall, for the trace view. */
export const queryTraceSchema = z.object({
  query: z.string(),
  profile: profileSchema,
  views: z.array(viewTraceSchema),
  fused: z.array(fusedSchema),
  dropped: z.array(droppedSchema),
  evidence: z.array(evidenceSchema),
  took_ms: count,
});
export type QueryTrace = z.infer<typeof queryTraceSchema>;
