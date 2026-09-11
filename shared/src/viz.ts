import { z } from 'zod';
import { storedTurnSchema } from './memory.ts';

/**
 * Shapes behind the visualisations: the entity graph, the temporal hierarchy,
 * a session's turns with their entity spans, the 2-D embedding projection and
 * growth per day. Serde output of `zeromem-core::viz`, snake_case on the
 * wire like everything else the engine returns. Every snapshot is capped on
 * the Rust side; the caps are documented on the option schemas here.
 */

const count = z.number().int().nonnegative();
const ts = z.number().int();

export const entityKindSchema = z.enum(['name', 'date', 'quantity']);
export type EntityKind = z.infer<typeof entityKindSchema>;

// --- entity graph -----------------------------------------------------------

export const graphOptionsSchema = z.object({
  /** At most this many nodes; default 200, capped at 2000. */
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  /** Drop edges seen in fewer turns than this; default 1. */
  min_weight: z.coerce.number().int().min(1).optional(),
  /** Start from this entity and expand `hops` steps instead of taking the most-mentioned entities. */
  focus: z.string().trim().min(1).optional(),
  /** Default 1, capped at 3. */
  hops: z.coerce.number().int().min(0).max(3).optional(),
  /** Only entities of this kind. */
  kind: entityKindSchema.optional(),
});
export type GraphOptions = z.infer<typeof graphOptionsSchema>;

export const graphNodeSchema = z.object({
  entity: z.string(),
  kind: entityKindSchema,
  turns: count,
  /** Edges touching this entity in the whole graph, not only the snapshot. */
  degree: count,
  first_ts: ts,
  last_ts: ts,
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.object({ a: z.string(), b: z.string(), turns: count });
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphSnapshotSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  total_entities: count,
  total_edges: count,
  /** The node cap cut the selection short. */
  truncated: z.boolean(),
  generation: count,
});
export type GraphSnapshot = z.infer<typeof graphSnapshotSchema>;

// --- temporal hierarchy -----------------------------------------------------

export const hierarchyOptionsSchema = z.object({
  /** Sessions per page; default 50, capped at 500. */
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** Only sessions active at or after this (ms). */
  since: z.coerce.number().int().optional(),
  /** Only sessions active at or before this (ms). */
  until: z.coerce.number().int().optional(),
  /** Just this one session. */
  session: z.string().trim().min(1).optional(),
});
export type HierarchyOptions = z.infer<typeof hierarchyOptionsSchema>;

export const hierarchySegmentSchema = z.object({
  start_ts: ts,
  end_ts: ts,
  first_turn_id: z.number().int(),
  last_turn_id: z.number().int(),
  turns: count,
  entities: z.array(z.string()),
});
export type HierarchySegment = z.infer<typeof hierarchySegmentSchema>;

export const hierarchySessionSchema = z.object({
  session_id: z.string(),
  turns: count,
  first_ts: ts,
  last_ts: ts,
  windows: z.array(hierarchySegmentSchema),
  episodes: z.array(hierarchySegmentSchema),
});
export type HierarchySession = z.infer<typeof hierarchySessionSchema>;

export const hierarchySnapshotSchema = z.object({
  sessions: z.array(hierarchySessionSchema),
  /** Sessions matching the range, before paging. */
  total_sessions: count,
  generation: count,
});
export type HierarchySnapshot = z.infer<typeof hierarchySnapshotSchema>;

// --- a session's turns with entity spans -----------------------------------

export const mentionSchema = z.object({
  /** The normalised entity key, as it appears in the graph. */
  key: z.string(),
  kind: entityKindSchema,
  /** The text as written. */
  surface: z.string(),
  /** Byte offsets into the turn text, half-open. */
  start: count,
  end: count,
});
export type Mention = z.infer<typeof mentionSchema>;

export const turnWithEntitiesSchema = storedTurnSchema.extend({ entities: z.array(mentionSchema) });
export type TurnWithEntities = z.infer<typeof turnWithEntitiesSchema>;

// --- embedding projection ---------------------------------------------------

