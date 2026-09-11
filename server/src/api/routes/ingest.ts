import { ingestRequestSchema } from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { parseJsonl } from '../../engine/jsonl.ts';
import { HttpError } from '../../errors.ts';

export interface IngestDeps {
  engine: ZeroMemEngine;
  config: Config;
}

/** `POST /api/ingest` — turns as an array or as JSONL text. */
export function createIngestRouter(deps: IngestDeps): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      if (deps.config.readOnly) {
        throw new HttpError(403, 'This server is read-only (ZEROMEM_READ_ONLY)');
      }
      const body = ingestRequestSchema.parse(req.body);
      if ('turns' in body) {
        res.json(await deps.engine.ingestMany(body.turns));
        return;
      }
      const parsed = parseJsonl(body.jsonl);
      const report =
        parsed.turns.length > 0
          ? await deps.engine.ingestMany(parsed.turns)
          : { indexed: 0, duplicates: 0, rejected: 0 };
      res.json({
        ...report,
        rejected: report.rejected + parsed.rejected.length,
        rejected_lines: parsed.rejected.slice(0, 20),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
