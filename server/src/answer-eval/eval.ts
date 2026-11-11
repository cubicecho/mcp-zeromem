import { AgentLoopError, askJson, FinishReason, runAgentLoop, ToolIterationLimit } from '@cubicecho/agent-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { relay } from '../curator-agent/agent.ts';
import { endpointOf, type LlmConfig, loopConfig, type ToolSpec, toolSpecs } from '../curator-agent/llm.ts';
import { errorChainMessage } from '../errors.ts';

/**
 * The end-to-end check the retrieval metrics cannot make: a model that has
 * only the memory tools is asked the harness's labeled questions, and a judge
 * compares what it said with the turns the labels name.
 *
 * recall@k says the right turn was returned. This says a model found it,
 * read it and answered with it, which is what a user of the memory sees. The
 * judge is a model too, so the number is recorded, never gated.
 */

export const ASKS = ['current', 'history', 'as_of', 'abstain'] as const;
export type Ask = (typeof ASKS)[number];

/** A line of the harness's `queries.jsonl` or `probes.jsonl`. */
export const questionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  query: z.string(),
  relevant: z.array(z.object({ uuid: z.string(), grade: z.number() })),
  ask: z.enum(ASKS).default('current'),
});
export type Question = z.infer<typeof questionSchema>;

/** `error`: the model or the judge did not answer, which says nothing about the memory. */
export type Verdict = 'correct' | 'wrong' | 'abstained' | 'unjudged' | 'error';

export interface Answered {
  /** The model's reply; empty when it ran out of steps or was cut off. */
  answer: string;
  /** It hit the reply cap before answering: it was still thinking, which is not the same as being wrong. */
  cut_off: boolean;
  steps: number;
  tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface QuestionResult extends Answered {
  id: string;
  ask: Ask;
  kind: string;
  question: string;
  verdict: Verdict;
  /** `correct` for a question with an answer, `abstained` for one without. */
  right: boolean;
}

export interface AskSummary {
  questions: number;
  right: number;
  wrong: number;
  abstained: number;
  unjudged: number;
  errors: number;
  /** Of the wrong ones, how many never got as far as an answer. */
  cut_off: number;
  /** right / questions that were answered and graded; an error is left out. */
  accuracy: number;
  tool_calls_mean: number;
  /** Prompt tokens over every request the answer took: what it costs to answer from memory. */
  prompt_tokens_mean: number;
}

/** The tools an agent using the memory has; nothing that writes, nothing of the curator's. */
const MEMORY_TOOLS = new Set(['zeromem_recall', 'zeromem_read_session']);

const DONT_KNOW = "I don't know.";

export async function memoryTools(client: Client): Promise<ToolSpec[]> {
  const tools = await toolSpecs(client, (name) => MEMORY_TOOLS.has(name));
  if (!tools.some((tool) => tool.function.name === 'zeromem_recall')) {
    throw new Error('the server did not list zeromem_recall');
  }
  return tools;
}

export interface AnswerOptions {
  client: Client;
  llm: LlmConfig;
  tools: readonly ToolSpec[];
  question: string;
  /** When the conversations in the store end, so "now" and "last month" mean something. */
  now: Date;
  maxSteps?: number;
  maxToolChars?: number;
}

/** Ask one question of a model whose only source is the memory. */
export async function answerQuestion(options: AnswerOptions): Promise<Answered> {
  const { client, llm, tools, question } = options;
  const maxSteps = options.maxSteps ?? 6;
  const maxToolChars = options.maxToolChars ?? 12_000;
  const system = [
    'You answer questions about past conversations. You remember nothing of them yourself:',
    'everything you know about them comes from the memory tools, so search before you answer.',
    `The conversations end on ${options.now.toISOString().slice(0, 10)}.`,
    'Answer in one sentence with the specific value asked for.',
    `If the memory does not hold the answer, reply exactly: ${DONT_KNOW}`,
  ].join(' ');
  const out: Answered = { answer: '', cut_off: false, steps: 0, tool_calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  try {
    const result = await runAgentLoop({
      config: loopConfig(llm, maxSteps),
      system,
      messages: [{ role: 'user', content: question }],
      tools: [...tools],
      dispatch: (call) => relay(client, call, tools, maxToolChars),
      onTurn: () => {
        out.steps += 1;
      },
      onToolCall: () => {
        out.tool_calls += 1;
      },
    });
    out.prompt_tokens = result.usage.prompt;
    out.completion_tokens = result.usage.completion;
    out.answer = result.turn.content;
    out.cut_off = result.turn.finishReason === FinishReason.Length && out.answer === '';
  } catch (err) {
    // A model that never stopped searching has no answer, which is graded wrong rather than lost.
    if (!(err instanceof ToolIterationLimit)) {
      throw new Error(`model at ${llm.url} failed: ${errorChainMessage(err)}`, { cause: err });
    }
    if (err instanceof AgentLoopError) {
      out.prompt_tokens = err.usage.prompt;
      out.completion_tokens = err.usage.completion;
    }
  }
  return out;
}

const JUDGE = [
  'You grade an answer to a question about past conversations.',
  'You are given the question, the reference statements that hold the right answer, and the answer to grade.',
  'Give one verdict:',
  'CORRECT if the answer gives the value the reference statements give for what the question asks.',
  'Extra detail is fine; a different value, or several values without choosing the right one, is not.',
  'ABSTAINED if the answer says it does not know or that the memory does not hold it.',
  'WRONG otherwise.',
].join(' ');

const VERDICTS = { CORRECT: 'correct', WRONG: 'wrong', ABSTAINED: 'abstained' } as const;

/** The judge answers with one of the three words and nothing else, held to it by the server's grammar. */
const VERDICT_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: Object.keys(VERDICTS) } },
  required: ['verdict'],
  additionalProperties: false,
};

