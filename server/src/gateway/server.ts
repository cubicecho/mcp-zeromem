import type { StoredTurn } from '@mcp-zeromem/shared';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.ts';
import type { ZeroMemEngine } from '../engine/index.ts';
import { errorChainMessage } from '../errors.ts';
import { SERVER_VERSION } from '../version.ts';
import { registerCuratorPrompts } from './prompts.ts';
import type { ToolDefinition } from './tool.ts';
import { curateTools } from './tools/curate.ts';
import { forgetTools } from './tools/forget.ts';
import { recallTools } from './tools/recall.ts';
import { rememberTools } from './tools/remember.ts';
import { sessionTools } from './tools/session.ts';
import { statsTools } from './tools/stats.ts';

export interface GatewayDeps {
  engine: ZeroMemEngine;
  config: Config;
  /** Serve the curator tools and prompts: the curator token, or everyone when configured. */
  curator?: boolean;
  /**
   * The standing brief of `config.scope`, read by the caller so building a
   * server stays synchronous. It goes out as the server's `instructions`,
   * which a client puts in context at initialize: no recall, no tool call.
   */
  brief?: StoredTurn | null;
}

/** What `zeromem://brief/{scope}` calls the unscoped store, which has no name of its own. */
export const UNSCOPED_BRIEF = '_';

/** A brief as a model should meet it: what it is, how old, and where the rest is. */
export function briefInstructions(brief: StoredTurn): string {
  const where = brief.scope ? `scope ${brief.scope}` : 'this memory';
  const day = new Date(brief.ts).toISOString().slice(0, 10);
  return [
    `Standing brief for ${where}, written by the memory's curator on ${day}. It summarises what earlier`,
    'conversations established; zeromem_recall has the turns behind it and whatever it leaves out or that',
    'came later.',
    '',
    brief.text,
  ].join('\n');
}

/**
 * Every tool this server serves, after the read-only gate.
 *
 * The listing is sent to the model before every request, so the surface stays
 * small and deliberate; see the plan for the six-tool budget. The curator's
 * tools are added only for the curator scope.
 *
 * `zeromem_read_session` is a sixth tool rather than a mode of recall: a model
 * holding a clipped hit has to find the way to the rest of it, and it does that
 * by name in the listing.
 */
export function allTools(deps: GatewayDeps): ToolDefinition[] {
  const { engine, config } = deps;
  const tools = [
    ...recallTools(engine, config),
    ...sessionTools(engine),
    ...rememberTools(engine, config),
    ...statsTools(engine),
    ...forgetTools(engine),
    ...(deps.curator ? curateTools(engine) : []),
  ];
  return deps.config.readOnly ? tools.filter((tool) => tool.kind === 'read') : tools;
}

/**
 * Build an MCP server. Cheap to construct — the engine is shared and opened
 * once — so the stateless HTTP route builds one per request and stdio builds
 * one per process.
 */
export function createGatewayServer(deps: GatewayDeps): McpServer {
  const server = new McpServer(
    { name: 'mcp-zeromem', version: SERVER_VERSION },
    deps.brief ? { instructions: briefInstructions(deps.brief) } : undefined,
  );

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

  // A resource, not a seventh tool: a host that wants another scope's brief
  // (or this one's again, mid-session) reads it by URI.
  server.registerResource(
    'zeromem_brief',
    new ResourceTemplate('zeromem://brief/{scope}', { list: undefined }),
    {
      title: 'Standing brief',
      description: `The curator's standing brief of a scope, e.g. zeromem://brief/project:atlas; zeromem://brief/${UNSCOPED_BRIEF} for the unscoped store. Empty when the scope has none.`,
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const given = decodeURIComponent(String(Array.isArray(variables.scope) ? variables.scope[0] : variables.scope));
      const brief = await deps.engine.brief(given === UNSCOPED_BRIEF ? '' : given);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: brief?.text ?? '' }] };
    },
  );

  if (deps.curator) {
    registerCuratorPrompts(server, { readOnly: deps.config.readOnly });
  }

  return server;
}
