#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from './config.ts';
import { runCurator } from './curator-agent/agent.ts';
import { loadAgentConfig } from './curator-agent/config.ts';
import { ZeroMemEngine } from './engine/index.ts';
import { errorChainMessage } from './errors.ts';
import { createGatewayServer } from './gateway/server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * One curation run by a local model: `mcp-zeromem-curate [job] [options]`.
 *
 * The model is any OpenAI-compatible endpoint (`ZEROMEM_CURATOR_LLM_URL`,
 * `ZEROMEM_CURATOR_LLM_MODEL`). The store is reached the way any curator
 * reaches it, over MCP: `/mcp` of a running server when
 * `ZEROMEM_CURATOR_MCP_URL` is set (with the curator token), otherwise the
 * store under `DATA_DIR`, opened here and served to this process alone.
 *
 * Progress goes to stderr, the report to stdout as JSON. The exit code is 1
 * when the model did not finish, so cron notices.
 */

const JOBS: Record<string, string> = {
  sweep: 'zeromem_curate',
  session: 'zeromem_curate_session',
  notes: 'zeromem_curate_notes',
  entities: 'zeromem_curate_entities',
};

const USAGE = `usage: mcp-zeromem-curate [sweep|session|notes|entities] [options]

  --focus <kinds>     sweep: only these kinds, comma-separated
                      (duplicates, noise, supersession, aliases, consolidation)
  --session <id>      session, notes: the session to work on
  --entity <name>     entities: the one name to settle
  --max-steps <n>     model requests at most (default ZEROMEM_CURATOR_MAX_STEPS or 40)
  --dry-run           serve the store read-only: the model reports what it would do
                      (needs the store opened here, i.e. no ZEROMEM_CURATOR_MCP_URL)
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      focus: { type: 'string' },
      session: { type: 'string' },
      entity: { type: 'string' },
      'max-steps': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const job = positionals[0] ?? 'sweep';
  const prompt = JOBS[job];
  if (prompt === undefined || positionals.length > 1) {
    throw new Error(`unknown job "${positionals.join(' ')}"\n\n${USAGE}`);
  }
  if (job === 'session' && !values.session) {
    throw new Error('the session job needs --session <id>');
  }
  const args: Record<string, string> = {};
  if (job === 'sweep' && values.focus) args.focus = values.focus;
  if ((job === 'session' || job === 'notes') && values.session) args.session_id = values.session;
  if (job === 'entities' && values.entity) args.entity = values.entity;

  const agent = loadAgentConfig(process.env);
  const maxSteps = values['max-steps'] === undefined ? agent.maxSteps : Number(values['max-steps']);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error('--max-steps must be a positive whole number');
  }

  const client = new Client({ name: 'mcp-zeromem-curate', version: SERVER_VERSION });
  if (agent.mcpUrl !== null) {
    if (values['dry-run']) {
      throw new Error('--dry-run opens the store here; unset ZEROMEM_CURATOR_MCP_URL, or point at a read-only server');
    }
    const token = process.env.MCP_ZEROMEM_CURATOR_TOKEN?.trim();
    if (!token) {
      throw new Error('ZEROMEM_CURATOR_MCP_URL is set, so MCP_ZEROMEM_CURATOR_TOKEN must hold the curator token');
    }
    const headers = { Authorization: `Bearer ${token}` };
    await client.connect(new StreamableHTTPClientTransport(new URL(agent.mcpUrl), { requestInit: { headers } }));
    console.error(`curating ${agent.mcpUrl} with ${agent.llm.model}`);
  } else {
    const loaded = loadConfig(process.env, { transport: 'stdio' });
    const config = { ...loaded, readOnly: loaded.readOnly || values['dry-run'] };
    const engine = ZeroMemEngine.open(config.dataDir, {
      embedder: config.embedder,
      allowEmbedderSwitch: config.allowEmbedderSwitch,
      remoteEmbedder: config.remoteEmbedder,
      embeddingApiKey: config.embeddingApiKey,
      // Like the stdio server: a note written here is embedded by the HTTP server's worker.
      followRemote: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createGatewayServer({ engine, config, curator: true }).connect(serverTransport);
    await client.connect(clientTransport);
    console.error(`curating ${config.dataDir} with ${agent.llm.model}${config.readOnly ? ' (read-only)' : ''}`);
  }

  try {
    const report = await runCurator({
      client,
      llm: agent.llm,
      prompt: { name: prompt, args },
      maxSteps,
      log: (line) => console.error(line),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.finished ? 0 : 1;
  } finally {
    await client.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`mcp-zeromem-curate: ${errorChainMessage(err)}`);
    process.exit(1);
  });
