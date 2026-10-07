import { type QueryResult, queryResultSchema } from '@mcp-zeromem/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempEngine, testConfig } from '../test-support.ts';
import { createGatewayServer } from './server.ts';

let rig: ReturnType<typeof tempEngine>;
let client: Client;

beforeEach(async () => {
  rig = tempEngine();
  const server = createGatewayServer({ engine: rig.engine, config: testConfig({ dataDir: rig.home }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const stored = await client.callTool({
    name: 'zeromem_remember',
    arguments: {
      session_id: 'a',
      turns: [
        { speaker: 'user', text: 'Maya Okafor owns the billing service on Heron.', ts: 1_000 },
        { speaker: 'user', text: 'The Heron rollout is planned for Friday.', ts: 2_000 },
        { speaker: 'user', text: 'Kenji Sato owns the importer on Basalt.', ts: 3_000 },
      ],
    },
  });
  expect(stored.isError).toBeFalsy();
});

afterEach(() => {
  rig.cleanup();
});

async function recall(args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name: 'zeromem_recall', arguments: args });
  expect(result.isError).toBeFalsy();
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

const parsed = async (args: Record<string, unknown>): Promise<QueryResult> =>
  queryResultSchema.parse(JSON.parse(await recall(args)));

describe('abstention over MCP', () => {
  it('declines a question about a name memory does not hold, and still shows the closest turns', async () => {
    const result = await parsed({ query: 'Who owns the billing service on Quill?' });
    expect(result.abstained?.missing).toEqual(['quill']);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.every((item) => item.role === 'supporting')).toBe(true);
  });

  it('leads a text reply with the verdict, so the blocks under it are not read as the answer', async () => {
    const text = await recall({ query: 'Who owns the billing service on Quill?', format: 'text' });
    const [first, ...blocks] = text.split('\n\n');
    expect(first).toMatch(/^\[abstained\] Memory does not hold the answer: no turn in memory mentions "quill"\./);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => block.startsWith('[supporting]'))).toBe(true);
  });

  it('says nothing when memory holds the answer', async () => {
    const query = 'Who owns the billing service on Heron?';
    const result = await parsed({ query });
    expect(result.abstained).toBeUndefined();
    expect(result.evidence[0]?.turn.text).toContain('Maya Okafor');
    expect(await recall({ query, format: 'text' })).toMatch(/^\[primary\]/);
  });
});
