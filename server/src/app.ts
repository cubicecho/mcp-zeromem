import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { errorMiddleware } from './api/error-middleware.ts';
import { createCurationRouter } from './api/routes/curation.ts';
import { createIngestRouter } from './api/routes/ingest.ts';
import { createRecallRouter } from './api/routes/recall.ts';
import { createSessionsRouter } from './api/routes/sessions.ts';
import { createSettingsRouter } from './api/routes/settings.ts';
import { createStatusRouter } from './api/routes/status.ts';
import { createVizRouter } from './api/routes/viz/index.ts';
import { createAuthMiddleware, createMcpAuthMiddleware } from './auth.ts';
import type { Config } from './config.ts';
import { CuratorSettingsStore } from './curator.ts';
import type { EmbedWorker } from './engine/embed-worker.ts';
import type { ZeroMemEngine } from './engine/index.ts';
import { createMcpRouter } from './gateway/routes.ts';

export interface AppDeps {
  engine: ZeroMemEngine;
  config: Config;
  /** The backlog drainer, woken after an embedder switch; the HTTP server has one. */
  worker?: EmbedWorker;
  /** Override for tests; defaults to <repo>/app/dist. */
  appDistDir?: string;
  /** Override for tests; defaults to <repo>/docs/eval/history.jsonl. */
  evalHistoryPath?: string;
  /** Override for tests; built from the engine and MCP_ZEROMEM_CURATOR_TOKEN by default. */
  curatorSettings?: CuratorSettingsStore;
}

/** Build the Express app (separate from listen() so tests can drive it with supertest). */
export function buildApp(deps: AppDeps): express.Express {
  const { engine, config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16mb' }));

  // `loadConfig` has already refused to start without a token unless SECURE_LOCAL_NET
  // was set, so a null token here means auth is deliberately off.
  const authConfig = () => ({ enabled: config.authToken !== null, token: config.authToken });
  const auth = createAuthMiddleware(authConfig);
  const curatorSettings = deps.curatorSettings ?? new CuratorSettingsStore(engine, config.curatorToken);
  // /mcp also accepts the curator token, which grants the curator scope; /api never does.
  const mcpAuth = createMcpAuthMiddleware(authConfig, () => curatorSettings.token());

  app.use('/api/status', createStatusRouter({ engine, config }));
  app.use('/api/sessions', auth, createSessionsRouter({ engine, config }));
  app.use('/api/recall', auth, createRecallRouter(engine));
  app.use('/api/ingest', auth, createIngestRouter({ engine, config }));
  app.use('/api/viz', auth, createVizRouter({ engine, evalHistoryPath: deps.evalHistoryPath }));
  app.use('/api/curation', auth, createCurationRouter({ engine, config }));
  app.use('/api/settings', auth, createSettingsRouter({ engine, config, worker: deps.worker, curatorSettings }));
  app.use('/mcp', mcpAuth, createMcpRouter({ engine, config, curatorSettings }));

  // Production: serve the built web UI with an SPA fallback for non-API GETs.
  const appDist = deps.appDistDir ?? path.resolve(import.meta.dirname, '../../app/dist');
  if (existsSync(appDist)) {
    app.use(express.static(appDist));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/mcp')) {
        res.sendFile(path.join(appDist, 'index.html'));
        return;
      }
      next();
    });
  }

  app.use(errorMiddleware);
  return app;
}
