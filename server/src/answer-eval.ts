#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ASKS, type Question, questionSchema, runAnswerEval, sample, summarise } from './answer-eval/eval.ts';
import { loadConfig } from './config.ts';
import { type AgentReport, runCurator } from './curator-agent/agent.ts';
import { loadAgentConfig } from './curator-agent/config.ts';
import type { LlmConfig } from './curator-agent/llm.ts';
import { ZeroMemEngine } from './engine/index.ts';
import { parseJsonl } from './engine/jsonl.ts';
import { errorChainMessage } from './errors.ts';
import { createGatewayServer } from './gateway/server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * Ask a model the harness's labeled questions with only the memory to answer
 * from: `npm run eval:answers -- <corpus-dir> [options]`.
 *
 * The corpus is a directory in the harness's shape (`turns.jsonl`,
 * `queries.jsonl`, and `probes.jsonl` when there is one): a fixture under
 * `crates/zeromem-harness/fixtures/`, or what `zm-harness import` wrote. It is
 * loaded into a store of its own in a temp directory, served over MCP to this
 * process alone, and removed afterwards.
 *
 * `ZEROMEM_EVAL_LLM_URL` / `ZEROMEM_EVAL_LLM_MODEL` name the model under test,
 * which also grades unless `ZEROMEM_EVAL_JUDGE_LLM_*` names another. With
 * `--curate`, the curator model (`ZEROMEM_CURATOR_LLM_*`) sweeps the store
 * first, so the same questions can be scored with and without it.
 */

const USAGE = `usage: npm run eval:answers -- <corpus-dir> [options]

  --limit <n>        ask n questions, spread evenly over the file (default: all)
  --ask <kinds>      only these, comma-separated: ${ASKS.join(', ')}
  --curate           run the curator model's sweep over the store first
  --embedder <name>  the store's embedder: hash (default) or onnx
  --max-steps <n>    model requests per question (default 6)
  --out <file>       also write the report here
`;

function llmFromEnv(env: NodeJS.ProcessEnv, prefix: string): LlmConfig | null {
  const value = (key: string) => env[`${prefix}_${key}`]?.trim() || undefined;
  const url = value('URL');
  const model = value('MODEL');
  if (url === undefined && model === undefined) {
    return null;
  }
  if (url === undefined || model === undefined) {
    throw new Error(`${prefix}_URL and ${prefix}_MODEL must both be set`);
  }
  const timeoutMs = Number(value('TIMEOUT_MS') ?? 600_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error(`${prefix}_TIMEOUT_MS must be a whole number of milliseconds, at least 1000`);
  }
  // A reasoning model can think in circles about a question it cannot settle; an answer is one sentence.
  const maxTokens = Number(value('MAX_TOKENS') ?? 4096);
  if (!Number.isInteger(maxTokens) || maxTokens < 16) {
    throw new Error(`${prefix}_MAX_TOKENS must be a whole number, at least 16`);
  }
  return { url, model, apiKey: value('API_KEY') ?? null, timeoutMs, maxTokens };
}

function readQuestions(file: string): Question[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      const parsed = questionSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`${file}:${i + 1}: ${parsed.error.message}`);
      }
      return parsed.data;
    });
}

const EMBEDDERS = ['hash', 'onnx'] as const;
type Embedder = (typeof EMBEDDERS)[number];

