import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayServer } from '../gateway/server.ts';
import { tempEngine, testConfig } from '../test-support.ts';
import { runCurator } from './agent.ts';
import { loadAgentConfig } from './config.ts';
import type { ChatMessage, LlmConfig, ToolSpec } from './llm.ts';

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  authorization: string | null;
}

type Reply = { content?: string; calls?: Array<{ name: string; arguments: string }> };

/**
 * A stand-in for an OpenAI-compatible `/chat/completions` endpoint that plays
 * a script: the nth request gets the nth reply. The store, the MCP server and
 * the tools behind it are real.
 */
async function scriptedModel(
  script: Reply[],
): Promise<{ llm: LlmConfig; requests: ChatRequest[]; close(): Promise<void> }> {
  const requests: ChatRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      const reply = script[requests.length];
      requests.push({ ...(JSON.parse(body) as ChatRequest), authorization: req.headers.authorization ?? null });
      if (reply === undefined) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'script ran out' }));
        return;
      }
      const message = {
        role: 'assistant',
        content: reply.content ?? null,
        tool_calls: reply.calls?.map((call, index) => ({
          id: `call_${requests.length}_${index}`,
          type: 'function',
          function: call,
        })),
      };
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    llm: { url: `http://127.0.0.1:${port}/v1`, model: 'scripted', apiKey: 'sk-test', timeoutMs: 5000 },
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let rig: ReturnType<typeof tempEngine>;
let model: Awaited<ReturnType<typeof scriptedModel>> | null = null;

beforeEach(async () => {
  rig = tempEngine();
  // Old enough (1970) that the minimum-age guard lets the curator touch them.
  await rig.engine.ingestMany([
    { session_id: 'a', speaker: 'user', text: 'Kenji Morimoto owns the edge cache on Basalt.', ts: 1000, uuid: 'u1' },
    { session_id: 'b', speaker: 'user', text: 'Kenji Morimoto owns the edge cache on Basalt.', ts: 2000, uuid: 'u2' },
    { session_id: 'b', speaker: 'assistant', text: 'ok thanks', ts: 3000, uuid: 'u3' },
  ]);
});

afterEach(async () => {
  await model?.close();
  model = null;
  rig.cleanup();
});

