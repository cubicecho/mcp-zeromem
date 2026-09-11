import { queryResultSchema, statsSchema } from '@mcp-zeromem/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempEngine, testConfig } from '../test-support.ts';
import { createGatewayServer } from './server.ts';

let rig: ReturnType<typeof tempEngine>;

beforeEach(() => {
  rig = tempEngine();
});

afterEach(() => {
  rig.cleanup();
});

async function connectedClient(readOnly = false, sessionId: string | null = null): Promise<Client> {
  const config = testConfig({ dataDir: rig.home, readOnly, sessionId });
  const server = createGatewayServer({ engine: rig.engine, config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

describe('gateway server', () => {
  it('lists zeromem_stats with read-only annotations', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const stats = tools.find((t) => t.name === 'zeromem_stats');
    expect(stats?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });

  it('answers zeromem_stats with the store counts', async () => {
    await rig.engine.ingestTurn({ session_id: 's', speaker: 'user', text: 'hello' });
    const client = await connectedClient();
    const result = await client.callTool({ name: 'zeromem_stats', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(statsSchema.parse(JSON.parse(textOf(result)))).toMatchObject({ turns: 1, sessions: 1 });
  });

  it('lists the five tools, and only the read tools when read-only', async () => {
    const all = await (await connectedClient()).listTools();
    expect(all.tools.map((t) => t.name).sort()).toEqual([
      'zeromem_forget_session',
      'zeromem_ingest',
      'zeromem_recall',
      'zeromem_remember',
      'zeromem_stats',
    ]);
    const forget = all.tools.find((t) => t.name === 'zeromem_forget_session');
    expect(forget?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

    const readOnly = await (await connectedClient(true)).listTools();
    expect(readOnly.tools.map((t) => t.name).sort()).toEqual(['zeromem_recall', 'zeromem_stats']);
  });

  it('remembers, recalls and forgets', async () => {
    const client = await connectedClient();
    const remembered = await client.callTool({
      name: 'zeromem_remember',
      arguments: {
        session_id: 'a',
        turns: [
          { speaker: 'user', text: 'Maya Okafor owns the billing service on Heron.', ts: 1000, uuid: 'u1' },
          { speaker: 'assistant', text: 'Noted.', ts: 1001, uuid: 'u2' },
        ],
      },
    });
    expect(JSON.parse(textOf(remembered))).toEqual({ indexed: 2, duplicates: 0, rejected: 0 });
    const again = await client.callTool({
      name: 'zeromem_remember',
      arguments: { session_id: 'a', turns: [{ speaker: 'user', text: 'anything', uuid: 'u1' }] },
    });
    expect(JSON.parse(textOf(again))).toEqual({ indexed: 0, duplicates: 1, rejected: 0 });

    const recalled = await client.callTool({
      name: 'zeromem_recall',
      arguments: { query: 'who owns the billing service on Heron?', detail: 'full' },
    });
    expect(recalled.isError).toBeFalsy();
    const result = queryResultSchema.parse(JSON.parse(textOf(recalled)));
    expect(result.evidence[0]?.turn.uuid).toBe('u1');
    expect(result.route?.views.length).toBeGreaterThan(0);

    const stats = await client.callTool({ name: 'zeromem_stats', arguments: { include_sessions: true } });
    expect(JSON.parse(textOf(stats)).sessions_list).toEqual([
      { session_id: 'a', turns: 2, first_ts: 1000, last_ts: 1001 },
    ]);

    const refused = await client.callTool({
      name: 'zeromem_forget_session',
      arguments: { session_id: 'a', confirm: false },
    });
    expect(refused.isError).toBeTruthy();
    const forgotten = await client.callTool({
      name: 'zeromem_forget_session',
      arguments: { session_id: 'a', confirm: true },
    });
    expect(JSON.parse(textOf(forgotten))).toEqual({ session_id: 'a', removed: 2 });
  });

  it('excludes the configured session from recall by default', async () => {
    await rig.engine.ingestMany([
      { session_id: 'current', speaker: 'user', text: 'Kenji Morimoto owns the edge cache on Basalt.', ts: 1 },
      { session_id: 'earlier', speaker: 'user', text: 'Kenji Morimoto owns the edge cache on Basalt.', ts: 2 },
    ]);
    const client = await connectedClient(false, 'current');
    const recalled = await client.callTool({
      name: 'zeromem_recall',
      arguments: { query: 'who owns the edge cache?' },
    });
    const result = queryResultSchema.parse(JSON.parse(textOf(recalled)));
    expect(result.evidence.map((e) => e.turn.session_id)).toEqual(['earlier']);
  });

  it('ingests JSONL, reporting the bad lines, and refuses a path outside the data dir', async () => {
    const client = await connectedClient();
    const jsonl = ['{"session_id":"j","speaker":"user","text":"line one"}', 'garbage'].join('\n');
    const result = JSON.parse(textOf(await client.callTool({ name: 'zeromem_ingest', arguments: { jsonl } })));
    expect(result).toMatchObject({ indexed: 1, duplicates: 0, rejected: 1 });
    expect(result.rejected_lines[0].line).toBe(2);

    const outside = await client.callTool({ name: 'zeromem_ingest', arguments: { path: '../../etc/passwd' } });
    expect(outside.isError).toBeTruthy();
    expect(textOf(outside)).toMatch(/inside the data directory/);
  });

  it('keeps the listing within the size budget', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(JSON.stringify(tool).length).toBeLessThan(100_000);
    }
    expect(JSON.stringify(tools).length).toBeLessThan(650_000);
  });
});
