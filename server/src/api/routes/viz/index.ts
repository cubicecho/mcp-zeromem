import { Router } from 'express';
import type { ZeroMemEngine } from '../../../engine/index.ts';
import { createEvalRouter } from './eval.ts';
import { createGraphRouter } from './graph.ts';
import { createGrowthRouter } from './growth.ts';
import { createHealthRouter } from './health.ts';
import { createHierarchyRouter } from './hierarchy.ts';
import { createProjectionRouter } from './projection.ts';
import { createSessionInspectorRouter } from './sessions.ts';

/**
 * `/api/viz` — the reads behind the visualisations, one router per view.
 * All are GET with query-string options, all read-only, and each is capped
 * by the engine so a large store never serialises whole into a tab. The
 * retrieval trace lives at `POST /api/recall/trace`, next to recall itself.
 */
export interface VizDeps {
  engine: ZeroMemEngine;
  /** Override for tests; defaults to the committed `docs/eval/history.jsonl`. */
  evalHistoryPath?: string;
}

export function createVizRouter({ engine, evalHistoryPath }: VizDeps): Router {
  const router = Router();
  router.use('/graph', createGraphRouter(engine));
  router.use('/hierarchy', createHierarchyRouter(engine));
  router.use('/sessions', createSessionInspectorRouter(engine));
  router.use('/projection', createProjectionRouter(engine));
  router.use('/growth', createGrowthRouter(engine));
  router.use('/health', createHealthRouter(engine));
  router.use('/eval', createEvalRouter(evalHistoryPath));
  return router;
}
