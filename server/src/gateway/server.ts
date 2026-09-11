import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.ts';
import type { ZeroMemEngine } from '../engine/index.ts';
import { errorChainMessage } from '../errors.ts';
import { SERVER_VERSION } from '../version.ts';
import type { ToolDefinition } from './tool.ts';
import { forgetTools } from './tools/forget.ts';
import { recallTools } from './tools/recall.ts';
import { rememberTools } from './tools/remember.ts';
import { statsTools } from './tools/stats.ts';

export interface GatewayDeps {
  engine: ZeroMemEngine;
  config: Config;
}

/**
 * Every tool this server serves, after the read-only gate.
 *
 * The listing is sent to the model before every request, so the surface stays
 * small and deliberate; see the plan for the five-tool budget.
 */
export function allTools(deps: GatewayDeps): ToolDefinition[] {
  const { engine, config } = deps;
  const tools = [
    ...recallTools(engine, config),
    ...rememberTools(engine, config),
    ...statsTools(engine),
    ...forgetTools(engine),
  ];
  return deps.config.readOnly ? tools.filter((tool) => tool.kind === 'read') : tools;
}

/**
 * Build an MCP server. Cheap to construct — the engine is shared and opened
 * once — so the stateless HTTP route builds one per request and stdio builds
 * one per process.
 */
export function createGatewayServer(deps: GatewayDeps): McpServer {
  const server = new McpServer({ name: 'mcp-zeromem', version: SERVER_VERSION });

  for (const tool of allTools(deps)) {
    // An empty raw shape still registers a schema that rejects a call carrying
    // no `arguments` at all, so omit the schema entirely rather than declaring
    // an empty one. (A tool whose arguments are all optional is called with
    // `arguments: {}`, which is what clients send.)
    const hasInputs = Object.keys(tool.inputSchema).length > 0;
    const isRead = tool.kind === 'read';
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        ...(hasInputs ? { inputSchema: tool.inputSchema } : {}),
        annotations: {
          readOnlyHint: isRead,
          destructiveHint: tool.destructive ?? false,
          // Re-remembering the same turns dedups by uuid, so every write here is idempotent.
          idempotentHint: true,
          // Everything is a local SQLite file; nothing reaches the network.
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.run(args ?? {});
          // A string is already the text the tool means to send (recall's `text` format).
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          // A locked database or a malformed turn is something the model can
          // read and route around; tearing down the transport is not.
          return { content: [{ type: 'text' as const, text: errorChainMessage(err) }], isError: true };
        }
      },
    );
  }

  return server;
}
