import type { ServerStatus } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { SERVER_VERSION } from '../../version.ts';

export interface StatusDeps {
  engine: ZeroMemEngine;
  config: Config;
}

/**
 * `GET /api/status` — liveness for the Docker healthcheck and the UI's overview.
 *
 * Mounted ahead of the auth middleware on purpose: a healthcheck cannot carry
 * a token, and nothing here is secret — counts, not content.
 */
export function createStatusRouter(deps: StatusDeps): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/', async (_req, res, next) => {
    try {
      const status: ServerStatus = {
        name: 'mcp-zeromem',
        version: SERVER_VERSION,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        authEnabled: deps.config.authToken !== null,
        readOnly: deps.config.readOnly,
        engine: await deps.engine.stats(),
      };
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
