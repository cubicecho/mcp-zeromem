import { recallRequestSchema } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { ZeroMemEngine } from '../../engine/index.ts';

/** `POST /api/recall` and `POST /api/recall/trace` — the playground's two calls. */
export function createRecallRouter(engine: ZeroMemEngine): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const { query, ...options } = recallRequestSchema.parse(req.body);
      res.json(await engine.query(query, options));
    } catch (err) {
      next(err);
    }
  });

  router.post('/trace', async (req, res, next) => {
    try {
      const { query, ...options } = recallRequestSchema.parse(req.body);
      res.json(await engine.queryTrace(query, options));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