function positiveInt(name: string, raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${name} must be a positive whole number`);
  }
  return n;
}

async function connect(engine: ZeroMemEngine, home: string, embedder: Embedder, curator: boolean): Promise<Client> {
  // A clean environment: nothing of the operator's own server (its session id, its token) applies here.
  const config = loadConfig(
    { DATA_DIR: home, ZEROMEM_EMBEDDER: embedder, ZEROMEM_READ_ONLY: curator ? 'false' : 'true' },
    { transport: 'stdio' },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createGatewayServer({ engine, config, curator }).connect(serverTransport);
  const client = new Client({ name: 'mcp-zeromem-answer-eval', version: SERVER_VERSION });
  await client.connect(clientTransport);
  return client;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: 'string' },
      ask: { type: 'string' },
      curate: { type: 'boolean', default: false },
      embedder: { type: 'string', default: 'hash' },
      'max-steps': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [dir] = positionals;
  if (dir === undefined || positionals.length > 1) {
    throw new Error(`name one corpus directory\n\n${USAGE}`);
  }
  const llm = llmFromEnv(process.env, 'ZEROMEM_EVAL_LLM');
  if (llm === null) {
    throw new Error('ZEROMEM_EVAL_LLM_URL and ZEROMEM_EVAL_LLM_MODEL name the model under test; neither is set');
  }
  const judge = llmFromEnv(process.env, 'ZEROMEM_EVAL_JUDGE_LLM') ?? llm;
  const limit = positiveInt('limit', values.limit);
  const maxSteps = positiveInt('max-steps', values['max-steps']) ?? 6;
  const asks = values.ask?.split(',').map((a) => a.trim());
  for (const ask of asks ?? []) {
    if (!(ASKS as readonly string[]).includes(ask)) {
      throw new Error(`--ask: "${ask}" is not one of ${ASKS.join(', ')}`);
    }
  }

  const embedder = EMBEDDERS.find((name) => name === values.embedder);
  if (embedder === undefined) {
    throw new Error(`--embedder must be one of ${EMBEDDERS.join(', ')}`);
  }

  const turns = parseJsonl(readFileSync(path.join(dir, 'turns.jsonl'), 'utf8'));
  if (turns.rejected.length > 0 || turns.turns.length === 0) {
    throw new Error(`${dir}/turns.jsonl: ${turns.turns.length} turns read, ${turns.rejected.length} lines rejected`);
  }
  const all = [...readQuestions(path.join(dir, 'queries.jsonl')), ...readQuestions(path.join(dir, 'probes.jsonl'))];
  const questions = sample(
    all.filter((q) => asks === undefined || asks.includes(q.ask)),
    limit,
  );
  if (questions.length === 0) {
    throw new Error(`${dir}: no question to ask`);
  }
  const textOf = new Map(turns.turns.flatMap((t) => (t.uuid === undefined ? [] : [[t.uuid, t.text] as const])));
  const now = new Date(Math.max(...turns.turns.map((t) => t.ts ?? 0)));

  const home = mkdtempSync(path.join(tmpdir(), 'mcp-zeromem-answers-'));
  try {
    const engine = ZeroMemEngine.open(home, { embedder });
    const ingested = await engine.ingestMany(turns.turns);
    console.error(`${ingested.indexed} turns from ${dir} in ${home} (${embedder}); ${questions.length} questions`);

    let curation: AgentReport | null = null;
    if (values.curate) {
      const agent = loadAgentConfig(process.env);
      const curator = await connect(engine, home, embedder, true);
      console.error(`curating with ${agent.llm.model}`);
      try {
        curation = await runCurator({
          client: curator,
          llm: agent.llm,
          prompt: { name: 'zeromem_curate' },
          maxSteps: agent.maxSteps,
          log: (line) => console.error(`  ${line}`),
        });
      } finally {
        await curator.close();
      }
    }

    const client = await connect(engine, home, embedder, false);
    console.error(`asking ${llm.model}${judge === llm ? '' : `, graded by ${judge.model}`}`);
    try {
      const results = await runAnswerEval({
        client,
        llm,
        judge,
        questions,
        textOf,
        now,
        maxSteps,
        log: (line) => console.error(line),
      });
      const report = {
        recorded_at: new Date().toISOString(),
        corpus: path.basename(path.resolve(dir)),
        embedder,
        model: llm.model,
        judge: judge.model,
        curator: curation === null ? null : { model: loadAgentConfig(process.env).llm.model, ...curation },
        summary: summarise(results),
        results,
      };
      const body = `${JSON.stringify(report, null, 2)}\n`;
      if (values.out !== undefined) {
        writeFileSync(values.out, body);
      }
      process.stdout.write(body);
      return 0;
    } finally {
      await client.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`mcp-zeromem-answer-eval: ${errorChainMessage(err)}`);
    process.exit(1);
  });
