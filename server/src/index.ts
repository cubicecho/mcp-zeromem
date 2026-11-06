import { hostname } from 'node:os';
import { createAdvertiser } from '@cubicecho/mcp-discovery/mdns';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { DiscoverySettingsStore } from './discovery/settings.ts';
import { EmbedWorker } from './engine/embed-worker.ts';
import { ZeroMemEngine } from './engine/index.ts';
import { errorChainMessage, errorMessage } from './errors.ts';

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

  // Unset binds all interfaces (Docker/LAN); set HOST=127.0.0.1 to restrict to localhost.
  const host = process.env.HOST?.trim() || undefined;

  // The announcement is opt-in (Settings → Network discovery) and follows a change there at once.
  const discoverySettings = new DiscoverySettingsStore(engine, {
    listenHost: host ?? null,
    onChange: () => syncAdvertiser(),
  });
  await discoverySettings.load();
  const advertiser = createAdvertiser({
    isWanted: () => discoverySettings.isAdvertiseWanted,
    options: () => ({ name: `MCP Zeromem on ${hostname()}`, port: config.port }),
    log: console.log,
  });
  const syncAdvertiser = (): void => {
    const isHeldBack = discoverySettings.isAdvertiseRequested && discoverySettings.isLoopbackOnly;
    if (isHeldBack) {
      console.log(`LAN discovery: not advertising; HOST=${host} is a loopback address no other machine can reach`);
    }
    void advertiser.sync();
  };

  const app = buildApp({ engine, config, worker, discoverySettings });
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
    // After listen, so a router that finds the announcement can already read the catalog.
    syncAdvertiser();
  };
  const httpServer = host ? app.listen(config.port, host, onListen) : app.listen(config.port, onListen);
  httpServer.keepAliveTimeout = config.keepAliveTimeoutMs;

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    // First, so the goodbye goes out while the server can still answer.
    advertiser
      .close()
      .catch((err: unknown) => console.warn(`LAN discovery: could not stop advertising: ${errorMessage(err)}`))
      .finally(() => {
        httpServer.close(() => {
          worker.stop().finally(() => process.exit(0));
        });
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(`Fatal startup error: ${errorChainMessage(err)}`);
  process.exit(1);
});
