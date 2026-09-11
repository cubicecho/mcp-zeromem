import { projectionOptionsSchema } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { ZeroMemEngine } from '../../../engine/index.ts';

/** `GET /api/viz/projection?limit&session&query` */
export function createProjectionRouter(engine: ZeroMemEngine): Router {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      res.json(await engine.projection(projectionOptionsSchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
