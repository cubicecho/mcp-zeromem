import { applyReportSchema, candidatePageSchema, queryResultSchema } from '@mcp-zeromem/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { tempEngine, testConfig } from '../test-support.ts';
import { createGatewayServer } from './server.ts';

const ATLAS = 'project:atlas';
const BRIEF = 'Maya Okafor owns the billing service on Heron.';

let rig: ReturnType<typeof tempEngine>;

beforeEach(async () => {
  rig = tempEngine();
  // Old enough (1970) that the minimum-age guard lets the curator touch them.
  await rig.engine.ingestMany([
    {
      session_id: 'a',
      speaker: 'user',
      text: 'Maya Okafor owns the billing service on Heron.',
      ts: 1000,
      scope: ATLAS,
    },
    { session_id: 'b', speaker: 'user', text: 'Standup is at ten.', ts: 2000 },
  ]);
});

afterEach(() => {
  rig.cleanup();
});

async function connectedClient(scope: string | null = null, curator = false): Promise<Client> {
  const config = testConfig({ dataDir: rig.home, scope });
  const brief = await rig.engine.brief(scope ?? '');
  const server = createGatewayServer({ engine: rig.engine, config, curator, brief });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

function json(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((c) => c.type === 'text')?.text ?? 'null');
}

async function resourceText(client: Client, uri: string): Promise<string> {
  const { contents } = await client.readResource({ uri });
  return (contents[0] as { text: string }).text;
}

function promptText(result: { messages: { content: unknown }[] }): string {
  const content = result.messages[0]?.content as { text?: string } | undefined;
  return content?.text ?? '';
}

describe('the standing brief over MCP', () => {
  it('is written by the curator, sent as instructions, read as a resource and never recalled', async () => {
    expect((await connectedClient(ATLAS)).getInstructions()).toBeUndefined();

    const curator = await connectedClient(null, true);
    const page = candidatePageSchema.parse(
      json(await curator.callTool({ name: 'zeromem_curate_candidates', arguments: { kind: 'brief' } })),
    );
    expect(page.candidates.map((c) => c.suggested)).toEqual([
      { op: 'brief', scope: '', text: '', source_ids: [] },
      { op: 'brief', scope: ATLAS, text: '', source_ids: [] },
    ]);
    const applied = applyReportSchema.parse(
      json(
        await curator.callTool({
          name: 'zeromem_curate_apply',
          arguments: { run_id: 'r1', actions: [{ op: 'brief', scope: ATLAS, text: BRIEF, reason: 'first brief' }] },
        }),
      ),
    );
    expect(applied.results[0]).toMatchObject({ ok: true, op: 'brief', brief_id: expect.any(Number) });

    const client = await connectedClient(ATLAS);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain(`Standing brief for scope ${ATLAS}`);
    expect(instructions.endsWith(BRIEF)).toBe(true);
    // Another scope's server says nothing, but any client can read a brief by URI.
    const elsewhere = await connectedClient();
    expect(elsewhere.getInstructions()).toBeUndefined();
    expect(await resourceText(elsewhere, `zeromem://brief/${encodeURIComponent(ATLAS)}`)).toBe(BRIEF);
    expect(await resourceText(elsewhere, `zeromem://brief/${ATLAS}`)).toBe(BRIEF);
    expect(await resourceText(elsewhere, 'zeromem://brief/_')).toBe('');
    expect((await elsewhere.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      'zeromem://brief/{scope}',
    ]);

    const recalled = queryResultSchema.parse(
      json(await client.callTool({ name: 'zeromem_recall', arguments: { query: BRIEF, format: 'json' } })),
    );
    expect(recalled.evidence.map((e) => e.turn.kind ?? 'turn')).toEqual(['turn']);

    await curator.callTool({ name: 'zeromem_curate_undo', arguments: { run_id: 'r1' } });
    expect((await connectedClient(ATLAS)).getInstructions()).toBeUndefined();
  });

  it('serves the brief procedure as a prompt, naming the scope when given one', async () => {
    const curator = await connectedClient(null, true);
    const sweep = await curator.getPrompt({ name: 'zeromem_curate_brief', arguments: {} });
    const text = promptText(sweep);
    expect(text).toContain('# Writing the standing brief');
    expect(text).not.toContain('## This run');
    const one = await curator.getPrompt({ name: 'zeromem_curate_brief', arguments: { scope: ATLAS } });
    expect(promptText(one)).toContain(`scope \`${ATLAS}\` only`);
  });

  it('answers initialize on /mcp with the brief of ZEROMEM_SCOPE', async () => {
    await rig.engine.curateApply('r1', 'tester', [
      { op: 'brief', scope: ATLAS, text: BRIEF, source_ids: [], reason: 'first brief' },
    ]);
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    };
    const post = (scope: string | null) =>
      request(
        buildApp({ engine: rig.engine, config: testConfig({ dataDir: rig.home, scope }), appDistDir: '/nonexistent' }),
      )
        .post('/mcp')
        .set('Authorization', 'Bearer test-token')
        .set('Accept', 'application/json, text/event-stream')
        .send(initialize);

    const scoped = await post(ATLAS);
    expect(scoped.status).toBe(200);
    expect(scoped.body.result.instructions).toContain(BRIEF);
    expect((await post(null)).body.result.instructions).toBeUndefined();
  });
});