export const projectionOptionsSchema = z.object({
  /** At most this many points; default 2000, capped at 10000. Every n-th turn, so stable for a store. */
  limit: z.coerce.number().int().min(2).max(10_000).optional(),
  /** Only this session's turns. */
  session: z.string().trim().min(1).optional(),
  /** Drop this text onto the plane and mark its nearest turns. */
  query: z.string().trim().min(1).optional(),
});
export type ProjectionOptions = z.infer<typeof projectionOptionsSchema>;

export const point2DSchema = z.object({
  turn_id: z.number().int(),
  session_id: z.string(),
  speaker: z.string(),
  ts,
  /** The turn text, cut to a hover-sized excerpt. */
  text: z.string(),
  x: z.number(),
  y: z.number(),
});
export type Point2D = z.infer<typeof point2DSchema>;

export const basisSchema = z.object({
  mean: z.array(z.number()),
  axes: z.tuple([z.array(z.number()), z.array(z.number())]),
  /** Fraction of the sample's variance each axis carries. */
  variance_explained: z.tuple([z.number(), z.number()]),
});
export type Basis = z.infer<typeof basisSchema>;

export const queryPointSchema = z.object({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  /** Turn ids of the nearest points in the full vector space, nearest first. */
  neighbours: z.array(z.number().int()),
});
export type QueryPoint = z.infer<typeof queryPointSchema>;

export const projectionSchema = z.object({
  points: z.array(point2DSchema),
  basis: basisSchema,
  query: queryPointSchema.nullable(),
  embedder: z.string(),
  /** Vectors in the population the sample was drawn from. */
  total: count,
  generation: count,
});
export type Projection = z.infer<typeof projectionSchema>;

// --- growth per day ---------------------------------------------------------

export const growthOptionsSchema = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
});
export type GrowthOptions = z.infer<typeof growthOptionsSchema>;

export const growthDaySchema = z.object({
  /** `YYYY-MM-DD`, UTC. */
  day: z.string(),
  turns: count,
  sessions: count,
  cumulative_turns: count,
});
export type GrowthDay = z.infer<typeof growthDaySchema>;

export const growthSchema = z.object({ days: z.array(growthDaySchema), generation: count });
export type Growth = z.infer<typeof growthSchema>;

// --- health series (server process counters) --------------------------------

const latency = z.number().nonnegative().nullable();

export const healthMinuteSchema = z.object({
  /** Epoch ms at the start of the minute. */
  minute: z.number().int(),
  recalls: count,
  ingested: count,
  errors: count,
  p50_ms: latency,
  p95_ms: latency,
});
export type HealthMinute = z.infer<typeof healthMinuteSchema>;

/** `GET /api/viz/health` — what this server process has seen since it started. */
export const healthSchema = z.object({
  started_at: z.number().int(),
  uptime_seconds: count,
  /** Opening the store and warming it up, ms. */
  open_ms: z.number().nonnegative(),
  recall: z.object({ count, errors: count, p50_ms: latency, p95_ms: latency, max_ms: latency }),
  ingest: z.object({ calls: count, turns: count }),
  /** The last hour, one entry per minute, oldest first. */
  series: z.array(healthMinuteSchema),
});
export type Health = z.infer<typeof healthSchema>;

// --- eval history (committed harness results) ---------------------------------

/** One harness run over one profile with one embedder, as recorded by `scripts/record-eval.sh`. */
export const evalRunSchema = z.object({
  recorded_at: z.string(),
  commit: z.string(),
  /** Free text for the run: a branch, a PR, "before fusion change". */
  label: z.string().optional(),
  profile: z.string(),
  embedder: z.string(),
  k: z.number().int().positive(),
  queries: count,
  recall_at_k: z.number().min(0).max(1),
  mrr: z.number().min(0).max(1),
  ndcg_at_k: z.number().min(0).max(1),
  missed: count,
});
export type EvalRun = z.infer<typeof evalRunSchema>;

/** `GET /api/viz/eval` */
export const evalHistorySchema = z.object({
  /** Where the runs were read from, for the page to say so. */
  source: z.string(),
  runs: z.array(evalRunSchema),
});
export type EvalHistory = z.infer<typeof evalHistorySchema>;
