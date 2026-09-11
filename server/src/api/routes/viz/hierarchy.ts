import { hierarchyOptionsSchema } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { ZeroMemEngine } from '../../../engine/index.ts';

/** `GET /api/viz/hierarchy?limit&offset&since&until&session` */
export function createHierarchyRouter(engine: ZeroMemEngine): Router {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      res.json(await engine.hierarchy(hierarchyOptionsSchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
