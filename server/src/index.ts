import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { EmbedWorker } from './engine/embed-worker.ts';
import { ZeroMemEngine } from './engine/index.ts';
import { errorChainMessage } from './errors.ts';

async function main(): Promise<void> {
  const config = loadConfig(process.env, { transport: 'http' });
  const engine = ZeroMemEngine.open(config.dataDir, {
    embedder: config.embedder,
    allowEmbedderSwitch: config.allowEmbedderSwitch,
    remoteEmbedder: config.remoteEmbedder,
    embeddingApiKey: config.embeddingApiKey,
    followRemote: true,
  });
  // Warm up: the first stats() call pays for opening the store, and it is
  // better paid here than inside the first healthcheck.
  const stats = await engine.stats();
  // This process owns the backlog: turns written by hooks or during an
  // outage, and the whole corpus after a switch, get their vectors here.
  const worker = new EmbedWorker(engine);
  if (!config.readOnly) {
    worker.start();
  }

  const app = buildApp({ engine, config, worker });
  // Unset binds all interfaces (Docker/LAN); set HOST=127.0.0.1 to restrict to localhost.
  const host = process.env.HOST?.trim() || undefined;
  const onListen = () => {
    console.log(`mcp-zeromem listening on http://${host ?? 'localhost'}:${config.port} (store: ${config.dataDir})`);
    console.log(
      `Store: ${stats.turns} turns across ${stats.sessions} sessions${config.readOnly ? ' (read-only)' : ''}`,
    );
    if (stats.embedder_is_fallback) {
      console.warn(
        `Embedder: ${stats.embedder} (fallback) — ${stats.embedder_warning ?? 'the ONNX model did not load'}`,
      );
    } else if (stats.embedder && !stats.embedder_active) {
      console.warn(`Embedder: ${stats.embedder} (unavailable) — ${stats.embedder_warning ?? 'could not be opened'}`);
    } else {
      console.log(`Embedder: ${stats.embedder ?? 'none (dense recall disabled)'}`);
    }
    if (stats.embedding_backlog > 0) {
      console.log(`Embedding backlog: ${stats.embedding_backlog} turns without a vector`);
    }
    if (config.authToken) {
      console.log('Auth: bearer token from MCP_ZEROMEM_TOKEN');
    } else {
      console.log('Auth: disabled (SECURE_LOCAL_NET) — /mcp is open on this network');
    }
  };
  const httpServer = host ? app.listen(config.port, host, onListen) : app.listen(config.port, onListen);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    httpServer.close(() => {
      worker.stop().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(`Fatal startup error: ${errorChainMessage(err)}`);
  process.exit(1);
});