/**
 * Grade one answer against the turns the labels name. An empty answer is
 * wrong without asking: the model never replied.
 *
 * A side task, so it is not streamed and the no-thinking hints go with it: the
 * reply is a dozen tokens, well inside the five minutes Node's fetch waits for
 * response headers, which a streamed turn does not have to fit in.
 */
export async function judgeAnswer(
  llm: LlmConfig,
  question: string,
  references: readonly string[],
  answer: string,
): Promise<Verdict> {
  if (answer.trim() === '') {
    return 'wrong';
  }
  const reference =
    references.length > 0
      ? references.map((text) => `- ${text}`).join('\n')
      : '(none: the conversations never state this, so the right answer is to say so)';
  const reply = await askJson<{ verdict?: unknown }>(
    endpointOf(llm),
    llm.model,
    JUDGE,
    `Question: ${question}\n\nReference statements:\n${reference}\n\nAnswer: ${answer}`,
    VERDICT_SCHEMA,
    { name: 'verdict', temperature: 0, ...(llm.maxTokens === undefined ? {} : { maxTokens: llm.maxTokens }) },
  );
  const word = typeof reply?.verdict === 'string' ? reply.verdict.toUpperCase() : '';
  return Object.hasOwn(VERDICTS, word) ? VERDICTS[word as keyof typeof VERDICTS] : 'unjudged';
}

/** A question with no labeled turn has no answer in the store: declining is the right reply. */
export function isRight(question: Question, verdict: Verdict): boolean {
  return question.relevant.length === 0 ? verdict === 'abstained' : verdict === 'correct';
}

/**
 * The statements an answer is graded against: the grade-2 turns, or every
 * labeled turn when a corpus marks none that high (an imported one labeled by
 * session).
 */
export function references(question: Question, textOf: ReadonlyMap<string, string>): string[] {
  const top = question.relevant.filter((r) => r.grade >= 2);
  const chosen = top.length > 0 ? top : question.relevant;
  return chosen.flatMap((r) => textOf.get(r.uuid) ?? []);
}

export function summarise(results: readonly QuestionResult[]): Partial<Record<Ask | 'all', AskSummary>> {
  const out: Partial<Record<Ask | 'all', AskSummary>> = {};
  const groups: Array<[Ask | 'all', readonly QuestionResult[]]> = [
    ['all', results],
    ...ASKS.map((ask): [Ask, QuestionResult[]] => [ask, results.filter((r) => r.ask === ask)]),
  ];
  for (const [name, group] of groups) {
    if (group.length === 0) {
      continue;
    }
    const count = (verdict: Verdict) => group.filter((r) => r.verdict === verdict).length;
    const right = group.filter((r) => r.right).length;
    out[name] = {
      questions: group.length,
      right,
      wrong: count('wrong'),
      abstained: count('abstained'),
      unjudged: count('unjudged'),
      errors: count('error'),
      cut_off: group.filter((r) => r.cut_off).length,
      accuracy: group.length === count('error') ? 0 : right / (group.length - count('error')),
      tool_calls_mean: mean(group.map((r) => r.tool_calls)),
      prompt_tokens_mean: mean(group.map((r) => r.prompt_tokens)),
    };
  }
  return out;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** `limit` questions spread evenly over the list, so a sample covers every kind the file holds. */
export function sample<T>(items: readonly T[], limit: number | null): T[] {
  if (limit === null || limit >= items.length) {
    return [...items];
  }
  return Array.from({ length: limit }, (_, i) => items[Math.floor((i * items.length) / limit)] as T);
}

export interface EvalOptions {
  client: Client;
  llm: LlmConfig;
  /** The grader; the model under test grades itself unless another is named. */
  judge: LlmConfig;
  questions: readonly Question[];
  textOf: ReadonlyMap<string, string>;
  now: Date;
  maxSteps?: number;
  log?: (line: string) => void;
}

export async function runAnswerEval(options: EvalOptions): Promise<QuestionResult[]> {
  const { client, llm, judge, textOf } = options;
  const log = options.log ?? (() => {});
  const tools = await memoryTools(client);
  const results: QuestionResult[] = [];
  for (const question of options.questions) {
    let answered: Answered = {
      answer: '',
      cut_off: false,
      steps: 0,
      tool_calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
    };
    let verdict: Verdict;
    try {
      answered = await answerQuestion({
        client,
        llm,
        tools,
        question: question.query,
        now: options.now,
        maxSteps: options.maxSteps,
      });
      verdict = await judgeAnswer(judge, question.query, references(question, textOf), answered.answer);
    } catch (err) {
      // One request that timed out must not cost the answers already paid for.
      log(`     ${question.id}: ${errorChainMessage(err)}`);
      verdict = 'error';
    }
    const result: QuestionResult = {
      id: question.id,
      ask: question.ask,
      kind: question.kind,
      question: question.query,
      ...answered,
      verdict,
      right: isRight(question, verdict),
    };
    results.push(result);
    log(
      `${result.right ? 'ok  ' : 'MISS'} ${question.id} [${question.ask}] ${verdict}: ${answered.cut_off ? '(cut off before answering)' : oneLine(answered.answer)}`,
    );
  }
  return results;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}
