import { z } from 'zod';
import { pageQuerySchema } from './api.ts';
import { apiKeySourceSchema, storedTurnSchema, turnCurationSchema } from './memory.ts';
import { mentionSchema } from './viz.ts';

/**
 * Curation: reversible edits an agent (or a person) makes to what recall
 * sees. Nothing here deletes a turn: hide, supersede, alias, block and note
 * are recorded in an action log and every one can be undone.
 */

const count = z.number().int().nonnegative();
const turnId = z.number().int().nonnegative();
const turnIds = z.array(turnId).min(1).max(1000);

// --- settings -----------------------------------------------------------------

/** The curator settings as the engine stores them, token included. Server-side only. */
export const curatorConfigSchema = z.object({
  max_per_call: z.number().int().positive(),
  max_per_run: z.number().int().positive(),
  min_age_ms: count,
  token: z.string().nullable(),
  expose_to_all: z.boolean(),
});
export type CuratorConfig = z.infer<typeof curatorConfigSchema>;

/** `GET /api/settings/curator` — the settings with the token redacted. */
export const curatorSettingsSchema = z.object({
  /** Most actions one `zeromem_curate_apply` call may carry. */
  max_per_call: z.number().int().positive(),
  /** Most actions one run may apply in total. */
  max_per_run: z.number().int().positive(),
  /** Turns younger than this are never touched. */
  min_age_ms: count,
  /** Every MCP client gets the curator tools, not only the curator token. */
  expose_to_all: z.boolean(),
  token_set: z.boolean(),
  /** `env` (MCP_ZEROMEM_CURATOR_TOKEN) overrides `store`. */
  token_source: apiKeySourceSchema,
  /** When the newest run's last action was recorded; null before the first run. */
  last_run_at: z.number().int().nullable(),
  /** The turn id the next run's finders start after. */
  cursor: count,
});
export type CuratorSettings = z.infer<typeof curatorSettingsSchema>;

export const CURATOR_LIMITS = { maxPerCall: 1000, maxPerRun: 100_000, tokenMinLength: 16 } as const;

/** `PUT /api/settings/curator` — the whole settings object; `token` absent keeps the stored one. */
export const curatorSettingsUpdateSchema = z.object({
  max_per_call: z.number().int().min(1).max(CURATOR_LIMITS.maxPerCall),
  max_per_run: z.number().int().min(1).max(CURATOR_LIMITS.maxPerRun),
  min_age_ms: z.number().int().min(0),
  expose_to_all: z.boolean(),
  /** A new token, null to clear it, absent to keep it. */
  token: z.string().trim().min(CURATOR_LIMITS.tokenMinLength).nullable().optional(),
});
export type CuratorSettingsUpdate = z.infer<typeof curatorSettingsUpdateSchema>;

/** `POST /api/settings/curator/token` — a fresh token, shown once. */
export const curatorTokenResponseSchema = z.object({ token: z.string(), settings: curatorSettingsSchema });
export type CuratorTokenResponse = z.infer<typeof curatorTokenResponseSchema>;

// --- operations ---------------------------------------------------------------

const hideOp = z.object({
  op: z.literal('hide'),
  turn_ids: turnIds.describe('Turns to leave out of recall. They stay in the store and in session reads.'),
});
const unhideOp = z.object({ op: z.literal('unhide'), turn_ids: turnIds });
const supersedeOp = z.object({
  op: z.literal('supersede'),
  turn_ids: turnIds.describe('Older turns whose value the newer turn replaces.'),
  by: turnId.describe('The newer turn that states the current value.'),
});
const aliasOp = z.object({
  op: z.literal('alias'),
  alias: z.string().min(1).describe('The name as it is written, e.g. "Maya".'),
  canonical: z.string().min(1).describe('The name to fold it into, e.g. "Maya Okafor".'),
});
const unaliasOp = z.object({ op: z.literal('unalias'), alias: z.string().min(1) });
const blockOp = z.object({
  op: z.literal('block'),
  entity: z.string().min(1).describe('An entity that is not one (a common word the extractor picked up).'),
});
const unblockOp = z.object({ op: z.literal('unblock'), entity: z.string().min(1) });
const noteOp = z.object({
  op: z.literal('note'),
  session_id: z.string().min(1).describe('The session the note belongs to; usually the sources’ session.'),
  text: z.string().describe('The note: the lasting facts of the source turns, in plain sentences.'),
  source_ids: turnIds.describe('The turns the note stands for.'),
});
const runEndOp = z.object({
  op: z.literal('run_end'),
  summary: z.string().default('').describe('What the run did, in a sentence or two.'),
  cursor: turnId
    .nullable()
    .optional()
    .describe('Where the next run starts; defaults to the newest turn old enough to curate.'),
});

/** One reversible edit, as the finders suggest it. */
export const curationOpSchema = z.discriminatedUnion('op', [
  hideOp,
  unhideOp,
  supersedeOp,
  aliasOp,
  unaliasOp,
  blockOp,
  unblockOp,
  noteOp,
  runEndOp,
]);
export type CurationOp = z.infer<typeof curationOpSchema>;

const reason = z.string().max(2000).optional().describe('Why. Required for every op but run_end.');
const withReason = <T extends z.ZodRawShape>(op: z.ZodObject<T>) => op.extend({ reason });

