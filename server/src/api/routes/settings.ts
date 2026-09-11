import {
  type EmbedderProbe,
  type EmbedderSettings,
  type EmbedderSwitch,
  embedderChangeRequestSchema,
} from '@mcp-zeromem/shared';
import { Router } from 'express';
import type { Config } from '../../config.ts';
import type { EmbedWorker } from '../../engine/embed-worker.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { errorChainMessage, HttpError } from '../../errors.ts';

export interface SettingsDeps {
  engine: ZeroMemEngine;
  config: Config;
  /** Woken after a switch so the re-embed starts at once; absent in a stdio process. */
  worker?: EmbedWorker;
}

/**
 * `/api/settings` — the store's embedder: what it is, whether a candidate
 * works, and changing it. A change is persisted in the store, so the stdio
 * server and the host's `zm` hooks follow it on their next read.
 */
export function createSettingsRouter(deps: SettingsDeps): Router {
  const router = Router();

  router.get('/embedder', async (_req, res, next) => {
    try {
      const body: EmbedderSettings = await deps.engine.embedderSettings();
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.post('/embedder/test', async (req, res, next) => {
    try {
      const { spec, keep_stored_key } = embedderChangeRequestSchema.parse(req.body);
      let body: EmbedderProbe;
      try {
        body = await deps.engine.probeEmbedder(spec, keep_stored_key);
      } catch (err) {
        throw new HttpError(502, 'The embedder could not be used', errorChainMessage(err), { cause: err });
      }
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.put('/embedder', async (req, res, next) => {
    try {
      if (deps.config.readOnly) {
        throw new HttpError(403, 'This server is read-only (ZEROMEM_READ_ONLY)');
      }
      const { spec, keep_stored_key } = embedderChangeRequestSchema.parse(req.body);
      let body: EmbedderSwitch;
      try {
        body = await deps.engine.setEmbedder(spec, keep_stored_key);
      } catch (err) {
        throw new HttpError(502, 'The embedder could not be used; the store is unchanged', errorChainMessage(err), {
          cause: err,
        });
      }
      deps.worker?.kick();
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
