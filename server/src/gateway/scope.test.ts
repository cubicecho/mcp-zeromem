import { type QueryResult, queryResultSchema, statsSchema } from '@mcp-zeromem/shared';
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

async function connectedClient(scope: string | null = null): Promise<Client> {
  const config = testConfig({ dataDir: rig.home, scope });
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

async function remember(client: Client, session_id: string, text: string, scope?: string): Promise<void> {
  const result = await client.callTool({
    name: 'zeromem_remember',
    arguments: { session_id, turns: [{ speaker: 'user', text, ts: 1_000 }], ...(scope === undefined ? {} : { scope }) },
  });
  expect(result.isError).toBeFalsy();
}

async function recall(client: Client, args: Record<string, unknown>): Promise<QueryResult> {
  const result = await client.callTool({ name: 'zeromem_recall', arguments: { query: 'who owns billing', ...args } });
  expect(result.isError).toBeFalsy();
  return queryResultSchema.parse(JSON.parse(textOf(result)));
}

const sessionsOf = (result: QueryResult) => result.evidence.map((item) => item.turn.session_id).sort();

describe('scopes over MCP', () => {
  it('keeps two scopes apart on recall and searches both when none is named', async () => {
    const client = await connectedClient();
    await remember(client, 'a', 'Maya owns billing on Atlas.', 'project:atlas');
    await remember(client, 'b', 'Ravi owns billing on Borealis.', 'project:borealis');

    expect(sessionsOf(await recall(client, { scope: 'project:atlas' }))).toEqual(['a']);
    expect(sessionsOf(await recall(client, { scope: 'project:borealis' }))).toEqual(['b']);
    expect(sessionsOf(await recall(client, {}))).toEqual(['a', 'b']);
    // Exact, never a prefix.
    expect(sessionsOf(await recall(client, { scope: 'project:' }))).toEqual([]);
  });

  it('reports the scope on a hit and leaves the field out of an unscoped one', async () => {
    const client = await connectedClient();
    await remember(client, 'a', 'Maya owns billing on Atlas.', 'project:atlas');
    await remember(client, 'plain', 'Billing is owned by someone.');

    const hits = (await recall(client, {})).evidence.map((item) => item.turn);
    expect(hits.find((turn) => turn.session_id === 'a')?.scope).toBe('project:atlas');
    expect(hits.find((turn) => turn.session_id === 'plain')).not.toHaveProperty('scope');

    const text = textOf(
      await client.callTool({ name: 'zeromem_recall', arguments: { query: 'who owns billing', format: 'text' } }),
    );
    expect(text).toContain('(session a, turn 1, scope project:atlas)');
    expect(text).toMatch(/\(session plain, turn \d+\)/);
  });

  it('defaults reads and writes to ZEROMEM_SCOPE, and a blank scope opts out', async () => {
    const open = await connectedClient();
    await remember(open, 'b', 'Ravi owns billing on Borealis.', 'project:borealis');

    const atlas = await connectedClient('project:atlas');
    await remember(atlas, 'a', 'Maya owns billing on Atlas.');
    await remember(atlas, 'plain', 'Billing is owned by someone.', '');

    expect(sessionsOf(await recall(atlas, {}))).toEqual(['a']);
    expect(sessionsOf(await recall(atlas, { scope: 'project:borealis' }))).toEqual(['b']);
    expect(sessionsOf(await recall(atlas, { scope: '' }))).toEqual(['a', 'b', 'plain']);
  });

  it('gives an ingest scope to the lines that name none', async () => {
    const client = await connectedClient();
    const jsonl = [
      { session_id: 'a', speaker: 'user', text: 'Maya owns billing on Atlas.', ts: 1 },
      { session_id: 'b', speaker: 'user', text: 'Ravi owns billing on Borealis.', ts: 2, scope: 'project:borealis' },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const result = await client.callTool({ name: 'zeromem_ingest', arguments: { jsonl, scope: 'project:atlas' } });
    expect(JSON.parse(textOf(result))).toMatchObject({ indexed: 2, rejected: 0 });

    expect(sessionsOf(await recall(client, { scope: 'project:atlas' }))).toEqual(['a']);
    expect(sessionsOf(await recall(client, { scope: 'project:borealis' }))).toEqual(['b']);
  });

  it('lists scopes in stats and filters the session list by one', async () => {
    const client = await connectedClient();
    await remember(client, 'a', 'Maya owns billing on Atlas.', 'project:atlas');
    await remember(client, 'a2', 'Maya still owns billing on Atlas.', 'project:atlas');
    await remember(client, 'b', 'Ravi owns billing on Borealis.', 'project:borealis');

    const result = await client.callTool({
      name: 'zeromem_stats',
      arguments: { include_sessions: true, scope: 'project:atlas' },
    });
    const body = JSON.parse(textOf(result)) as { sessions_list: Array<{ session_id: string; scope?: string }> };
    expect(statsSchema.parse(body).scopes).toEqual([
      { scope: 'project:atlas', turns: 2, sessions: 2 },
      { scope: 'project:borealis', turns: 1, sessions: 1 },
    ]);
    expect(body.sessions_list.map((s) => s.session_id).sort()).toEqual(['a', 'a2']);
    expect(body.sessions_list.every((s) => s.scope === 'project:atlas')).toBe(true);
  });

  it('reads a session whatever its scope unless asked to check it', async () => {
    const client = await connectedClient('project:borealis');
    await remember(client, 'a', 'Maya owns billing on Atlas.', 'project:atlas');

    const read = await client.callTool({
      name: 'zeromem_read_session',
      arguments: { session_id: 'a', format: 'text' },
    });
    expect(read.isError).toBeFalsy();
    expect(textOf(read)).toContain('session a (scope project:atlas): turns 1–1 of 1');

    const refused = await client.callTool({
      name: 'zeromem_read_session',
      arguments: { session_id: 'a', scope: 'project:borealis' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('in scope "project:atlas"');
  });
});