/** One edit with its reason, as `zeromem_curate_apply` takes it. */
export const curationActionSchema = z.discriminatedUnion('op', [
  withReason(hideOp),
  withReason(unhideOp),
  withReason(supersedeOp),
  withReason(aliasOp),
  withReason(unaliasOp),
  withReason(blockOp),
  withReason(unblockOp),
  withReason(noteOp),
  withReason(runEndOp),
]);
export type CurationAction = z.infer<typeof curationActionSchema>;

export const actionResultSchema = z.object({
  index: count,
  op: z.string(),
  ok: z.boolean(),
  action_id: z.number().int().optional(),
  note_id: z.number().int().optional(),
  error: z.string().optional(),
});
export type ActionResult = z.infer<typeof actionResultSchema>;

export const applyReportSchema = z.object({
  run_id: z.string(),
  dry_run: z.boolean(),
  results: z.array(actionResultSchema),
  applied: count,
  rejected: count,
});
export type ApplyReport = z.infer<typeof applyReportSchema>;

export const undoReportSchema = z.object({ undone: z.array(z.number().int()) });
export type UndoReport = z.infer<typeof undoReportSchema>;

/** `POST /api/curation/undo` — one action or a whole run. */
export const undoRequestSchema = z
  .object({ action_id: z.number().int().positive().optional(), run_id: z.string().min(1).optional() })
  .refine((r) => (r.action_id === undefined) !== (r.run_id === undefined), {
    message: 'Give exactly one of action_id or run_id',
  });
export type UndoRequest = z.infer<typeof undoRequestSchema>;

// --- reads --------------------------------------------------------------------

export const curatedTurnSchema = storedTurnSchema
  .merge(turnCurationSchema)
  .extend({ entities: z.array(mentionSchema) });
export type CuratedTurn = z.infer<typeof curatedTurnSchema>;

export const runSummarySchema = z.object({
  run_id: z.string(),
  actor: z.string(),
  started_at: z.number().int(),
  ended_at: z.number().int(),
  /** Actions in the run, run_end included. */
  actions: count,
  undone: count,
  /** Live (not undone) actions per op. */
  ops: z.record(z.string(), count),
  summary: z.string().nullable(),
  /** Whether a live run_end closed it. */
  finished: z.boolean(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const curationRunsSchema = z.object({
  runs: z.array(runSummarySchema),
  total: count,
  cursor: count,
  curation_seq: count,
});
export type CurationRuns = z.infer<typeof curationRunsSchema>;

export const targetTurnSchema = z.object({
  uuid: z.string(),
  /** Null once the turn is gone. */
  id: z.number().int().nullable(),
  session_id: z.string().nullable(),
  text: z.string().nullable(),
});
export type TargetTurn = z.infer<typeof targetTurnSchema>;

export const actionRowSchema = z.object({
  id: z.number().int(),
  run_id: z.string(),
  actor: z.string(),
  ts: z.number().int(),
  op: z.string(),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string(),
  undone_at: z.number().int().nullable(),
  undone_by: z.string().nullable(),
  targets: z.array(targetTurnSchema),
});
export type ActionRow = z.infer<typeof actionRowSchema>;

export const curationActionsSchema = z.object({ actions: z.array(actionRowSchema), total: count });
export type CurationActions = z.infer<typeof curationActionsSchema>;

export const aliasEntrySchema = z.object({
  alias: z.string(),
  canonical: z.string(),
  action_id: z.number().int().nullable(),
});
export type AliasEntry = z.infer<typeof aliasEntrySchema>;

export const blockEntrySchema = z.object({ entity: z.string(), action_id: z.number().int().nullable() });
export type BlockEntry = z.infer<typeof blockEntrySchema>;

export const curationAliasesSchema = z.object({
  aliases: z.array(aliasEntrySchema),
  blocklist: z.array(blockEntrySchema),
});
export type CurationAliases = z.infer<typeof curationAliasesSchema>;

// --- candidates -----------------------------------------------------------------

export const candidateKindSchema = z.enum(['duplicates', 'noise', 'aliases', 'supersession', 'consolidation']);
export type CandidateKind = z.infer<typeof candidateKindSchema>;

export const candidateTurnSchema = z.object({
  id: z.number().int(),
  session_id: z.string(),
  speaker: z.string(),
  ts: z.number().int(),
  /** Clipped; zeromem_curate_read has the rest. */
  text: z.string(),
});
export type CandidateTurn = z.infer<typeof candidateTurnSchema>;

export const candidateSchema = z.object({
  kind: candidateKindSchema,
  /** How sure the finder is, in [0, 1]. Not a verdict. */
  score: z.number(),
  turns: z.array(candidateTurnSchema),
  entities: z.array(z.string()).optional(),
  reason: z.string(),
  /** What applying it would look like; a note's text is left for the curator to write. */
  suggested: curationOpSchema,
});
export type Candidate = z.infer<typeof candidateSchema>;

export const candidatePageSchema = z.object({
  kind: candidateKindSchema,
  since_turn_id: count,
  candidates: z.array(candidateSchema),
  /** Pass as since_turn_id to continue. */
  scanned_through: count,
  more: z.boolean(),
});
export type CandidatePage = z.infer<typeof candidatePageSchema>;

// --- REST -----------------------------------------------------------------------

/** `GET /api/curation/actions` */
export const curationActionsQuerySchema = pageQuerySchema.extend({ run_id: z.string().min(1).optional() });
export type CurationActionsQuery = z.infer<typeof curationActionsQuerySchema>;
