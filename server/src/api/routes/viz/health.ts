import type { Health } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { ZeroMemEngine } from '../../../engine/index.ts';

/** `GET /api/viz/health` — recall latency and ingest counters for this process. */
export function createHealthRouter(engine: ZeroMemEngine): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    const body: Health = engine.metrics.snapshot();
    res.json(body);
  });
  return router;
}
