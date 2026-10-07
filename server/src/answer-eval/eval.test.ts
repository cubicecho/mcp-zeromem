import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayServer } from '../gateway/server.ts';
import { scriptedModel, tempEngine, testConfig } from '../test-support.ts';
import { isRight, judgeAnswer, type Question, references, runAnswerEval, sample, summarise } from './eval.ts';

let rig: ReturnType<typeof tempEngine>;
let model: Awaited<ReturnType<typeof scriptedModel>> | null = null;

const OWNER: Question = {
  id: 'q1',
  kind: 'owner',
  query: 'Who owns the edge cache on Basalt?',
  relevant: [
    { uuid: 'u1', grade: 1 },
    { uuid: 'u2', grade: 2 },
  ],
  ask: 'current',
};
const NOBODY: Question = { id: 'p1', kind: 'location', query: 'Where is Yuki based?', relevant: [], ask: 'abstain' };
const TEXT = new Map([
  ['u1', 'Kenji Morimoto owns the edge cache on Basalt.'],
  ['u2', 'Ana Souza took over the edge cache on Basalt.'],
]);
const NOW = new Date('2026-03-01T00:00:00Z');

beforeEach(async () => {
  rig = tempEngine();
  await rig.engine.ingestMany([
    { session_id: 'a', speaker: 'user', text: TEXT.get('u1') ?? '', ts: 1000, uuid: 'u1' },
    { session_id: 'b', speaker: 'user', text: TEXT.get('u2') ?? '', ts: 2000, uuid: 'u2' },
  ]);
});

afterEach(async () => {
  await model?.close();
  model = null;
  rig.cleanup();
});

