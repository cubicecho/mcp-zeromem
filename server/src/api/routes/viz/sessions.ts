import { pageQuerySchema, type SessionTurnsWithEntitiesResponse } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { ZeroMemEngine } from '../../../engine/index.ts';
import { HttpError } from '../../../errors.ts';

/** `GET /api/viz/sessions/:id/turns?limit&offset` — turns with their entity spans. */
export function createSessionInspectorRouter(engine: ZeroMemEngine): Router {
  const router = Router();
  router.get('/:id/turns', async (req, res, next) => {
    try {
      const page = pageQuerySchema.parse(req.query);
      const session_id = String(req.params.id);
      const turns = await engine.sessionTurnsWithEntities(session_id, page);
      if (turns.length === 0 && (page.offset ?? 0) === 0) {
        throw new HttpError(404, `No session "${session_id}"`);
      }
      const body: SessionTurnsWithEntitiesResponse = { session_id, turns };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });
  return router;
}
