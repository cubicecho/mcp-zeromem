import { type BriefResponse, briefQuerySchema } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';

export interface BriefDeps {
  engine: ZeroMemEngine;
  config: Config;
}

/**
 * `GET /api/brief` — the standing brief of a scope, for the admin UI and for
 * a host that loads it over HTTP at session start. With no `scope` it is the
 * server's own (`ZEROMEM_SCOPE`); `?scope=` with an empty value is the
 * unscoped store's. Writing one is the curator's job, over MCP.
 */
export function createBriefRouter(deps: BriefDeps): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const scope = briefQuerySchema.parse(req.query).scope ?? deps.config.scope ?? '';
      const body: BriefResponse = { scope, brief: await deps.engine.brief(scope) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
