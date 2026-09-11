import { z } from 'zod';
import {
  embedderSpecSchema,
  ingestReportSchema,
  queryResultSchema,
  queryTraceSchema,
  recallOptionsSchema,
  sessionSummarySchema,
  statsSchema,
  storedTurnSchema,
  turnInputSchema,
} from './memory.ts';
import { turnWithEntitiesSchema } from './viz.ts';

/** Every non-2xx API response carries this envelope. */
export interface ApiError {
  error: string;
  detail?: string;
}

/** `GET /api/status` — unauthenticated liveness plus the numbers an operator wants first. */
export const serverStatusSchema = z.object({
  name: z.literal('mcp-zeromem'),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  authEnabled: z.boolean(),
  readOnly: z.boolean(),
  engine: statsSchema,
});
export type ServerStatus = z.infer<typeof serverStatusSchema>;

/** Pagination, shared by the session list and a session's turns. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** `GET /api/sessions` */
export const sessionsResponseSchema = z.object({ sessions: z.array(sessionSummarySchema) });
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

/** `GET /api/sessions/:id/turns` */
export const sessionTurnsResponseSchema = z.object({ session_id: z.string(), turns: z.array(storedTurnSchema) });
export type SessionTurnsResponse = z.infer<typeof sessionTurnsResponseSchema>;

/** `DELETE /api/sessions/:id` */
export const forgetResponseSchema = z.object({ session_id: z.string(), removed: z.number().int().nonnegative() });
export type ForgetResponse = z.infer<typeof forgetResponseSchema>;

/** `POST /api/recall` and `POST /api/recall/trace` */
export const recallRequestSchema = recallOptionsSchema.extend({ query: z.string().trim().min(1) });
export type RecallRequest = z.infer<typeof recallRequestSchema>;
export const recallResponseSchema = queryResultSchema;
export const recallTraceResponseSchema = queryTraceSchema;

/** `POST /api/ingest` — turns as an array, or as JSONL text (one turn per line). */
export const ingestRequestSchema = z.union([
  z.object({ turns: z.array(turnInputSchema).min(1) }),
  z.object({ jsonl: z.string().min(1) }),
]);
export type IngestRequest = z.infer<typeof ingestRequestSchema>;
export const ingestResponseSchema = ingestReportSchema;

/** `GET /api/viz/sessions/:id/turns` — the session inspector's read. */
export const sessionTurnsWithEntitiesResponseSchema = z.object({
  session_id: z.string(),
  turns: z.array(turnWithEntitiesSchema),
});
export type SessionTurnsWithEntitiesResponse = z.infer<typeof sessionTurnsWithEntitiesResponseSchema>;

/** `PUT /api/settings/embedder` and `POST /api/settings/embedder/test` — the spec to switch to or try. */
export const embedderChangeRequestSchema = z.object({
  spec: embedderSpecSchema,
  /**
   * Leave the key already stored for the endpoint in place when `spec` carries
   * none, so an edit to the URL or a prefix does not need the key typed again.
   */
  keep_stored_key: z.boolean().default(false),
});
export type EmbedderChangeRequest = z.infer<typeof embedderChangeRequestSchema>;
