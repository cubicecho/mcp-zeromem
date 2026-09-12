import { applyReportSchema, curationRunsSchema, queryResultSchema, undoReportSchema } from '@mcp-zeromem/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempEngine, testConfig } from '../test-support.ts';
import { createGatewayServer } from './server.ts';

let rig: ReturnType<typeof tempEngine>;

beforeEach(async () => {
  rig = tempEngine();
  // Old enough (1970) that the minimum-age guard lets the curator touch them.
  await rig.engine.ingestMany([
    { session_id: 'a', speaker: 'user', text: 'Kenji Morimoto owns the edge cache on Basalt.', ts: 1000, uuid: 'u1' },
    { session_id: 'b', speaker: 'user', text: 'Kenji Morimoto owns the edge cache on Basalt.', ts: 2000, uuid: 'u2' },
    { session_id: 'b', speaker: 'assistant', text: 'ok thanks', ts: 3000, uuid: 'u3' },
  ]);
});

afterEach(() => {
  rig.cleanup();
});

async function connectedClient(curator: boolean, readOnly = false): Promise<Client> {
  const config = testConfig({ dataDir: rig.home, readOnly });
  const server = createGatewayServer({ engine: rig.engine, config, curator });
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

const CURATOR_TOOLS = [
  'zeromem_curate_apply',
  'zeromem_curate_candidates',
  'zeromem_curate_read',
  'zeromem_curate_runs',
  'zeromem_curate_undo',
];

describe('curator scope', () => {
  it('serves the curator tools and prompt only to the curator scope', async () => {
    const plain = await connectedClient(false);
    const plainTools = (await plain.listTools()).tools.map((t) => t.name);
    expect(plainTools).toHaveLength(6);
    expect(plainTools.some((name) => name.startsWith('zeromem_curate'))).toBe(false);
    expect(plain.getServerCapabilities()?.prompts).toBeUndefined();

    const curator = await connectedClient(true);
    const tools = (await curator.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(CURATOR_TOOLS));
    expect(tools).toHaveLength(11);
    const { prompts } = await curator.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      'zeromem_curate',
      'zeromem_curate_entities',
      'zeromem_curate_notes',
      'zeromem_curate_session',
    ]);
  });

  it('keeps only the read tools under read-only', async () => {
    const client = await connectedClient(true, true);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      'zeromem_curate_candidates',
      'zeromem_curate_read',
      'zeromem_curate_runs',
      'zeromem_read_session',
      'zeromem_recall',
      'zeromem_stats',
    ]);
  });

  it('serves the playbook as the zeromem_curate prompt, with an optional focus', async () => {
    const client = await connectedClient(true);
    const plain = await client.getPrompt({ name: 'zeromem_curate', arguments: {} });
    const text = promptText(plain);
    expect(text).toMatch(/^# Curator playbook/);
    expect(text).toContain('zeromem_curate_apply');

    const focused = await client.getPrompt({ name: 'zeromem_curate', arguments: { focus: 'noise' } });
    expect(promptText(focused)).toMatch(/Work only on these kinds: noise\.$/);
  });

  it('serves a procedure per focused job, each naming what this run is about', async () => {
    const client = await connectedClient(true);

    const session = await client.getPrompt({
      name: 'zeromem_curate_session',
      arguments: { session_id: 'b' },
    });
    const sessionText = promptText(session);
    expect(sessionText).toMatch(/^# Curating one session/);
    // The focused runs hand the sweep's cursor back, so they never skip turns nobody has read.
    expect(sessionText).toContain('cursor: <the cursor from step 1>');
    expect(sessionText).toMatch(/Curate session `b`, and no other\. Nothing outside it is yours this run\.$/);

    const notes = await client.getPrompt({ name: 'zeromem_curate_notes', arguments: {} });
    expect(promptText(notes)).toMatch(/^# Writing curator notes/);

    const entities = await client.getPrompt({ name: 'zeromem_curate_entities', arguments: { entity: 'Maya' } });
    expect(promptText(entities)).toMatch(/Settle `Maya` and the names that appear beside it/);
  });

  it('tells a read-only curator to report the actions instead of applying them', async () => {
    const client = await connectedClient(true, true);
    const text = promptText(await client.getPrompt({ name: 'zeromem_curate', arguments: {} }));
    expect(text).toMatch(/## This server is read-only/);
    expect(text).toMatch(/reply\s+with the actions you would have applied/);

    const writable = await connectedClient(true);
    expect(promptText(await writable.getPrompt({ name: 'zeromem_curate', arguments: {} }))).not.toContain('read-only');
  });
});

describe('curator tools', () => {
  it('dry-runs, applies, hides from recall and undoes a run', async () => {
    const client = await connectedClient(true);
    const actions = [{ op: 'hide', turn_ids: [2], reason: 'repeat of #1' }];

    const dry = applyReportSchema.parse(
      json(
        await client.callTool({ name: 'zeromem_curate_apply', arguments: { run_id: 'r1', actions, dry_run: true } }),
      ),
    );
    expect(dry).toMatchObject({ dry_run: true, applied: 1, rejected: 0 });
    expect((await rig.engine.stats()).hidden).toBe(0);

    const applied = applyReportSchema.parse(
      json(await client.callTool({ name: 'zeromem_curate_apply', arguments: { run_id: 'r1', actions } })),
    );
    expect(applied).toMatchObject({ dry_run: false, applied: 1 });
    expect((await rig.engine.stats()).hidden).toBe(1);

    const recalled = queryResultSchema.parse(
      json(await client.callTool({ name: 'zeromem_recall', arguments: { query: 'who owns the edge cache?' } })),
    );
    expect(recalled.evidence.map((e) => e.turn.uuid)).not.toContain('u2');

    const read = json(await client.callTool({ name: 'zeromem_curate_read', arguments: { turn_ids: [2] } }));
    expect(read).toEqual([expect.objectContaining({ uuid: 'u2', hidden: true })]);

    await client.callTool({
      name: 'zeromem_curate_apply',
      arguments: { run_id: 'r1', actions: [{ op: 'run_end', summary: 'hid one repeat' }] },
    });
    const runs = curationRunsSchema.parse(json(await client.callTool({ name: 'zeromem_curate_runs', arguments: {} })));
    expect(runs.runs[0]).toMatchObject({
      run_id: 'r1',
      finished: true,
      summary: 'hid one repeat',
      actor: 'mcp-curator',
    });
    expect(json(await client.callTool({ name: 'zeromem_curate_runs', arguments: {} }))).not.toHaveProperty('token');

    const undone = undoReportSchema.parse(
      json(await client.callTool({ name: 'zeromem_curate_undo', arguments: { run_id: 'r1' } })),
    );
    expect(undone.undone.length).toBeGreaterThan(0);
    expect((await rig.engine.stats()).hidden).toBe(0);
  });

  it('refuses turns younger than the minimum age, and batches over the per-call limit', async () => {
    await rig.engine.ingestTurn({ session_id: 'c', speaker: 'user', text: 'fresh', ts: Date.now(), uuid: 'u4' });
    const client = await connectedClient(true);
    const young = applyReportSchema.parse(
      json(
        await client.callTool({
          name: 'zeromem_curate_apply',
          arguments: { run_id: 'r2', actions: [{ op: 'hide', turn_ids: [4], reason: 'noise' }] },
        }),
      ),
    );
    expect(young).toMatchObject({ applied: 0, rejected: 1 });
    expect(young.results[0]?.error).toMatch(/age|young|recent/i);

    const config = await rig.engine.curatorConfig();
    await rig.engine.setCuratorConfig({ ...config, max_per_call: 1 });
    const over = await client.callTool({
      name: 'zeromem_curate_apply',
      arguments: {
        run_id: 'r2',
        actions: [
          { op: 'hide', turn_ids: [3], reason: 'chatter' },
          { op: 'hide', turn_ids: [2], reason: 'repeat' },
        ],
      },
    });
    expect(over.isError).toBe(true);
    expect((await rig.engine.stats()).hidden).toBe(0);
  });

  it('lists candidates and checks the read selector', async () => {
    const client = await connectedClient(true);
    const page = json(await client.callTool({ name: 'zeromem_curate_candidates', arguments: { kind: 'duplicates' } }));
    expect(page).toMatchObject({ kind: 'duplicates' });
    const both = await client.callTool({ name: 'zeromem_curate_read', arguments: { turn_ids: [1], session_id: 'a' } });
    expect(both.isError).toBe(true);
    const neither = await client.callTool({ name: 'zeromem_curate_undo', arguments: {} });
    expect(neither.isError).toBe(true);
  });
});

function promptText(result: { messages: Array<{ content: unknown }> }): string {
  const content = result.messages[0]?.content as { text?: string } | undefined;
  return content?.text ?? '';
}
