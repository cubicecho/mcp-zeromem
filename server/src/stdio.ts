#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { ZeroMemEngine } from './engine/index.ts';
import { errorChainMessage } from './errors.ts';
import { createGatewayServer } from './gateway/server.ts';

/**
 * stdio MCP entry point for local clients (Claude Code, Claude Desktop, …).
 *
 * Same env vars as the HTTP server, same store: a stdio session against the
 * same `DATA_DIR` sees every turn the long-running server has indexed, because
 * the store is one SQLite file in WAL mode and both are readers of it.
 *
 * Nothing in this process may write to stdout: that is the JSON-RPC channel,
 * and a stray `console.log` corrupts the stream in a way that looks like
 * anything but a log line.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env, { transport: 'stdio' });
  const engine = ZeroMemEngine.open(config.dataDir, {
    embedder: config.embedder,
    allowEmbedderSwitch: config.allowEmbedderSwitch,
    remoteEmbedder: config.remoteEmbedder,
    embeddingApiKey: config.embeddingApiKey,
    // A conversation never waits on an embedding endpoint: with a remote
    // embedder this process reads what the HTTP server has embedded and
    // stores its own turns without vectors for the server's worker.
    followRemote: false,
  });

  const server = createGatewayServer({ engine, config });
  await server.connect(new StdioServerTransport());
  console.error(`mcp-zeromem stdio ready (store: ${config.dataDir}${config.readOnly ? ', read-only' : ''})`);

  const shutdown = () => process.exit(0);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(`Fatal stdio startup error: ${errorChainMessage(err)}`);
  process.exit(1);
});
