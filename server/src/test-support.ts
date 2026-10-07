import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from './config.ts';
import type { ChatMessage, LlmConfig, ToolSpec } from './curator-agent/llm.ts';
import { ZeroMemEngine } from './engine/index.ts';

/**
 * Shared rigging for the tests. The house rule is "never mock the database",
 * and here the database is the engine: every test opens a real store in a
 * temp directory and cleans it up afterwards.
 */
export function tempEngine(): { engine: ZeroMemEngine; home: string; cleanup: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), 'mcp-zeromem-test-'));
  // The hash embedder: deterministic, no model download, and what the Rust
  // golden tests use, so a ranking a server test sees is one the engine's own
  // tests have already pinned.
  const engine = ZeroMemEngine.open(home, { embedder: 'hash' });
  return { engine, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A config with every field set, so a test overrides only what it is about. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    dataDir: '/nonexistent',
    port: 3000,
    authToken: 'test-token',
    readOnly: false,
    recallTextLimit: 2000,
    embedder: 'hash',
    allowEmbedderSwitch: false,
    remoteEmbedder: null,
    embeddingApiKey: null,
    sessionId: null,
    curatorToken: null,
    curator: false,
    ...overrides,
  };
}

export interface MockEmbeddingsServer {
  /** Base URL up to `/v1`, as an embedder spec wants it. */
  url: string;
  /** Every request body seen, in order. */
  requests: Array<{ model: string; input: string[]; authorization: string | null }>;
  /** Make the next `n` requests fail with a 500. */
  failNext(n: number): void;
  close(): Promise<void>;
}

/**
 * A stand-in for an OpenAI-compatible `/v1/embeddings` endpoint: deterministic
 * `dim`-length vectors from a word hash, so two texts sharing words are near
 * each other and the same text always maps to the same vector.
 */
export async function mockEmbeddingsServer(dim = 8): Promise<MockEmbeddingsServer> {
  const requests: MockEmbeddingsServer['requests'] = [];
  let failing = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (req.url !== '/v1/embeddings' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as { model: string; input: string[] };
      requests.push({ model: parsed.model, input: parsed.input, authorization: req.headers.authorization ?? null });
      if (failing > 0) {
        failing -= 1;
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'flaky' }));
        return;
      }
      const data = parsed.input.map((text, index) => ({ object: 'embedding', index, embedding: embed(text, dim) }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    failNext: (n) => {
      failing = n;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function embed(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let hash = 2166136261;
    for (const ch of word) {
      hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
    }
    const slot = hash % dim;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  return vector;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  authorization: string | null;
}

export type Reply = {
  content?: string;
  calls?: Array<{ name: string; arguments: string }>;
  /** `length` for a reply the server cut at its token cap. */
  finish?: string;
};

/**
 * A stand-in for an OpenAI-compatible `/chat/completions` endpoint that plays
 * a script: the nth request gets the nth reply. The store, the MCP server and
 * the tools behind it are real.
 */
export async function scriptedModel(
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
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          choices: [{ message, finish_reason: reply.finish ?? 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      );
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