async function connectedClient(curator = true, readOnly = false): Promise<Client> {
  const config = testConfig({ dataDir: rig.home, readOnly });
  const server = createGatewayServer({ engine: rig.engine, config, curator });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

async function turnId(uuid: string): Promise<number> {
  const turns = await rig.engine.curationTurns({ session_id: uuid === 'u1' ? 'a' : 'b' });
  const turn = turns.find((t) => t.uuid === uuid);
  if (turn === undefined) throw new Error(`no turn ${uuid}`);
  return turn.id;
}

describe('runCurator', () => {
  it('hands the served playbook to the model and applies what it decides', async () => {
    const repeat = await turnId('u2');
    const run_id = 'curate-2026-10-07T0300Z';
    model = await scriptedModel([
      { calls: [{ name: 'zeromem_curate_runs', arguments: '{}' }] },
      { calls: [{ name: 'zeromem_curate_candidates', arguments: '{"kind":"duplicates"}' }] },
      {
        calls: [
          {
            name: 'zeromem_curate_apply',
            arguments: JSON.stringify({
              run_id,
              actions: [
                { op: 'hide', turn_ids: [repeat], reason: 'repeat of the same ownership statement' },
                { op: 'run_end', summary: 'Hid one duplicate.' },
              ],
            }),
          },
        ],
      },
      { content: '<think>done</think>Hid one duplicate.' },
    ]);

    const lines: string[] = [];
    const report = await runCurator({
      client: await connectedClient(),
      llm: model.llm,
      prompt: { name: 'zeromem_curate', args: { focus: 'duplicates' } },
      now: () => new Date('2026-10-07T03:00:00Z'),
      log: (line) => lines.push(line),
    });

    expect(report).toMatchObject({
      summary: 'Hid one duplicate.',
      finished: true,
      closed: true,
      steps: 4,
      tool_errors: 0,
      tool_calls: { zeromem_curate_runs: 1, zeromem_curate_candidates: 1, zeromem_curate_apply: 1 },
      prompt_tokens: 40,
    });
    expect(lines).toContain('zeromem_curate_apply [hide, run_end]');

    // The store changed: the repeat is hidden and the run is closed.
    const turns = await rig.engine.curationTurns({ session_id: 'b' });
    expect(turns.find((t) => t.uuid === 'u2')?.hidden).toBe(true);
    const { runs } = await rig.engine.curationRuns({ limit: 5 });
    expect(runs[0]).toMatchObject({ run_id, finished: true, summary: 'Hid one duplicate.' });

    // The model was given the playbook, the time, the key, and a curator's tools only.
    const [first, second] = model.requests;
    expect(first?.authorization).toBe('Bearer sk-test');
    expect(first?.messages[0]?.content).toContain('2026-10-07T03:00:00.000Z');
    expect(first?.messages[1]?.content).toContain('# Curator playbook');
    expect(first?.messages[1]?.content).toContain('Work only on these kinds: duplicates.');
    const offered = first?.tools?.map((tool) => tool.function.name).sort();
    expect(offered).toEqual([
      'zeromem_curate_apply',
      'zeromem_curate_candidates',
      'zeromem_curate_read',
      'zeromem_curate_runs',
      'zeromem_curate_undo',
      'zeromem_read_session',
      'zeromem_recall',
    ]);
    // Each tool result goes back under the id of the call that asked for it.
    expect(second?.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1_0' });
  });

  it('returns a bad call to the model as an error and asks once for an open run to be closed', async () => {
    model = await scriptedModel([
      {
        calls: [
          { name: 'zeromem_forget_session', arguments: '{"session_id":"a"}' },
          { name: 'zeromem_curate_candidates', arguments: '{not json' },
          { name: 'zeromem_curate_candidates', arguments: '{"kind":"nonsense"}' },
        ],
      },
      { content: 'Nothing to do.' },
      { content: 'Nothing to do, and I am leaving the run open.' },
    ]);

    const report = await runCurator({
      client: await connectedClient(),
      llm: model.llm,
      prompt: { name: 'zeromem_curate' },
    });

    expect(report).toMatchObject({ finished: true, closed: false, steps: 3, tool_errors: 3 });
    expect(report.summary).toBe('Nothing to do, and I am leaving the run open.');
    const tools = model.requests[1]?.messages.filter((m) => m.role === 'tool').map((m) => m.content) ?? [];
    expect(tools[0]).toBe('There is no tool named zeromem_forget_session.');
    expect(tools[1]).toMatch(/not a JSON object/);
    expect(tools[2]).toMatch(/kind/);
    expect(model.requests[2]?.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(model.requests[2]?.messages.at(-1)?.content).toContain('run_end');
    // The store was not touched: a tool outside the curator's set never reaches the server.
    expect((await rig.engine.stats()).turns).toBe(3);
  });

  it('clips a long tool result with a marker and stops at the step limit', async () => {
    const read = { calls: [{ name: 'zeromem_curate_read', arguments: '{"session_id":"b"}' }] };
    model = await scriptedModel([read, read, read]);

    const report = await runCurator({
      client: await connectedClient(),
      llm: model.llm,
      prompt: { name: 'zeromem_curate' },
      maxSteps: 2,
      maxToolChars: 80,
    });

    expect(report).toMatchObject({ finished: false, closed: false, steps: 2 });
    expect(model.requests).toHaveLength(2);
    const result = model.requests[1]?.messages.at(-1)?.content ?? '';
    expect(result).toMatch(/… \[clipped: 80 of \d+ characters/);
  });

  it('does not nudge a read-only run, which has no run to close', async () => {
    model = await scriptedModel([{ content: 'I would hide turn 2.' }]);
    const report = await runCurator({
      client: await connectedClient(true, true),
      llm: model.llm,
      prompt: { name: 'zeromem_curate' },
    });
    expect(report).toMatchObject({ finished: true, closed: false, steps: 1, summary: 'I would hide turn 2.' });
    expect(model.requests[0]?.messages[1]?.content).toContain('This server is read-only');
  });

  it('refuses a connection that was not given the curator scope', async () => {
    model = await scriptedModel([]);
    await expect(
      runCurator({ client: await connectedClient(false), llm: model.llm, prompt: { name: 'zeromem_curate' } }),
    ).rejects.toThrow(/curator tools/);
    expect(model.requests).toHaveLength(0);
  });

  it('names the endpoint when the model fails', async () => {
    model = await scriptedModel([]);
    await expect(
      runCurator({ client: await connectedClient(), llm: model.llm, prompt: { name: 'zeromem_curate' } }),
    ).rejects.toThrow(/answered 500: .*script ran out/);
  });
});

describe('loadAgentConfig', () => {
  it('reads the endpoint and model, with defaults for the rest', () => {
    const config = loadAgentConfig({
      ZEROMEM_CURATOR_LLM_URL: 'http://framework.lan:13305/api/v1',
      ZEROMEM_CURATOR_LLM_MODEL: 'qwen3.6-moe-35b-a3b-FLM',
    });
    expect(config).toEqual({
      llm: {
        url: 'http://framework.lan:13305/api/v1',
        model: 'qwen3.6-moe-35b-a3b-FLM',
        apiKey: null,
        timeoutMs: 600_000,
      },
      mcpUrl: null,
      maxSteps: 40,
    });
  });

  it('names every variable that is missing or wrong', () => {
    expect(() => loadAgentConfig({ ZEROMEM_CURATOR_MAX_STEPS: 'many' })).toThrow(
      /ZEROMEM_CURATOR_LLM_URL[\s\S]*ZEROMEM_CURATOR_LLM_MODEL[\s\S]*ZEROMEM_CURATOR_MAX_STEPS/,
    );
  });
});
