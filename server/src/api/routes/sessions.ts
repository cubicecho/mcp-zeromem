import {
  type ForgetResponse,
  pageQuerySchema,
  type SessionsResponse,
  type SessionTurnsResponse,
} from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { HttpError } from '../../errors.ts';

export interface SessionsDeps {
  engine: ZeroMemEngine;
  config: Config;
}

/** `/api/sessions` — list, read one session's turns, forget one. */
export function createSessionsRouter(deps: SessionsDeps): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const page = pageQuerySchema.parse(req.query);
      const body: SessionsResponse = { sessions: await deps.engine.listSessions(page) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/turns', async (req, res, next) => {
    try {
      const page = pageQuerySchema.parse(req.query);
      const session_id = String(req.params.id);
      const turns = await deps.engine.sessionTurns(session_id, page);
      if (turns.length === 0 && (page.offset ?? 0) === 0) {
        throw new HttpError(404, `No session "${session_id}"`);
      }
      const body: SessionTurnsResponse = { session_id, turns };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (deps.config.readOnly) {
        throw new HttpError(403, 'This server is read-only (ZEROMEM_READ_ONLY)');
      }
      const session_id = String(req.params.id);
      const removed = await deps.engine.deleteSession(session_id);
      if (removed === 0) {
        throw new HttpError(404, `No session "${session_id}"`);
      }
      const body: ForgetResponse = { session_id, removed };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
