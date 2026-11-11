import {
  AgentLoopError,
  type AgentLoopOptions,
  contextLimitFor,
  runAgentLoop,
  type ToolCallRequest,
  ToolIterationLimit,
} from '@cubicecho/agent-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type OpenAI from 'openai';
import { errorChainMessage } from '../errors.ts';
import { type LlmConfig, loopConfig, type ToolSpec, toolSpecs } from './llm.ts';

/**
 * A curation run driven by a local model.
 *
 * The server runs no agent and still does not: this is an MCP client like any
 * other curator. It fetches one of the curator prompts, hands it to an
 * OpenAI-compatible model as its task, and relays the model's tool calls to the
 * `zeromem_curate_*` tools until the model stops calling them. Every rule the
 * model follows is in the prompt the server serves; nothing here knows what a
 * duplicate is. The loop itself is agent-core's `runAgentLoop`.
 */

export interface AgentOptions {
  /** A connected client whose listing includes the curator tools. */
  client: Client;
  llm: LlmConfig;
  prompt: { name: string; args?: Record<string, string> };
  /** Model requests at most; a run that needs more is reported as unfinished. */
  maxSteps?: number;
  /** Longest tool result handed to the model, in characters, before it is cut and marked. */
  maxToolChars?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface AgentReport {
  /** The model's closing reply. */
  summary: string;
  /** The model stopped calling tools on its own, inside `maxSteps`. */
  finished: boolean;
  /** A `run_end` was applied, so the next run starts where this one ended. */
  closed: boolean;
  steps: number;
  tool_calls: Record<string, number>;
  tool_errors: number;
  prompt_tokens: number;
  completion_tokens: number;
}

const DEFAULTS = { maxSteps: 40, maxToolChars: 12_000 };

/** What a curator may call: its own tools, plus the two reads the playbook sends it to. */
const ALSO_SERVED = new Set(['zeromem_read_session', 'zeromem_recall']);
const APPLY = 'zeromem_curate_apply';

const NOT_CLOSED = [
  'The run is not closed. Call zeromem_curate_apply with the same run_id and',
  'actions: [{"op": "run_end", "summary": "..."}], then reply with the summary.',
].join(' ');

type Message = OpenAI.ChatCompletionMessageParam;

export async function runCurator(options: AgentOptions): Promise<AgentReport> {
  const { client, llm, prompt } = options;
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;
  const maxToolChars = options.maxToolChars ?? DEFAULTS.maxToolChars;
  const log = options.log ?? (() => {});
  const now = (options.now ?? (() => new Date()))();

  const tools = await toolSpecs(client, (name) => name.startsWith('zeromem_curate_') || ALSO_SERVED.has(name));
  if (!tools.some((tool) => tool.function.name.startsWith('zeromem_curate_'))) {
    throw new Error(
      'the server did not list the curator tools: connect with the curator token, or turn on "expose to every client"',
    );
  }
  const canApply = tools.some((tool) => tool.function.name === APPLY);

  const served = await client.getPrompt({ name: prompt.name, arguments: prompt.args ?? {} });
  const task = served.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n\n');

  const system = [
    'You are the curator of a zeromem memory store. The user message is your procedure: follow it with the tools.',
    `The time is ${now.toISOString()} (UTC).`,
    'Act by calling tools, not by describing calls. Turn ids are numbers taken from tool results; never invent one.',
    'When the procedure is complete, stop calling tools and reply with your summary.',
  ].join(' ');

  const report: AgentReport = {
    summary: '',
    finished: false,
    closed: false,
    steps: 0,
    tool_calls: {},
    tool_errors: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
  };
  const config = loopConfig(llm, maxSteps);
  const contextLength = (await contextLimitFor(config)) || undefined;
  const asked = new Map<string, Record<string, unknown>>();
  const loop = (messages: Message[]): Promise<Awaited<ReturnType<typeof runAgentLoop>>> =>
    runAgentLoop({
      config: { ...config, maxToolIterations: maxSteps - report.steps, contextLength },
      system,
      messages,
      tools,
      dispatch: (call) => relay(client, call, tools, maxToolChars),
      // Past three quarters of a window the endpoint reports, the oldest tool results are stubbed;
      // the calls that produced them stay, so the model can ask again.
      prune: true,
      // An apply sent twice is two applies, and the model meant both or neither; either way the
      // server's answer is the one to read.
      dedupeToolCalls: false,
      onTurn: () => {
        report.steps += 1;
      },
      onToolCall: (call) => {
        report.tool_calls[call.name] = (report.tool_calls[call.name] ?? 0) + 1;
        asked.set(call.id, call.args);
      },
      onToolResult: (result) => {
        const args = asked.get(result.id) ?? {};
        asked.delete(result.id);
        if (!result.ok) {
          report.tool_errors += 1;
        } else if (result.name === APPLY && closesRun(args)) {
          report.closed = true;
        }
        log(`${result.name} ${summarise(args)}${result.ok ? '' : ` → ${result.content.slice(0, 200)}`}`);
      },
    } satisfies AgentLoopOptions);

  let messages: Message[] = [{ role: 'user', content: task }];
  let nudged = false;
  try {
    for (;;) {
      const result = await loop(messages);
      report.prompt_tokens += result.usage.prompt;
      report.completion_tokens += result.usage.completion;
      report.summary = result.turn.content;
      // A run left open makes the next one start from the same cursor; ask once.
      if (canApply && !report.closed && !nudged) {
        nudged = true;
        log('model stopped without closing the run; asking it to');
        if (report.steps >= maxSteps) {
          break;
        }
        messages = [...result.messages, { role: 'user', content: NOT_CLOSED }];
        continue;
      }
      report.finished = true;
      break;
    }
  } catch (err) {
    if (err instanceof AgentLoopError) {
      report.prompt_tokens += err.usage.prompt;
      report.completion_tokens += err.usage.completion;
    }
    if (!(err instanceof ToolIterationLimit)) {
      throw new Error(`model at ${llm.url} failed: ${errorChainMessage(err)}`, { cause: err });
    }
  }

  if (!report.finished) {
    log(`stopped after ${report.steps} model requests without a closing reply`);
  }
  return report;
}

/**
 * Run one tool call over MCP and return what the model reads. A failure is
 * thrown, which agent-core hands the model as `Error: …` so it can correct
 * itself; a long result or error is clipped either way.
 */
export async function relay(
  client: Client,
  call: ToolCallRequest,
  tools: readonly ToolSpec[],
  maxToolChars: number,
): Promise<string> {
  // A tool outside the listing never reaches the server, whatever the model remembers.
  if (!tools.some((tool) => tool.function.name === call.name)) {
    throw new Error(`There is no tool named ${call.name}.`);
  }
  let text: string;
  let isError: boolean;
  try {
    const result = await client.callTool({ name: call.name, arguments: call.args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    text = content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n');
    isError = result.isError === true;
  } catch (err) {
    // The SDK throws on arguments the tool's schema rejects.
    text = errorChainMessage(err);
    isError = true;
  }
  const clipped = clip(text, maxToolChars);
  if (isError) {
    throw new Error(clipped);
  }
  return clipped;
}

function closesRun(args: Record<string, unknown>): boolean {
  if (args.dry_run === true || !Array.isArray(args.actions)) {
    return false;
  }
  return args.actions.some((action) => (action as { op?: unknown } | null)?.op === 'run_end');
}

/** The call in one log line: which ops for an apply, the arguments otherwise. */
function summarise(args: Record<string, unknown>): string {
  if (Array.isArray(args.actions)) {
    const ops = args.actions.map((action) => String((action as { op?: unknown } | null)?.op ?? '?'));
    return `${args.dry_run === true ? 'dry run ' : ''}[${ops.join(', ')}]`;
  }
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Cut a long result and say so, with what to do about it: an unmarked cut reads
 * as "that is everything", and the model curates half a page as if it were whole.
 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… [clipped: ${limit} of ${text.length} characters — ask for less at a time: a smaller limit, fewer turn_ids]`;
}
