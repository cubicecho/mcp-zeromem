import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import { errorMessage } from '../errors.ts';
import { createGatewayServer, type GatewayDeps } from './server.ts';

/**
 * Streamable-HTTP MCP endpoint at `/mcp`. Stateless: a fresh `McpServer` and
 * transport per request, torn down when the response closes. Nothing here is
 * session-scoped — the engine is the only state and it is shared — so there
 * is no reason to keep sessions around.
 *
 * `router.all` rather than `router.post`: clients open a GET for the SSE stream
 * and send a DELETE to end a session, and a POST-only mount answers those with
 * a 404 that looks like a broken server.
 */
export function createMcpRouter(deps: GatewayDeps): Router {
  const router = Router();

  router.all('/', async (req, res) => {
    const server = createGatewayServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch((err: unknown) => console.warn(`[mcp] transport close failed: ${errorMessage(err)}`));
      server.close().catch((err: unknown) => console.warn(`[mcp] server close failed: ${errorMessage(err)}`));
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}