async function reader(): Promise<Client> {
  const config = testConfig({ dataDir: rig.home, readOnly: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createGatewayServer({ engine: rig.engine, config, curator: false }).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

describe('runAnswerEval', () => {
  it('lets the model search the memory, then grades what it said against the labeled turns', async () => {
    model = await scriptedModel([
      { calls: [{ name: 'zeromem_recall', arguments: JSON.stringify({ query: 'edge cache owner Basalt' }) }] },
      { content: 'Ana Souza owns it.' },
      { content: 'CORRECT' },
      { content: "I don't know." },
      { content: 'The answer declines.\nABSTAINED' },
    ]);
    const client = await reader();
    const results = await runAnswerEval({
      client,
      llm: model.llm,
      judge: model.llm,
      questions: [OWNER, NOBODY],
      textOf: TEXT,
      now: NOW,
    });
    await client.close();

    expect(results.map((r) => [r.id, r.verdict, r.right, r.tool_calls, r.steps])).toEqual([
      ['q1', 'correct', true, 1, 2],
      ['p1', 'abstained', true, 0, 1],
    ]);
    expect(results[0]?.prompt_tokens).toBe(20);

    // The model under test sees only the two memory reads, and is told when the conversations end.
    const first = model.requests[0];
    expect(first?.tools?.map((t) => t.function.name).sort()).toEqual(['zeromem_read_session', 'zeromem_recall']);
    expect(first?.messages[0]?.content).toContain('2026-03-01');
    // What it read back is the store's own answer.
    const toolResult = model.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toContain('Ana Souza took over');

    // The judge has no tools and is shown the grade-2 turn, not the superseded one.
    const judged = model.requests[2];
    expect(judged?.tools).toBeUndefined();
    expect(judged?.messages[1]?.content).toContain('Ana Souza took over');
    expect(judged?.messages[1]?.content).not.toContain('Kenji');
    expect(model.requests[4]?.messages[1]?.content).toContain('(none:');
  });

  it('counts a model that never stops searching as wrong, without asking the judge', async () => {
    const search = { calls: [{ name: 'zeromem_recall', arguments: JSON.stringify({ query: 'edge cache' }) }] };
    model = await scriptedModel([search, search]);
    const client = await reader();
    const results = await runAnswerEval({
      client,
      llm: model.llm,
      judge: model.llm,
      questions: [OWNER],
      textOf: TEXT,
      now: NOW,
      maxSteps: 2,
    });
    await client.close();
    expect(results[0]).toMatchObject({ answer: '', verdict: 'wrong', right: false, steps: 2, tool_calls: 2 });
    expect(model.requests).toHaveLength(2);
  });

  it('tells an answer cut off at the reply cap from a wrong one', async () => {
    model = await scriptedModel([{ content: '', finish: 'length' }]);
    const client = await reader();
    const results = await runAnswerEval({
      client,
      llm: model.llm,
      judge: model.llm,
      questions: [OWNER],
      textOf: TEXT,
      now: NOW,
    });
    await client.close();
    expect(results[0]).toMatchObject({ answer: '', cut_off: true, verdict: 'wrong', right: false });
    expect(summarise(results).all).toMatchObject({ wrong: 1, cut_off: 1 });
  });

  it('records a question the model failed on as an error and carries on', async () => {
    // The script runs out after the first question: the second request is a 500.
    model = await scriptedModel([{ content: 'Ana Souza owns it.' }, { content: 'CORRECT' }]);
    const client = await reader();
    const results = await runAnswerEval({
      client,
      llm: model.llm,
      judge: model.llm,
      questions: [OWNER, NOBODY],
      textOf: TEXT,
      now: NOW,
    });
    await client.close();
    expect(results.map((r) => r.verdict)).toEqual(['correct', 'error']);
    expect(summarise(results).all).toMatchObject({ questions: 2, right: 1, errors: 1, accuracy: 1 });
  });
});

describe('judging', () => {
  it('reads the last verdict word, and reports a reply with none as unjudged', async () => {
    model = await scriptedModel([{ content: 'Not CORRECT: it names Kenji. WRONG' }, { content: 'hard to say' }]);
    expect(await judgeAnswer(model.llm, OWNER.query, ['x'], 'Kenji')).toBe('wrong');
    expect(await judgeAnswer(model.llm, OWNER.query, ['x'], 'Kenji')).toBe('unjudged');
  });

  it('holds an unanswerable question right only when the model declined', () => {
    expect(isRight(NOBODY, 'abstained')).toBe(true);
    expect(isRight(NOBODY, 'correct')).toBe(false);
    expect(isRight(OWNER, 'correct')).toBe(true);
    expect(isRight(OWNER, 'abstained')).toBe(false);
  });

  it('falls back to every labeled turn when none is graded 2', () => {
    const bySession: Question = { ...OWNER, relevant: [{ uuid: 'u1', grade: 1 }] };
    expect(references(bySession, TEXT)).toEqual([TEXT.get('u1')]);
    expect(references(OWNER, TEXT)).toEqual([TEXT.get('u2')]);
  });
});

describe('reporting', () => {
  it('summarises per ask and overall, leaving out an ask nobody was asked', () => {
    const base = { kind: 'k', question: 'q', answer: 'a', cut_off: false, steps: 2, completion_tokens: 1 };
    const summary = summarise([
      { ...base, id: '1', ask: 'current', verdict: 'correct', right: true, tool_calls: 1, prompt_tokens: 100 },
      { ...base, id: '2', ask: 'current', verdict: 'wrong', right: false, tool_calls: 3, prompt_tokens: 300 },
      { ...base, id: '3', ask: 'abstain', verdict: 'correct', right: false, tool_calls: 2, prompt_tokens: 200 },
    ]);
    expect(summary.current).toMatchObject({ questions: 2, right: 1, wrong: 1, accuracy: 0.5, tool_calls_mean: 2 });
    expect(summary.abstain).toMatchObject({ questions: 1, right: 0, accuracy: 0 });
    expect(summary.all).toMatchObject({ questions: 3, right: 1, prompt_tokens_mean: 200 });
    expect(summary.history).toBeUndefined();
  });

  it('samples evenly across the list', () => {
    expect(sample([1, 2, 3, 4, 5, 6], 3)).toEqual([1, 3, 5]);
    expect(sample([1, 2], 5)).toEqual([1, 2]);
    expect(sample([1, 2], null)).toEqual([1, 2]);
  });
});
