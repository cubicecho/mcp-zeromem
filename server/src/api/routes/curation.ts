import {
  type CurationActions,
  type CurationAliases,
  type CurationRuns,
  curationActionsQuerySchema,
  pageQuerySchema,
  type UndoReport,
  undoRequestSchema,
} from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { errorMessage, HttpError } from '../../errors.ts';

export interface CurationDeps {
  engine: ZeroMemEngine;
  config: Config;
}

/** Who the action log records for an undo from the admin UI. */
const UI_ACTOR = 'ui';

/**
 * `/api/curation` — the curator's log for the admin UI: runs, their actions,
 * the live aliases and blocklist, and undo. Applying is the curator's job,
 * over MCP; a person here only reviews and reverts.
 */
export function createCurationRouter(deps: CurationDeps): Router {
  const router = Router();

  router.get('/runs', async (req, res, next) => {
    try {
      const page = pageQuerySchema.parse(req.query);
      const body: CurationRuns = await deps.engine.curationRuns(page);
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/actions', async (req, res, next) => {
    try {
      const { run_id, limit, offset } = curationActionsQuerySchema.parse(req.query);
      const body: CurationActions = await deps.engine.curationActions(run_id, { limit, offset });
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/aliases', async (_req, res, next) => {
    try {
      const body: CurationAliases = await deps.engine.curationAliases();
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.post('/undo', async (req, res, next) => {
    try {
      if (deps.config.readOnly) {
        throw new HttpError(403, 'This server is read-only (ZEROMEM_READ_ONLY)');
      }
      const target = undoRequestSchema.parse(req.body);
      let body: UndoReport;
      try {
        body = await deps.engine.curateUndo(target, UI_ACTOR);
      } catch (err) {
        // The engine's own refusals (already undone, no such action) are the caller's to fix.
        if (errorMessage(err).startsWith('curation:')) {
          throw new HttpError(400, 'The undo was refused', errorMessage(err), { cause: err });
        }
        throw err;
      }
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
