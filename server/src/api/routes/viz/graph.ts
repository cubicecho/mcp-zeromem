import { graphOptionsSchema } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { ZeroMemEngine } from '../../../engine/index.ts';

/** `GET /api/viz/graph?limit&min_weight&focus&hops&kind` */
export function createGraphRouter(engine: ZeroMemEngine): Router {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      res.json(await engine.graphSnapshot(graphOptionsSchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
