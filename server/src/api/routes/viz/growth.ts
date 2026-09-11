import { growthOptionsSchema } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { ZeroMemEngine } from '../../../engine/index.ts';

/** `GET /api/viz/growth?since&until` */
export function createGrowthRouter(engine: ZeroMemEngine): Router {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      res.json(await engine.growth(growthOptionsSchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
